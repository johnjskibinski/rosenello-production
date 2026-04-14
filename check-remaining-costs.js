const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data, error } = await supabase
    .from('job_costs')
    .select('source, cost_type, count')
    .eq('cost_type', 'actual')

  // Count by source
  const { data: rows } = await supabase
    .from('job_costs')
    .select('lp_job_id, mat_type, category, total_cost, source, cost_type')
    .eq('cost_type', 'actual')
    .neq('source', 'lp_raw_data')

  const summary = {}
  for (const r of (rows || [])) {
    if (!summary[r.source]) summary[r.source] = { count: 0, total: 0 }
    summary[r.source].count++
    summary[r.source].total += r.total_cost
  }

  console.log('\n=== NON-COMMISSION ACTUAL COST ROWS REMAINING ===')
  console.table(summary)
  console.log(`Total rows: ${rows?.length}`)
}
main()
