const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  // Get all completed jobs since July 2025
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, gross_amount, raw_lp_data, completed_at')
    .gte('completed_at', '2025-07-01')
    .not('completed_at', 'is', null)
    .not('lp_job_id', 'is', null)
    .order('completed_at', { ascending: false })

  if (error) { console.error(error.message); process.exit(1) }

  // Find all jobs that share a numeric prefix with another job (collision candidates)
  const prefixMap = {}
  for (const j of jobs) {
    if (!j.contract_id) continue
    const prefix = j.contract_id.split('-')[0]
    if (!prefixMap[prefix]) prefixMap[prefix] = []
    prefixMap[prefix].push(j)
  }

  const collisionPrefixes = Object.entries(prefixMap).filter(([, js]) => js.length > 1)
  console.log(`\n=== PREFIXES WITH MULTIPLE JOBS (collision risk) ===`)
  console.log(`Found ${collisionPrefixes.length} prefixes with 2+ jobs:\n`)
  for (const [prefix, js] of collisionPrefixes) {
    console.log(`  Prefix ${prefix}:`)
    for (const j of js) {
      console.log(`    ${j.contract_id} — ${j.customer_first} ${j.customer_last}`)
    }
  }

  // Now get all actual cost rows for these jobs
  const jobIds = jobs.map(j => j.lp_job_id)
  const { data: costs, error: costsErr } = await supabase
    .from('job_costs')
    .select('lp_job_id, cost_type, total_cost')
    .in('lp_job_id', jobIds)
    .eq('cost_type', 'actual')

  if (costsErr) { console.error(costsErr.message); process.exit(1) }

  const costMap = {}
  for (const c of costs) {
    if (!costMap[c.lp_job_id]) costMap[c.lp_job_id] = 0
    costMap[c.lp_job_id] += c.total_cost
  }

  // Flag jobs where DB costs are wildly out of range vs gross_amount
  // Rule of thumb: total costs shouldn't exceed gross_amount by >20%
  // and shouldn't be zero when gross_amount > 0
  console.log(`\n=== JOBS WITH SUSPICIOUS COST TOTALS ===`)
  console.log(`contract_id   | name                  | gross_amt  | db_actual  | ratio  | flag`)
  console.log(`------------- | --------------------- | ---------- | ---------- | ------ | ----`)

  const suspicious = []
  for (const j of jobs) {
    const dbActual = costMap[j.lp_job_id] || 0
    const gross = parseFloat(j.gross_amount) || 0
    const ratio = gross > 0 ? dbActual / gross : null

    let flag = ''
    if (dbActual === 0) flag = 'NO COSTS'
    else if (ratio !== null && ratio > 1.1) flag = 'OVER GROSS <<<'
    else if (ratio !== null && ratio < 0.05) flag = 'SUSPICIOUSLY LOW'

    if (flag) {
      suspicious.push({ j, dbActual, gross, ratio, flag })
      console.log(
        `${j.contract_id?.padEnd(13) || '?'.padEnd(13)} | ${(j.customer_first + ' ' + j.customer_last).padEnd(21)} | ${gross.toFixed(2).padStart(10)} | ${dbActual.toFixed(2).padStart(10)} | ${ratio !== null ? (ratio * 100).toFixed(1).padStart(5) + '%' : '  N/A'} | ${flag}`
      )
    }
  }

  console.log(`\nTotal jobs audited: ${jobs.length}`)
  console.log(`Suspicious jobs:    ${suspicious.length}`)
  console.log(`Collision-risk prefixes: ${collisionPrefixes.length}`)
}
main()
