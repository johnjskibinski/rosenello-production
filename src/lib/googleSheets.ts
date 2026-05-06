import { google } from 'googleapis'

const TEMPLATE_SHEET_ID = '1WfdoSeTwr-nt-8OF6eBRs72YZ8kjQzEDf00xkmzH2Ws'
const DRIVE_FOLDER_ID = '1ZWQoi0_ZV2-K2UeuGXQUnYNouUTes3V2'

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'
  )
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  })
  return oauth2Client
}

async function setAnyoneWithLink(drive: any, fileId: string) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'writer', type: 'anyone' },
    })
  } catch (err: any) {
    // Permission may already exist; safe to ignore
    console.log(`Permission set/exists for ${fileId}: ${err?.message || 'ok'}`)
  }
}

export async function createMeasureSheet(job: any): Promise<string | null> {
  try {
    const auth = getAuth()
    const drive = google.drive({ version: 'v3', auth })
    const sheets = google.sheets({ version: 'v4', auth })

    const customerName = `${job.customer_first} ${job.customer_last}`
    const sheetTitle = `Measure - ${customerName} - ${job.contract_id || job.lp_job_id}`

    // Skip if sheet already exists
    const existing = await drive.files.list({
      q: `name='${sheetTitle}' and trashed=false`,
      fields: 'files(id, name)',
    })
    if (existing.data.files && existing.data.files.length > 0) {
      const existingId = existing.data.files[0].id || null
      console.log(`Measure sheet already exists for job ${job.lp_job_id}`)
      // Make sure existing sheets also have public link sharing
      if (existingId) await setAnyoneWithLink(drive, existingId)
      return existingId
    }

    // Copy the template into the Rosenello Measure Sheets folder
    const copy = await drive.files.copy({
      fileId: TEMPLATE_SHEET_ID,
      requestBody: {
        name: sheetTitle,
        parents: [DRIVE_FOLDER_ID],
      },
    })
    const newSheetId = copy.data.id!

    // Anyone with the link can edit — Eric and team should not need to request access
    await setAnyoneWithLink(drive, newSheetId)

    const d = job.raw_lp_data || {}
    const address = [d.address1, d.city, d.state, d.zip].filter(Boolean).join(', ')
    const humanJobId = d.contractid || job.contract_id || ''
    const numericJobId = job.lp_job_id
    const phone = d.phone1 || ''
    const gross = parseFloat(d.grossamount || job.gross_amount || 0)
    const balance = parseFloat(d.balancedue || job.balance_due || 0)

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: newSheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Costing!C1', values: [[humanJobId]] },
          { range: 'Costing!C2', values: [[customerName]] },
          { range: 'Costing!C3', values: [[address]] },
          { range: 'Costing!C4', values: [[phone]] },
          { range: 'Costing!D5', values: [[gross]] },
          { range: 'Costing!G5', values: [[balance]] },
          { range: 'Costing!J1', values: [[numericJobId]] },
        ],
      },
    })

    console.log(`Created measure sheet for ${customerName}: https://docs.google.com/spreadsheets/d/${newSheetId}`)
    return newSheetId
  } catch (err: any) {
    console.error(`Failed to create measure sheet for job ${job.lp_job_id}:`, err?.message || err)
    return null
  }
}
