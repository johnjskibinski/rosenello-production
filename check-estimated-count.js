const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data, count } = await supabase
    .from('job_costs')
    .select('*', { count: 'exact' })
    .eq('cost_type', 'estimated')

  console.log(`Total estimated rows in DB: ${count}`)
  if (data?.length) console.table(data.slice(0, 5))
}
main()
