const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  // Count first
  const { count } = await supabase
    .from('job_costs')
    .select('*', { count: 'exact', head: true })
    .eq('cost_type', 'actual')
    .eq('source', 'lp_csv')

  console.log(`Rows to delete: ${count}`)
  console.log('Type YES to confirm...')

  process.stdin.once('data', async (data) => {
    if (data.toString().trim() !== 'YES') {
      console.log('Aborted.')
      process.exit(0)
    }

    const { error } = await supabase
      .from('job_costs')
      .delete()
      .eq('cost_type', 'actual')
      .eq('source', 'lp_csv')

    if (error) { console.error(error.message); process.exit(1) }
    console.log(`Done — deleted ${count} rows. Commissions untouched.`)
    process.exit(0)
  })
}
main()
