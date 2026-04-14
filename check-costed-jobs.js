const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  // Fetch all pages
  let allCosts = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('job_costs')
      .select('lp_job_id, cost_type, total_cost')
      .range(from, from + pageSize - 1)
    if (error) { console.error(error.message); process.exit(1) }
    if (!data || data.length === 0) break
    allCosts = allCosts.concat(data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Total cost rows fetched: ${allCosts.length}`)

  const costMap = {}
  for (const c of allCosts) {
    if (!costMap[c.lp_job_id]) costMap[c.lp_job_id] = { estimated: 0, actual: 0 }
    if (c.cost_type === 'estimated') costMap[c.lp_job_id].estimated += c.total_cost
    if (c.cost_type === 'actual')    costMap[c.lp_job_id].actual    += c.total_cost
  }

  const both = Object.entries(costMap).filter(function(e) { return e[1].estimated > 0 && e[1].actual > 0 })
  console.log('Jobs with both estimated + actual:', both.length)

  if (both.length === 0) return

  const bothIds = both.map(function(e) { return parseInt(e[0]) })
  const { data: jobs } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, completed_at, gross_amount')
    .in('lp_job_id', bothIds)
    .order('completed_at', { ascending: false })

  const result = jobs.map(function(j) {
    const c = costMap[j.lp_job_id]
    return {
      lp_job_id:    j.lp_job_id,
      customer:     j.customer_first + ' ' + j.customer_last,
      completed_at: j.completed_at,
      gross:        j.gross_amount,
      est_cost:     c.estimated.toFixed(2),
      actual_cost:  c.actual.toFixed(2),
      variance:     (c.actual - c.estimated).toFixed(2)
    }
  })

  console.table(result)
}
main()
