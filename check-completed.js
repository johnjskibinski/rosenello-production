const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, completed_at, lp_status')
    .in('contract_id', ['11809-PDED', '11477-W'])

  console.table(data)
}
main()
