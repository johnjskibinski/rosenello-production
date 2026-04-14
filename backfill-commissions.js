const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_last, raw_lp_data, completed_at')
    .gte('completed_at', '2024-09-01')
    .not('completed_at', 'is', null)
    .not('lp_job_id', 'is', null)

  if (error) { console.error(error.message); process.exit(1) }

  console.log(`Processing ${jobs.length} completed jobs since September 2024...\n`)

  let inserted = 0, skipped = 0, zeroed = 0

  for (const job of jobs) {
    const raw = job.raw_lp_data || {}
    const commAmt = parseFloat(raw.commission)

    if (!commAmt || commAmt <= 0) { zeroed++; continue }

    await supabase
      .from('job_costs')
      .delete()
      .eq('lp_job_id', job.lp_job_id)
      .eq('cost_type', 'actual')
      .eq('mat_type', 'commission')

    const { error: insertErr } = await supabase
      .from('job_costs')
      .insert({
        lp_job_id:  job.lp_job_id,
        cost_type:  'actual',
        mat_type:   'commission',
        category:   'Commission',
        is_sub:     false,
        total_cost: commAmt,
        source:     'lp_raw_data'
      })

    if (insertErr) {
      console.error(`  ERROR ${job.customer_last} (${job.contract_id}): ${insertErr.message}`)
      skipped++
    } else {
      console.log(`  ✓ ${job.customer_last} (${job.contract_id}): $${commAmt.toFixed(2)}`)
      inserted++
    }
  }

  console.log(`\n=== DONE ===`)
  console.log(`Inserted: ${inserted}`)
  console.log(`Skipped (errors): ${skipped}`)
  console.log(`Zero/no commission: ${zeroed}`)
}
main()
