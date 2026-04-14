require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: estimated } = await supabase
    .from('job_costs')
    .select('lp_job_id')
    .eq('cost_type', 'estimated')

  const { data: actual } = await supabase
    .from('job_costs')
    .select('lp_job_id')
    .eq('cost_type', 'actual')

  const estIds = new Set(estimated.map(r => r.lp_job_id))
  const actIds = new Set(actual.map(r => r.lp_job_id))

  const overlap = [...estIds].filter(id => actIds.has(id))

  console.log(`Estimated job IDs: ${estIds.size}`)
  console.log(`Actual job IDs:    ${actIds.size}`)
  console.log(`Overlap:           ${overlap.length}`)
  console.log(`Sample estimated IDs: ${[...estIds].slice(0,5)}`)
  console.log(`Sample actual IDs:    ${[...actIds].slice(0,5)}`)
}
main()
