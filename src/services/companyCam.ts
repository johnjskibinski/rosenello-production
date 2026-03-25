import { supabase } from '../lib/supabase'

const CC_BASE = 'https://api.companycam.com/v2'
const CC_TOKEN = process.env.COMPANYCAM_API_KEY || ''
const CC_WEB_BASE = 'https://app.companycam.com/projects'

interface AddressComponents {
  streetNumber: string
  streetName: string
  city: string
  state: string
  zip: string
}

interface CCProject {
  id: string
  name: string
  address: string
  city: string
  state: string
  zip: string
  createdAt: string
}

function parseAddress(raw: string): AddressComponents {
  const full = raw.replace(/,?\s*USA$/i, '').trim()
  const parts = full.split(',').map(p => p.trim()).filter(Boolean)

  const street = parts[0] || ''
  const streetMatch = street.match(/^(\d+)\s*(.*)/)
  const streetNumber = streetMatch ? streetMatch[1] : ''
  const streetName = streetMatch
    ? streetMatch[2].toLowerCase().replace(/[^a-z0-9]/g, '')
    : street.toLowerCase().replace(/[^a-z0-9]/g, '')

  const city = (parts[1] || '').trim()
  let state = ''
  let zip = ''

  if (parts[2]) {
    const m = parts[2].match(/([A-Z]{2})\s+(\d{5})/i)
    if (m) { state = m[1].toUpperCase(); zip = m[2] }
    else state = parts[2].trim()
  }

  return { streetNumber, streetName, city, state, zip }
}

function normalizeStreetName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function extractStreetNumber(address: string): string {
  const m = String(address || '').trim().match(/^(\d+)/)
  return m ? m[1] : ''
}

function buildCCUrl(projectId: string): string {
  return `${CC_WEB_BASE}/${projectId}`
}

async function ccRequest(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${CC_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CC_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`CompanyCam ${method} ${path} failed (${res.status}): ${text}`)
  return text ? JSON.parse(text) : {}
}

function normalizeProjects(resp: any): any[] {
  if (Array.isArray(resp)) return resp
  if (Array.isArray(resp?.projects)) return resp.projects
  if (Array.isArray(resp?.data)) return resp.data
  return []
}

function extractProject(obj: any): CCProject | null {
  if (!obj || typeof obj !== 'object') return null
  const base = obj.project && typeof obj.project === 'object' ? obj.project : obj
  const id = String(base.id || base.project_id || '').trim()
  if (!id) return null

  const addrObj = base.address && typeof base.address === 'object' ? base.address : {}
  const addressStr = typeof base.address === 'string'
    ? base.address
    : [addrObj.street_address_1 || addrObj.street || '', addrObj.city || '', addrObj.state || '', addrObj.postal_code || ''].filter(Boolean).join(', ')

  return {
    id,
    name: String(base.name || base.title || '').trim(),
    address: addressStr,
    city: String(addrObj.city || base.city || '').trim(),
    state: String(addrObj.state || base.state || '').trim(),
    zip: String(addrObj.postal_code || base.zip || '').trim().slice(0, 5),
    createdAt: String(base.created_at || base.createdAt || ''),
  }
}

function scoreProject(proj: CCProject, addr: AddressComponents, lastName: string, contractDate: string | null): number {
  // Hard gate — street number must match exactly
  const projStreetNum = extractStreetNumber(proj.address)
  if (!projStreetNum || projStreetNum !== addr.streetNumber) return -1

  let score = 0

  // Zip match
  const projZip = proj.zip.slice(0, 5)
  if (addr.zip && projZip && addr.zip === projZip) score += 4

  // Street name match
  const projStreetName = normalizeStreetName(proj.address.replace(/^\d+\s*/, ''))
  if (addr.streetName && projStreetName && projStreetName.includes(addr.streetName)) score += 3

  // City match
  if (addr.city && proj.city && addr.city.toLowerCase() === proj.city.toLowerCase()) score += 2

  // Contract date proximity (within 180 days)
  if (contractDate && proj.createdAt) {
    const contractMs = new Date(contractDate).getTime()
    const createdMs = new Date(proj.createdAt).getTime()
    if (!isNaN(contractMs) && !isNaN(createdMs)) {
      const diffDays = Math.abs(contractMs - createdMs) / 86400000
      if (diffDays <= 180) score += 2
    }
  }

  // Last name fuzzy match (tiebreaker only)
  if (lastName && proj.name) {
    const projNameLower = proj.name.toLowerCase()
    if (projNameLower.includes(lastName.toLowerCase())) score += 1
  }

  return score
}

