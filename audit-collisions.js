const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

async function main() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id, customer_first, customer_last, completed_at')
    .not('lp_job_id', 'is', null)

  if (error) { console.error(error.message); process.exit(1) }

  // Group by numeric prefix
  const prefixMap = {}
  for (const j of jobs) {
    if (!j.contract_id) continue
    const prefix = j.contract_id.split('-')[0].trim()
    if (!prefixMap[prefix]) prefixMap[prefix] = []
    prefixMap[prefix].push(j)
  }

  const collisions = Object.entries(prefixMap).filter(([, js]) => js.length > 1)

  console.log(`\n=== PREFIXES WITH MULTIPLE JOBS ===\n`)
  for (const [prefix, js] of collisions) {
    console.log(`Prefix: ${prefix}`)
    for (const j of js) {
      console.log(`  contract_id="${j.contract_id}" | lp_job_id=${j.lp_job_id} | ${j.customer_first} ${j.customer_last}`)
    }
  }

  console.log(`\nTotal collision prefixes: ${collisions.length}`)

  // Also check for duplicate contract_ids (exact match)
  const exactMap = {}
  for (const j of jobs) {
    if (!j.contract_id) continue
    if (!exactMap[j.contract_id]) exactMap[j.contract_id] = []
    exactMap[j.contract_id].push(j)
  }

  const exactDupes = Object.entries(exactMap).filter(([, js]) => js.length > 1)
  console.log(`\n=== EXACT DUPLICATE CONTRACT IDs ===\n`)
  if (exactDupes.length === 0) {
    console.log('None — all contract_ids are unique.')
  } else {
    for (const [cid, js] of exactDupes) {
      console.log(`contract_id="${cid}"`)
      for (const j of js) {
        console.log(`  lp_job_id=${j.lp_job_id} | ${j.customer_first} ${j.customer_last}`)
      }
    }
  }
}
main()
