const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, gross_amount')
    .eq('contract_id', '11504-W')

  console.log('\nJobs with contract_id 11504-W:')
  console.table(jobs)

  const jobIds = jobs.map(j => j.lp_job_id)
  const { data: costs } = await supabase
    .from('job_costs')
    .select('lp_job_id, mat_type, total_cost, source')
    .in('lp_job_id', jobIds)
    .eq('cost_type', 'actual')

  console.log('\nAll actual cost rows for these jobs:')
  console.table(costs)
}
main()