async function searchAndMatch(
  query: string,
  addr: AddressComponents,
  lastName: string,
  contractDate: string | null
): Promise<CCProject | null> {
  const resp = await ccRequest('GET', `/projects?query=${encodeURIComponent(query)}`)
  const rows = normalizeProjects(resp)
  if (!rows.length) return null

  let best: CCProject | null = null
  let bestScore = -1

  for (const row of rows) {
    const proj = extractProject(row)
    if (!proj) continue
    const score = scoreProject(proj, addr, lastName, contractDate)
    if (score < 0) continue // failed hard gate
    if (score > bestScore || (score === bestScore && proj.createdAt > (best?.createdAt || ''))) {
      best = proj
      bestScore = score
    }
  }

  return best
}

export async function resolveCompanyCamProject(job: any): Promise<string | null> {
  if (!CC_TOKEN) {
    console.warn('[CC] COMPANYCAM_API_KEY not set — skipping')
    return null
  }

  const addressRaw = [job.address, job.city, job.state, job.zip].filter(Boolean).join(', ')
  const addr = parseAddress(addressRaw)

  if (!addr.streetNumber) {
    console.warn(`[CC] No street number parseable for job ${job.lp_job_id} — skipping`)
    await supabase.from('jobs').update({ companycam_checked_at: new Date().toISOString() }).eq('lp_job_id', job.lp_job_id)
    return null
  }

  const lastName = job.customer_last || ''
  const contractDate = job.contract_date || null

  try {
    // Phase 1: street number + zip
    let match: CCProject | null = null
    if (addr.zip) {
      match = await searchAndMatch(`${addr.streetNumber} ${addr.zip}`, addr, lastName, contractDate)
    }

    // Phase 2 fallback: street number + city
    if (!match && addr.city) {
      match = await searchAndMatch(`${addr.streetNumber} ${addr.city}`, addr, lastName, contractDate)
    }

    let projectId: string
    let projectUrl: string

    if (match) {
      projectId = match.id
      projectUrl = buildCCUrl(match.id)
      console.log(`[CC] Matched job ${job.lp_job_id} → CC project ${projectId}`)
    } else {
      // Auto-create
      const created = await ccRequest('POST', '/projects', {
        name: `${lastName}${job.customer_first ? ', ' + job.customer_first : ''}`.trim(),
        address: {
          street_address_1: job.address,
          city: job.city,
          state: job.state,
          postal_code: job.zip,
        },
      })
      const newProj = extractProject(created)
      if (!newProj?.id) throw new Error('CC create returned no ID')
      projectId = newProj.id
      projectUrl = buildCCUrl(newProj.id)
      console.log(`[CC] Created CC project ${projectId} for job ${job.lp_job_id}`)
    }

    await supabase.from('jobs').update({
      companycam_project_id: projectId,
      companycam_url: projectUrl,
      companycam_checked_at: new Date().toISOString(),
    }).eq('lp_job_id', job.lp_job_id)

    return projectId
  } catch (err: any) {
    console.error(`[CC] Error resolving job ${job.lp_job_id}:`, err.message)
    await supabase.from('jobs').update({
      companycam_checked_at: new Date().toISOString(),
    }).eq('lp_job_id', job.lp_job_id)
    return null
  }
}
