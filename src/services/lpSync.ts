import { lpPost } from '../lib/lpClient'
import { supabase } from '../lib/supabase'
import { createMeasureSheet } from '../lib/googleSheets'

const ACTIVE_STATUSES = ['SN','PU','SS','MR','D','B','1','2','3','NS','SV','S','5','T','SI','CM','U']
const MEASURE_SHEET_STATUSES = ['SN', 'PU']

function mapJob(raw: any) {
  return {
    lp_job_id: parseInt(raw.jobid),
    customer_first: raw.firstname || '',
    customer_last: raw.lastname || '',
    address: raw.address1 || '',
    city: raw.city || '',
    state: raw.state || '',
    zip: raw.zip || '',
    lp_status: raw.jbs_id || '',
    lp_status_label: raw.jobstatus || '',
    gross_amount: parseFloat(raw.grossamount) || 0,
    balance_due: parseFloat(raw.balancedue) || 0,
    salesperson: raw.salesrepname || '',
    installer_1: raw.installer1 || '',
    installer_2: raw.installer2 || '',
    product: raw.productid || '',
    contract_date: raw.contractdate || null,
    contract_id: raw.contractid || '',
    raw_lp_data: raw,
    last_synced_at: new Date().toISOString(),
  }
}

export async function syncActiveJobs() {
  let totalSynced = 0
  let totalErrors = 0
  let sheetsCreated = 0

  for (const status of ACTIVE_STATUSES) {
    let page = 1
    let hasMore = true

    while (hasMore) {
      try {
        const result = await lpPost('Customers/GetJobStatusChanges', {
          jbs_id: status,
          startdate: '2020-01-01',
          enddate: '2099-12-31',
          PageSize: '250',
          StartIndex: String((page - 1) * 250 + 1),
        })

        const jobs = result?.jobstatuschanges?.job
        if (!jobs) { hasMore = false; break }

        const jobArray = Array.isArray(jobs) ? jobs : [jobs]
        if (jobArray.length === 0) { hasMore = false; break }

        const mapped = jobArray.map(mapJob)

        const { error } = await supabase
          .from('jobs')
          .upsert(mapped, { onConflict: 'lp_job_id' })

        if (error) {
          console.error(`Supabase upsert error for status ${status}:`, error)
          totalErrors += jobArray.length
        } else {
          totalSynced += jobArray.length

          // Create measure sheets for SN and PU jobs only
          if (MEASURE_SHEET_STATUSES.includes(status)) {
            for (const job of mapped) {
              // Skip if sheet already exists in DB
              const { data: existing } = await supabase
                .from('jobs')
                .select('measure_sheet_url')
                .eq('lp_job_id', job.lp_job_id)
                .single()

              if (existing?.measure_sheet_url) {
                console.log(`Sheet already exists for job ${job.lp_job_id}, skipping`)
                continue
              }

              const sheetId = await createMeasureSheet(job)
              if (sheetId) {
                sheetsCreated++
                const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`
                await supabase
                  .from('jobs')
                  .update({ measure_sheet_url: sheetUrl })
                  .eq('lp_job_id', job.lp_job_id)
              }
            }
          }
        }

        hasMore = jobArray.length === 250
        page++
      } catch (err) {
        console.error(`Error syncing status ${status} page ${page}:`, err)
        hasMore = false
        totalErrors++
      }
    }
  }

  return { totalSynced, totalErrors, sheetsCreated }
}
