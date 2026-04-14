const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, completed_at')
    .ilike('customer_last', 'reid')

  console.log('\nMatching jobs:')
  console.table(jobs)

  for (const job of jobs) {
    const { data: costs } = await supabase
      .from('job_costs')
      .select('cost_type, mat_type, total_cost, source')
      .eq('lp_job_id', job.lp_job_id)

    console.log(`\nCosts for ${job.customer_first} ${job.customer_last} (${job.contract_id}):`)
    console.table(costs)
  }
}
main()
