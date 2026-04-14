require('dotenv').config({ path: '/Users/j_ski/rosenello-production/.env' })
const { google } = require('googleapis')

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
)
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
const cal = google.calendar({ version: 'v3', auth })

async function main() {
  const res = await cal.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: '2026-04-14T00:00:00Z',
    timeMax: '2026-04-15T00:00:00Z',
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  })
  const events = res.data.items || []
  console.log('Total events returned for Apr 14:', events.length)
  events.forEach(e => {
    console.log(`  colorId=${e.colorId || 'null'} | ${e.start?.dateTime || e.start?.date} | ${e.summary}`)
  })
}
main().catch(console.error)
