const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  // Grab 5 completed jobs and dump all commission-related keys from raw_lp_data
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_last, raw_lp_data')
    .not('completed_at', 'is', null)
    .limit(5)

  if (error) { console.error(error.message); process.exit(1) }

  for (const job of jobs) {
    const raw = job.raw_lp_data || {}
    const commKeys = Object.entries(raw).filter(([k]) =>
      k.toLowerCase().includes('comm') ||
      k.toLowerCase().includes('commission')
    )
    console.log(`\n--- ${job.customer_last} (${job.contract_id}) ---`)
    if (commKeys.length === 0) {
      console.log('  No commission keys found')
    } else {
      commKeys.forEach(([k, v]) => console.log(`  ${k}: ${v}`))
    }
  }
}
main()
