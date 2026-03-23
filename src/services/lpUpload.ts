// Ported and adapted from legacy Apps Script app (Uploads.gs)
import { getLPToken } from '../lib/lpClient'
import { supabase } from '../lib/supabase'
import { exportTabAsPdf, readProjectTotals, readWorkOrderRows } from '../lib/googleSheetsPdf'

const LP_BASE_URL = 'https://api.leadperfection.com'

const DOC_TYPES = [
  { tabName: 'Costing',        docTypeId: 36, landscape: true,  displayName: 'Costing'       },
  { tabName: 'Window Measure', docTypeId: 16, landscape: true,  displayName: 'Window Measure' },
  { tabName: 'Work Order',     docTypeId: 26, landscape: false, displayName: 'Work Order'     },
  { tabName: 'Checklist',      docTypeId: 37, landscape: false, displayName: 'Checklist'      },
  { tabName: 'LaborCalc',      docTypeId: 35, landscape: false, displayName: 'Labor Calc'     },
]

async function lpPostJson(path: string, body: any) {
  const token = await getLPToken()
  const response = await fetch(`${LP_BASE_URL}/api/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

// tabName is optional — if provided, only that tab is uploaded
export async function uploadJobDocs(lpJobId: number, tabName?: string) {
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

  // Filter to single tab if specified
  const docsToUpload = tabName
    ? DOC_TYPES.filter(d => d.tabName === tabName)
    : DOC_TYPES

  if (tabName && docsToUpload.length === 0)
    throw new Error(`Unknown tab: ${tabName}. Valid tabs: ${DOC_TYPES.map(d => d.tabName).join(', ')}`)

  const results: { tabName: string; ok: boolean; message?: string }[] = []

  for (const doc of docsToUpload) {
    try {
      console.log(`[Upload] Exporting "${doc.tabName}" for job ${lpJobId}...`)
      const pdfBuffer = await exportTabAsPdf(spreadsheetId, doc.tabName, doc.landscape)
      const uints = Array.from(pdfBuffer).map(b => (b < 0 ? b + 256 : b))
      const filename = `${customerName} - ${doc.tabName}.pdf`

      await lpPostJson('SalesApi/AddJobImages', {
        jobid:     lpJobId,
        filename:  filename,
        docdescr:  doc.displayName,
        dtyid:     doc.docTypeId,
        filebytes: uints,
      })

      console.log(`[Upload] ✓ ${doc.tabName} uploaded for job ${lpJobId}`)
      results.push({ tabName: doc.tabName, ok: true })
    } catch (err: any) {
      console.error(`[Upload] ✗ ${doc.tabName} failed for job ${lpJobId}:`, err.message)
      results.push({ tabName: doc.tabName, ok: false, message: err.message })
    }
  }

  // Only read totals + work order rows on full upload or first time
  let totals = {
    total_windows: 0, total_doors: 0, bay_windows: 0,
    bow_windows: 0, total_openings: 0, total_units: 0,
  }
  let workOrderRows: any[][] = []

  if (!tabName) {
    try { totals = await readProjectTotals(spreadsheetId) } catch (e: any) {
      console.error(`[Upload] Failed to read project totals:`, e.message)
    }
    try { workOrderRows = await readWorkOrderRows(spreadsheetId) } catch (e: any) {
      console.error(`[Upload] Failed to read work order rows:`, e.message)
    }
  }

  const anyOk = results.some(r => r.ok)
  const updatePayload: any = { last_synced_at: new Date().toISOString() }
  if (anyOk) updatePayload.docs_uploaded_at = new Date().toISOString()
  if (!tabName) {
    Object.assign(updatePayload, totals)
    updatePayload.work_order_rows = workOrderRows
  }

  await supabase.from('jobs').update(updatePayload).eq('lp_job_id', lpJobId)

  return {
    ok: results.every(r => r.ok),
    results,
    ...(tabName ? {} : { totals, workOrderRowCount: workOrderRows.length }),
  }
}
