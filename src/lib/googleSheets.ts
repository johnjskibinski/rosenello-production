import { google } from 'googleapis'

const TEMPLATE_SHEET_ID = '1WfdoSeTwr-nt-8OF6eBRs72YZ8kjQzEDf00xkmzH2Ws'

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set')
  const creds = JSON.parse(raw)
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  })
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
      q: `name='${sheetTitle}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id, name)',
    })
    if (existing.data.files && existing.data.files.length > 0) {
      console.log(`Measure sheet already exists for job ${job.lp_job_id}`)
      return existing.data.files[0].id || null
    }

    // Copy the template
    const copy = await drive.files.copy({
      fileId: TEMPLATE_SHEET_ID,
      requestBody: { name: sheetTitle },
    })
    const newSheetId = copy.data.id!

    const d = job.raw_lp_data || {}

    // Format address as one line
    const address = [d.address1, d.city, d.state, d.zip]
      .filter(Boolean)
      .join(', ')

    // Human-facing contract ID (e.g. 12345-W)
    const humanJobId = d.contractid || job.contract_id || ''

    // Numeric LP job ID (e.g. 3434)
    const numericJobId = job.lp_job_id

    // Phone
    const phone = d.phone1 || ''

    // Financials
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

    console.log(`Created measure sheet for ${customerName}: ${newSheetId}`)
    return newSheetId
  } catch (err) {
    console.error(`Failed to create measure sheet for job ${job.lp_job_id}:`, err)
    return null
  }
}
