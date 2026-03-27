import axios from 'axios'
import qs from 'qs'

const LP_WEB_BASE = 'https://e5d8a.leadperfection.com'

interface WebSessionCache {
  cookie: string
  expiresAt: number
}

let sessionCache: WebSessionCache | null = null

export async function getLPWebSession(): Promise<string> {
  const now = Date.now()
  if (sessionCache && sessionCache.expiresAt > now + 5 * 60 * 1000) {
    return sessionCache.cookie
  }

  console.log('[LPWeb] Fetching LP login page...')

  // Step 1: GET Login.aspx to extract VIEWSTATE + EVENTVALIDATION
  const getResp = await axios.get(`${LP_WEB_BASE}/Login.aspx`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    validateStatus: (s) => s < 600,
  })

  const html = getResp.data as string
  const viewstateMatch = html.match(/id="__VIEWSTATE"\s+value="([^"]+)"/)
  const viewstateGenMatch = html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/)
  const eventValMatch = html.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/)

  if (!viewstateMatch) throw new Error('[LPWeb] Could not extract __VIEWSTATE from Login.aspx')

  const initialCookies = (getResp.headers['set-cookie'] ?? [])
    .map((c: string) => c.split(';')[0]).join('; ')

  console.log('[LPWeb] Posting credentials...')

  // Step 2: POST credentials
  const postResp = await axios.post(
    `${LP_WEB_BASE}/Login.aspx`,
    qs.stringify({
      __VIEWSTATE: viewstateMatch[1],
      __VIEWSTATEGENERATOR: viewstateGenMatch?.[1] ?? '',
      __EVENTVALIDATION: eventValMatch?.[1] ?? '',
      username: process.env.LP_WEB_USERNAME,
      password: process.env.LP_WEB_PASSWORD,
      btnLogin: 'Login',
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
        'Cookie': initialCookies,
      },
      maxRedirects: 5,
      validateStatus: (s) => s < 600,
    }
  )

  const setCookies = postResp.headers['set-cookie'] ?? []
  const cookie = setCookies.map((c: string) => c.split(';')[0]).join('; ')

  if (!cookie || !cookie.includes('=')) {
    throw new Error('[LPWeb] Login failed — no session cookie. Check LP_WEB_USERNAME / LP_WEB_PASSWORD')
  }

  // Verify we actually landed on the dashboard, not back on Login.aspx
  const landingUrl = postResp.request?.res?.responseUrl ?? ''
  if (landingUrl.includes('Login.aspx')) {
    throw new Error('[LPWeb] Login failed — redirected back to login page. Check credentials.')
  }

  console.log('[LPWeb] Session established, cookies:', setCookies.length)
  sessionCache = { cookie, expiresAt: Date.now() + 60 * 60 * 1000 }
  return cookie
}

export async function lpWebGet(ajaxAction: string, extra: Record<string, any> = {}): Promise<any> {
  const cookie = await getLPWebSession()
  const query = JSON.stringify([{ ajax: ajaxAction, options: '0', term: 'get', format: 'jsondata', ...extra }])

  const resp = await axios.get(`${LP_WEB_BASE}/djson.aspx`, {
    params: { '': query },
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0',
    },
    validateStatus: (s) => s < 600,
  })

  if (resp.status === 401 || resp.status === 403) {
    sessionCache = null
    throw new Error(`[LPWeb] ${ajaxAction} auth failed HTTP ${resp.status} — session cleared, will retry`)
  }
  if (resp.status >= 400) {
    throw new Error(`[LPWeb] ${ajaxAction} HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`)
  }
  return resp.data
}

export async function lpGetJobDetail(jobId: string | number): Promise<any> {
  const result = await lpWebGet('GetJobDetail', { jobid: String(jobId) })
  if (!result?.Records?.length) throw new Error(`[LPWeb] GetJobDetail no records for jobid ${jobId}`)
  return result.Records[0]
}

