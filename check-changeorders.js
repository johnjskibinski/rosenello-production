const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data, error } = await supabase
    .from('job_costs')
    .select('lp_job_id, mat_type, total_cost, source, invoice_date')
    .eq('mat_type', 'ChangeOrders')

  if (error) { console.error(error.message); process.exit(1) }

  console.log(`\nChangeOrders rows in DB: ${data.length}`)
  if (data.length > 0) console.table(data)
}
main()
