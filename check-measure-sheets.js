const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: jobs, count } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, measure_sheet_url', { count: 'exact' })
    .not('measure_sheet_url', 'is', null)

  console.log(`\nJobs with measure sheets: ${count}`)

  // Check which ones have estimated costs already
  const jobIds = jobs.map(j => j.lp_job_id)
  const { data: estimated } = await supabase
    .from('job_costs')
    .select('lp_job_id')
    .eq('cost_type', 'estimated')
    .in('lp_job_id', jobIds)

  const hasEstimated = new Set(estimated.map(e => e.lp_job_id))
  const missing = jobs.filter(j => !hasEstimated.has(j.lp_job_id))

  console.log(`Already have estimated costs: ${hasEstimated.size}`)
  console.log(`Missing estimated costs:      ${missing.length}`)
}
main()
