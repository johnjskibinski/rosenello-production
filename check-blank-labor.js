const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: costs, error } = await supabase
    .from('job_costs')
    .select('lp_job_id, total_cost, invoice_date, comments')
    .eq('cost_type', 'actual')
    .eq('mat_type', 'Labor')
    .eq('category', 'Labor')
    .is('is_sub', null)

  if (error) { console.error(error.message); process.exit(1) }

  const jobIds = [...new Set(costs.map(r => r.lp_job_id))]

  const { data: jobs } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, completed_at')
    .in('lp_job_id', jobIds)

  const jobMap = {}
  for (const j of jobs) jobMap[j.lp_job_id] = j

  console.log('\n=== BLANK LABOR ROWS ===\n')
  for (const c of costs) {
    const j = jobMap[c.lp_job_id] || {}
    console.log(`${(j.contract_id || '?').padEnd(15)} | ${(j.customer_first + ' ' + j.customer_last).padEnd(22)} | $${c.total_cost.toFixed(2).padStart(8)} | invoice: ${c.invoice_date || 'none'} | comments: "${c.comments || ''}"`)
  }
}
main()
