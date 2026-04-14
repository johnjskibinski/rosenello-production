const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, gross_amount, raw_lp_data')
    .gte('completed_at', '2026-02-08')
    .lte('completed_at', '2026-02-14')
    .not('lp_job_id', 'is', null)
    .order('completed_at')

  if (error) { console.error(error.message); process.exit(1) }

  const jobIds = jobs.map(j => j.lp_job_id)
  const { data: costs } = await supabase
    .from('job_costs')
    .select('lp_job_id, cost_type, mat_type, category, is_sub, total_cost, source')
    .in('lp_job_id', jobIds)
    .eq('cost_type', 'actual')

  const costMap = {}
  for (const c of (costs || [])) {
    if (!costMap[c.lp_job_id]) costMap[c.lp_job_id] = { total: 0, commission: 0, materials: 0, labor_inhouse: 0, labor_sub: 0, labor_unknown: 0, other: 0, breakdown: {} }
    costMap[c.lp_job_id].total += c.total_cost
    costMap[c.lp_job_id].breakdown[c.mat_type] = (costMap[c.lp_job_id].breakdown[c.mat_type] || 0) + c.total_cost
    if (c.category === 'Commission')       costMap[c.lp_job_id].commission += c.total_cost
    else if (c.category === 'Materials')   costMap[c.lp_job_id].materials += c.total_cost
    else if (c.category === 'Labor' && c.is_sub === false) costMap[c.lp_job_id].labor_inhouse += c.total_cost
    else if (c.category === 'Labor' && c.is_sub === true)  costMap[c.lp_job_id].labor_sub += c.total_cost
    else if (c.category === 'Labor')       costMap[c.lp_job_id].labor_unknown += c.total_cost
    else                                   costMap[c.lp_job_id].other += c.total_cost
  }

  console.log('\n=== JOBS 2/8/26 - 2/14/26 ===\n')
  for (const j of jobs) {
    const c = costMap[j.lp_job_id] || { total: 0, commission: 0, materials: 0, labor_inhouse: 0, labor_sub: 0, labor_unknown: 0, other: 0, breakdown: {} }
    const raw = j.raw_lp_data || {}
    console.log(`${j.contract_id} — ${j.customer_first} ${j.customer_last}`)
    console.log(`  Gross:           $${parseFloat(j.gross_amount || 0).toFixed(2)}`)
    console.log(`  LP commission:   $${parseFloat(raw.commission || 0).toFixed(2)}`)
    console.log(`  DB total cost:   $${c.total.toFixed(2)}`)
    console.log(`  DB materials:    $${c.materials.toFixed(2)}`)
    console.log(`  DB labor in-house: $${c.labor_inhouse.toFixed(2)}`)
    console.log(`  DB labor sub:    $${c.labor_sub.toFixed(2)}`)
    console.log(`  DB labor unknown:$${c.labor_unknown.toFixed(2)}`)
    console.log(`  DB commission:   $${c.commission.toFixed(2)}`)
    console.log(`  DB other:        $${c.other.toFixed(2)}`)
    console.log(`  Breakdown: ${JSON.stringify(c.breakdown)}`)
    console.log()
  }

  const allC = Object.values(costMap)
  const totalRevenue = jobs.reduce((s, j) => s + parseFloat(j.gross_amount || 0), 0)
  console.log('=== WEEK TOTALS (DB) ===')
  console.log(`Revenue:          $${totalRevenue.toFixed(2)}`)
  console.log(`Total costs:      $${allC.reduce((s, c) => s + c.total, 0).toFixed(2)}`)
  console.log(`Materials:        $${allC.reduce((s, c) => s + c.materials, 0).toFixed(2)}`)
  console.log(`Labor in-house:   $${allC.reduce((s, c) => s + c.labor_inhouse, 0).toFixed(2)}`)
  console.log(`Labor sub:        $${allC.reduce((s, c) => s + c.labor_sub, 0).toFixed(2)}`)
  console.log(`Labor unknown:    $${allC.reduce((s, c) => s + c.labor_unknown, 0).toFixed(2)}`)
  console.log(`Commission:       $${allC.reduce((s, c) => s + c.commission, 0).toFixed(2)}`)
  console.log(`Other:            $${allC.reduce((s, c) => s + c.other, 0).toFixed(2)}`)
}
main()
