const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data, count, error } = await supabase
    .from('job_costs')
    .select('lp_job_id, mat_type, total_cost, source', { count: 'exact' })
    .eq('mat_type', 'commission')

  if (error) { console.error(error.message); process.exit(1) }
  console.log(`Commission rows in DB: ${count}`)
  if (count > 0) console.table(data?.slice(0, 10))
}
main()
