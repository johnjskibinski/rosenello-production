const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data, error } = await supabase
    .from('job_costs')
    .select('lp_job_id, mat_type, category, is_sub, total_cost, comments')
    .eq('cost_type', 'actual')
    .or('and(category.eq.Labor,is_sub.is.null),category.eq.Other')
    .order('category')
    .order('mat_type')

  if (error) { console.error(error.message); process.exit(1) }

  const laborAmbiguous = data.filter(r => r.category === 'Labor' && r.is_sub === null)
  const other = data.filter(r => r.category === 'Other')

  const laborSummary = {}
  for (const r of laborAmbiguous) {
    if (!laborSummary[r.mat_type]) laborSummary[r.mat_type] = { count: 0, total: 0, comments: [] }
    laborSummary[r.mat_type].count++
    laborSummary[r.mat_type].total += r.total_cost
    if (r.comments && !laborSummary[r.mat_type].comments.includes(r.comments))
      laborSummary[r.mat_type].comments.push(r.comments)
  }

  const otherSummary = {}
  for (const r of other) {
    if (!otherSummary[r.mat_type]) otherSummary[r.mat_type] = { count: 0, total: 0, comments: [] }
    otherSummary[r.mat_type].count++
    otherSummary[r.mat_type].total += r.total_cost
    if (r.comments && !otherSummary[r.mat_type].comments.includes(r.comments))
      otherSummary[r.mat_type].comments.push(r.comments)
  }

  console.log('\n=== LABOR WITH is_sub=NULL (ambiguous) ===')
  for (const mat of Object.keys(laborSummary)) {
    const s = laborSummary[mat]
    console.log(`  ${mat.padEnd(25)} | rows: ${s.count} | total: $${s.total.toFixed(2)} | comments: ${s.comments.slice(0,3).join(', ')}`)
  }

  console.log('\n=== CATEGORY=OTHER ===')
  for (const mat of Object.keys(otherSummary)) {
    const s = otherSummary[mat]
    console.log(`  ${mat.padEnd(25)} | rows: ${s.count} | total: $${s.total.toFixed(2)} | comments: ${s.comments.slice(0,3).join(', ')}`)
  }
}
main()
