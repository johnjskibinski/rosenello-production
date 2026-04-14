const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const RAILWAY = 'https://rosenello-production-production.up.railway.app'

async function main() {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, measure_sheet_url')
    .not('measure_sheet_url', 'is', null)

  const { data: estimated } = await supabase
    .from('job_costs')
    .select('lp_job_id')
    .eq('cost_type', 'estimated')

  const hasEstimated = new Set(estimated.map(e => e.lp_job_id))
  const missing = jobs.filter(j => !hasEstimated.has(j.lp_job_id))

  console.log(`\nBackfilling estimated costs for ${missing.length} jobs...\n`)

  let ok = 0, failed = 0

  for (const job of missing) {
    try {
      const res = await fetch(`${RAILWAY}/api/jobs/${job.lp_job_id}/upload-docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      const data = await res.json()
      if (data.ok || data.results) {
        console.log(`  ✓ ${job.customer_first} ${job.customer_last} (${job.contract_id})`)
        ok++
      } else {
        console.log(`  ✗ ${job.customer_first} ${job.customer_last} (${job.contract_id}): ${JSON.stringify(data).slice(0, 80)}`)
        failed++
      }
    } catch (err) {
      console.log(`  ✗ ${job.customer_first} ${job.customer_last}: ${err.message}`)
      failed++
    }
    // Small delay to avoid hammering Google Sheets API
    await new Promise(r => setTimeout(r, 1500))
  }

  console.log(`\n=== DONE ===`)
  console.log(`Success: ${ok}`)
  console.log(`Failed:  ${failed}`)
}
main()
