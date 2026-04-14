import fetch from 'node-fetch';

const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY!;
const BASE_URL = 'https://api.openphone.com/v1';

function toE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export async function createOpenPhoneContact(job: {
  lp_job_id: number;
  customer_first: string;
  customer_last: string;
  address: string | null;
  product: string | null;
  raw_lp_data: any;
}): Promise<string | null> {
  try {
    const raw = job.raw_lp_data || {};

    // Build phone list
    const phoneNumbers: { name: string; value: string }[] = [];
    const primary = toE164(raw.phone1 || '');
    if (primary) phoneNumbers.push({ name: 'primary', value: primary });

    if (Array.isArray(raw.altphones)) {
      raw.altphones.forEach((p: any, i: number) => {
        const alt = toE164(typeof p === 'string' ? p : p.phone || '');
        if (alt) phoneNumbers.push({ name: `alt${i + 1}`, value: alt });
      });
    }

    // Build email list
    const emails: { name: string; value: string }[] = [];
    if (raw.email) emails.push({ name: 'primary', value: raw.email });

    const body: any = {
      defaultFields: {
        firstName: job.customer_first,
        lastName: job.customer_last,
        company: job.address || undefined,
        role: job.product || undefined,
        ...(phoneNumbers.length > 0 && { phoneNumbers }),
        ...(emails.length > 0 && { emails }),
      },
      externalId: String(job.lp_job_id),
      source: 'rosenello',
    };

    const res = await fetch(`${BASE_URL}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': OPENPHONE_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 201) {
      const data = await res.json() as any;
      console.log(`[OpenPhone] Created contact for job ${job.lp_job_id}: ${data.data.id}`);
      return data.data.id;
    }

    if (res.status === 409) {
      // Contact already exists — fetch it by externalId
      console.log(`[OpenPhone] Contact already exists for job ${job.lp_job_id}, fetching ID...`);
      const listRes = await fetch(
        `${BASE_URL}/contacts?externalId=${job.lp_job_id}&source=rosenello`,
        {
          headers: { 'Authorization': OPENPHONE_API_KEY },
        }
      );
      if (listRes.ok) {
        const listData = await listRes.json() as any;
        const existing = listData?.data?.[0];
        if (existing?.id) return existing.id;
      }
      return null;
    }

    const errText = await res.text();
    console.error(`[OpenPhone] Failed for job ${job.lp_job_id}: ${res.status} ${errText}`);
    return null;
  } catch (err) {
    console.error(`[OpenPhone] Exception for job ${job.lp_job_id}:`, err);
    return null;
  }
}