export async function lpSaveJobStatus(jobId: string | number, newStatus: string): Promise<any> {
  const job = await lpGetJobDetail(jobId)

  const data = {
    jobid: String(jobId),
    usn: job.usn,
    productid: job.productid ?? '',
    productid2: job.productid2 ?? '',
    productid3: job.productid3 ?? '',
    productid4: job.productid4 ?? '',
    vendor: job.vnd_id ?? null,
    vendor2: job.vnd_id2 ?? null,
    vendor3: job.vnd_id3 ?? null,
    vendor4: job.vnd_id4 ?? null,
    brp_id: job.brp_id ?? null,
    jbs_id: newStatus,
    statusdate: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' ',
    pws_id: job.pws_id ?? null,
    grossamount: job.grossamount ?? '0.00',
    jobnetamount: job.jobnetamount ?? '0.00',
    contractid: job.contractid ?? '',
    paramount: job.paramount ?? '0.00',
    cmt_id: job.cmt_id ?? 'G',
    commission: job.commission ?? '0.00',
    fns_id: job.fns_id ?? '',
    fns_id2: job.fns_id2 ?? '',
    fns_id3: job.fns_id3 ?? '',
    fundeddate: job.fundeddate ?? '',
    fundedamount: job.fundedamount ?? '0.00',
    slr_id: job.slr_id ?? '0',
    slr_id2: job.slr_id2 ?? '0',
    slr_split: job.slr_split ?? '0',
    ins_installer1: job.ins_installer1 ?? null,
    ins_installer2: job.ins_installer2 ?? null,
    ins_installer3: job.ins_installer3 ?? null,
    ins_installer4: job.ins_installer4 ?? null,
    measuredby: job.measuredby ?? null,
    budgetcost: job.budgetcost ?? '0.00',
    actualcost: job.actualcost ?? '0.00',
    jobnotes: job.jobnotes ?? '',
    finco_id: job.finco_id ?? null,
    finamount: job.finamount ?? '0.00',
    finmonths: job.finmonths ?? '0',
    fincrlimit: job.fincrlimit ?? '0.00',
    finplan_id: job.finplan_id ?? null,
    finfee: job.finfee ?? '0.00',
    finapproved: job.finapproved ?? false,
    fin2ndlook: job.fin2ndlook ?? false,
    finrate: job.finrate ?? '0.0000',
    finterms: job.finterms ?? '',
    findtapproved: job.findtapproved ?? '',
    finexpire: job.finexpire ?? '',
    finhomevalue: job.finhomevalue ?? '0.00',
    finparty1name: job.finparty1name ?? '',
    finparty1employer: job.finparty1employer ?? '',
    finparty1empphone: job.finparty1empphone ?? '',
    finparty1income: job.finparty1income ?? '0.00',
    finparty1creditscore: job.finparty1creditscore ?? '0',
    finparty2name: job.finparty2name ?? '',
    finparty2employer: job.finparty2employer ?? '',
    finparty2empphone: job.finparty2empphone ?? '',
    finparty2income: job.finparty2income ?? '0.00',
    finparty2creditscore: job.finparty2creditscore ?? '0',
    finnotes: job.finnotes ?? '',
    batchflag: job.batchflag ?? false,
    batchflag2: job.batchflag2 ?? false,
    resource1: job.resource1 ?? null,
    resource2: job.resource2 ?? null,
    resource3: job.resource3 ?? null,
    resource4: job.resource4 ?? null,
    resource5: job.resource5 ?? null,
    resource6: job.resource6 ?? null,
    resource7: job.resource7 ?? null,
    resource8: job.resource8 ?? null,
    numextrafinrows: job.numextrafinrows ?? '0',
  }

  const result = await lpWebGet('SaveJobDetail', { data: [data] })
  console.log(`[LPWeb] SaveJobDetail job ${jobId} → ${newStatus}:`, JSON.stringify(result).slice(0, 200))
  return result
}
