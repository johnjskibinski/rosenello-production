import { lpPost } from '../lib/lpClient'
import { supabase } from '../lib/supabase'
import { createMeasureSheet } from '../lib/googleSheets'
import { resolveCompanyCamProject } from './companyCam'

const ACTIVE_STATUSES = ['SN','PU','SS','MR','D','B','1','2','3','NS','SV','S','5','T','SI','CM','U']
const MEASURE_SHEET_STATUSES = ['SN', 'PU', 'SS']

function mapJob(raw: any) {
  return {
    lp_job_id: parseInt(raw.job_id || raw.jobid),
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

        const jobs = result
        if (!jobs) { hasMore = false; break }

        const jobArray = Array.isArray(jobs) ? jobs : [jobs]
        if (jobArray.length === 0) { hasMore = false; break }

        // Filter out any records without a valid job ID
        const mapped = jobArray.map(mapJob).filter(j => !isNaN(j.lp_job_id) && j.lp_job_id > 0)
        if (mapped.length === 0) { hasMore = false; break }

        console.log(`[Sync] Status ${status} page ${page}: ${mapped.length} jobs`)

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

  // Async CC resolution — non-blocking, runs after main sync
  supabase
    .from('jobs')
    .select('lp_job_id, customer_first, customer_last, address, city, state, zip, contract_date')
    .is('companycam_project_id', null)
    .is('companycam_checked_at', null)
    .then(({ data: jobsNeedingCC }) => {
      if (!jobsNeedingCC || !jobsNeedingCC.length) return
      console.log('[CC] Resolving ' + jobsNeedingCC.length + ' jobs')
      Promise.allSettled(jobsNeedingCC.map(job => resolveCompanyCamProject(job)))
        .then(results => {
          const resolved = results.filter(r => r.status === 'fulfilled' && r.value).length
          console.log('[CC] Resolved ' + resolved + '/' + jobsNeedingCC.length + ' projects')
        })
    })

  return { totalSynced, totalErrors, sheetsCreated }
}
