const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const LP_REPORT = [
  { name: 'Reid, Jessica',     contract_id: '11809-PDED', total_cost: 1500.00   },
  { name: 'Risi, Deborah',     contract_id: '11607-W',    total_cost: 2374.45   },
  { name: 'Martin, Dave',      contract_id: '11724-EDPD', total_cost: 14461.46  },
  { name: 'Ade, Jessica',      contract_id: '11574-W',    total_cost: 7617.75   },
  { name: 'Havicon, Jon',      contract_id: '11717-WED',  total_cost: 627.58    },
  { name: 'Seiple, Dena',      contract_id: '11734-W',    total_cost: 627.58    },
  { name: 'Lantzy, Pat',       contract_id: '11742-W',    total_cost: 6584.06   },
  { name: 'Collins, Patrick',  contract_id: '11745-W',    total_cost: 8140.83   },
  { name: 'Gardner, Veronica', contract_id: '11726-W',    total_cost: 942.33    },
  { name: 'Montone, Nick',     contract_id: '11759-W',    total_cost: 6568.90   },
  { name: 'Burke, Jim',        contract_id: '11701-WMW',  total_cost: 1128.92   },
  { name: 'Razler, Mike',      contract_id: '11744-W',    total_cost: 6273.24   },
  { name: 'Vernick, Brian',    contract_id: '11632-WED',  total_cost: 24957.27  },
  { name: 'Sampson, Carolyn',  contract_id: '11733-ED',   total_cost: 3948.02   },
  { name: 'Payne, Sue',        contract_id: '11699-W',    total_cost: 3195.25   },
  { name: 'Wenzel, Mike',      contract_id: '11720-WSG',  total_cost: 18001.10  },
  { name: 'Hasbun, David',     contract_id: '11721-W',    total_cost: 8050.35   },
  { name: 'Coe, Davida',       contract_id: '11730-W',    total_cost: 2177.99   },
  { name: 'McGovern, Lindsay', contract_id: '11741-W',    total_cost: 6510.82   },
]

async function main() {
  const contractIds = LP_REPORT.map(j => j.contract_id)
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('lp_job_id, contract_id')
    .in('contract_id', contractIds)
  if (error) { console.error(error.message); process.exit(1) }

  const jobMap = {}
  for (const j of jobs) jobMap[j.contract_id] = j

  const jobIds = jobs.map(j => j.lp_job_id).filter(Boolean)
  const { data: costs, error: costsErr } = await supabase
    .from('job_costs')
    .select('lp_job_id, cost_type, mat_type, total_cost')
    .in('lp_job_id', jobIds)
  if (costsErr) { console.error(costsErr.message); process.exit(1) }

  const costMap = {}
  for (const c of costs) {
    if (!costMap[c.lp_job_id]) costMap[c.lp_job_id] = { actual: 0, byType: {} }
    if (c.cost_type === 'actual') {
      costMap[c.lp_job_id].actual += c.total_cost
      costMap[c.lp_job_id].byType[c.mat_type] = (costMap[c.lp_job_id].byType[c.mat_type] || 0) + c.total_cost
    }
  }

  console.log('\ncontract_id   | name              | LP_total  | DB_actual | diff      | breakdown')
  console.log('------------- | ----------------- | --------- | --------- | --------- | ---------')

  let lpSum = 0, dbSum = 0
  for (const row of LP_REPORT) {
    const job = jobMap[row.contract_id]
    const dbActual = job ? (costMap[job.lp_job_id]?.actual || 0) : 0
    const byType = job ? costMap[job.lp_job_id]?.byType || {} : {}
    const diff = dbActual - row.total_cost
    lpSum += row.total_cost
    dbSum += dbActual
    const flag = Math.abs(diff) > 1 ? ' <<<' : ' ✓'
    const breakdown = Object.entries(byType).map(([k,v]) => `${k}:$${v.toFixed(0)}`).join(' | ')
    console.log(
      `${row.contract_id.padEnd(13)} | ${row.name.padEnd(17)} | ${row.total_cost.toFixed(2).padStart(9)} | ${dbActual.toFixed(2).padStart(9)} | ${diff.toFixed(2).padStart(9)} |${flag} ${breakdown}`
    )
  }

  console.log(`\nLP total:  $${lpSum.toFixed(2)}`)
  console.log(`DB total:  $${dbSum.toFixed(2)}`)
  console.log(`Diff:      $${(dbSum - lpSum).toFixed(2)}`)
}
main()
