import 'dotenv/config'
import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
)
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
})

const drive = google.drive({ version: 'v3', auth: oauth2Client })

function extractFileId(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  return m ? m[1] : null
}

async function main() {
  // Paginate through Supabase 1,000 at a time
  let allJobs = []
  let from = 0
  const pageSize = 1000
  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('lp_job_id, customer_first, customer_last, measure_sheet_url')
      .not('measure_sheet_url', 'is', null)
      .range(from, from + pageSize - 1)
    if (error) {
      console.error('Supabase error:', error)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    allJobs = allJobs.concat(data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Found ${allJobs.length} jobs with measure sheets to update`)

  let success = 0, failed = 0, skipped = 0

  for (const job of allJobs) {
    const fileId = extractFileId(job.measure_sheet_url)
    if (!fileId) {
      console.log(`SKIP ${job.lp_job_id}: bad URL ${job.measure_sheet_url}`)
      skipped++
      continue
    }
    try {
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'writer', type: 'anyone' },
      })
      console.log(`OK   ${job.lp_job_id} ${job.customer_first} ${job.customer_last}`)
      success++
    } catch (err) {
      console.error(`FAIL ${job.lp_job_id}: ${err.message}`)
      failed++
    }
    await new Promise(r => setTimeout(r, 100))
  }

  console.log('')
  console.log('=== SUMMARY ===')
  console.log(`Success: ${success}`)
  console.log(`Failed:  ${failed}`)
  console.log(`Skipped: ${skipped}`)
}

main().catch(err => { console.error(err); process.exit(1) })
