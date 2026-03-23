// Ported and adapted from legacy Apps Script app (Uploads.gs)
import { getLPToken } from '../lib/lpClient'
import { supabase } from '../lib/supabase'
import { exportTabAsPdf, readProjectTotals, readWorkOrderRows } from '../lib/googleSheetsPdf'

const LP_BASE_URL = 'https://api.leadperfection.com'

// Doc type IDs and tab config from project spec
const DOC_TYPES = [
  { tabName: 'Costing',         docTypeId: 36, landscape: true,  displayName: 'Costing'        },
  { tabName: 'Window Measure',  docTypeId: 16, landscape: true,  displayName: 'Window Measure'  },
  { tabName: 'Work Order',      docTypeId: 26, landscape: false, displayName: 'Work Order'      },
  { tabName: 'Checklist',       docTypeId: 37, landscape: false, displayName: 'Checklist'       },
  { tabName: 'LaborCalc',       docTypeId: 35, landscape: false, displayName: 'Labor Calc'      },
]

async function lpPostJson(path: string, body: any) {
  const token = await getLPToken()
  const response = await fetch(`${LP_BASE_URL}/api/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LP API failed ${path} (HTTP ${response.status}): ${text}`)
  }
  return response.json()
}

function spreadsheetIdFromUrl(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return m ? m[1] : null
}

export async function uploadJobDocs(lpJobId: number) {
  // 1. Fetch job from DB
  const { data: job, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('lp_job_id', lpJobId)
    .single()

  if (error || !job) throw new Error(`Job not found: ${lpJobId}`)
  if (!job.measure_sheet_url) throw new Error(`No measure sheet URL for job ${lpJobId}`)

  const spreadsheetId = spreadsheetIdFromUrl(job.measure_sheet_url)
  if (!spreadsheetId) throw new Error(`Invalid measure sheet URL: ${job.measure_sheet_url}`)

  const customerName = `${job.customer_first} ${job.customer_last}`.trim()

  // 2. Upload all 5 tabs as PDFs to LP
  const results: { tabName: string; ok: boolean; message?: string }[] = []

  for (const doc of DOC_TYPES) {
    try {
      console.log(`[Upload] Exporting "${doc.tabName}" for job ${lpJobId}...`)
      const pdfBuffer = await exportTabAsPdf(spreadsheetId, doc.tabName, doc.landscape)

      // Convert to unsigned byte array (ported from legacy app)
      const uints = Array.from(pdfBuffer).map(b => (b < 0 ? b + 256 : b))

      const filename = `${customerName} - ${doc.tabName}.pdf`

      await lpPostJson('SalesApi/AddJobImages', {
        jobid:    lpJobId,
        filename: filename,
        docdescr: doc.displayName,
        dtyid:    doc.docTypeId,
        filebytes: uints,
      })

      console.log(`[Upload] ✓ ${doc.tabName} uploaded for job ${lpJobId}`)
      results.push({ tabName: doc.tabName, ok: true })
    } catch (err: any) {
      console.error(`[Upload] ✗ ${doc.tabName} failed for job ${lpJobId}:`, err.message)
      results.push({ tabName: doc.tabName, ok: false, message: err.message })
    }
  }

  // 3. Read Project Totals (O5:O10) from sheet
  let totals = {
    total_windows: 0, total_doors: 0, bay_windows: 0,
    bow_windows: 0, total_openings: 0, total_units: 0,
  }
  try {
    totals = await readProjectTotals(spreadsheetId)
    console.log(`[Upload] Project totals for job ${lpJobId}:`, totals)
  } catch (err: any) {
    console.error(`[Upload] Failed to read project totals:`, err.message)
  }

  // 4. Read Work Order rows 16–25
  let workOrderRows: any[][] = []
  try {
    workOrderRows = await readWorkOrderRows(spreadsheetId)
    console.log(`[Upload] Work order rows read: ${workOrderRows.length} rows`)
  } catch (err: any) {
    console.error(`[Upload] Failed to read work order rows:`, err.message)
  }

  // 5. Persist everything to DB
  const anyOk = results.some(r => r.ok)
  const { error: updateError } = await supabase
    .from('jobs')
    .update({
      ...totals,
      work_order_rows: workOrderRows,
      ...(anyOk ? { docs_uploaded_at: new Date().toISOString() } : {}),
      last_synced_at: new Date().toISOString(),
    })
    .eq('lp_job_id', lpJobId)

  if (updateError) {
    console.error(`[Upload] DB update failed:`, updateError)
  }

  return {
    ok: results.every(r => r.ok),
    results,
    totals,
    workOrderRowCount: workOrderRows.length,
  }
}
