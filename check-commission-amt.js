const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_last, commission_amt')
    .not('commission_amt', 'is', null)
    .gt('commission_amt', 0)
    .limit(10)

  console.log(`\nJobs with commission_amt populated:`)
  console.table(data)
}
main()
