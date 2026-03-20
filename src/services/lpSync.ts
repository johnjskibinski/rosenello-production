import { lpPost } from '../lib/lpClient';
import { supabase } from '../lib/supabase';

function fmtDate(d: Date): string {
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
}

export const ACTIVE_STATUSES = ['N','SN','PU','SS','MR','D','B','1','2','3','NS','SV','S','5','T','SI','CM','U'];

export const STATUS_LABELS: Record<string, string> = {
  N:  'New',
  SN: 'Scope Needed',
  PU: 'Scope / Pickup Check',
  SS: 'Scope Scheduled',
  MR: 'Scope Complete/In Review',
  D:  'Waiting HOA Approval',
  B:  'Rel To Production',
  '1': 'Order Materials',
  '2': 'Materials Ordered',
  '3': 'Awaiting Parts',
  NS: 'Need to Schedule',
  SV: 'Need Schedule Service',
  S:  'Scheduled',
  '5': 'In Progress',
  T:  'Installed & Unpaid',
  SI: 'Need Subcontractor Invoice',
  C:  'Complete (Paid and Closed)',
  P:  'Installed & Paid',
  E:  'Cancel In Rescission',
  X:  'Cancel After Rescission',
  G:  'Cancelled By Mgt',
  J:  'Credit Decline',
  CM: 'Commercial',
  U:  'Unknown',
};

async function fetchByStatus(jbs_id: string): Promise<any[]> {
  const PAGE_SIZE = 250;
  let startIndex = 1;
  let allJobs: any[] = [];

  const endDate = fmtDate(new Date());
  const startDate = '01/01/2010';

  while (true) {
    const data = await lpPost('Customers/GetJobStatusChanges', {
      startdate: startDate,
      enddate: endDate,
      cst_id: '0',
      job_id: '0',
      jbs_id,
      format: '1',
      options: '0',
      sortorder: '1',
      PageSize: String(PAGE_SIZE),
      StartIndex: String(startIndex),
    });

    const jobs = Array.isArray(data) ? data : [];
    allJobs = allJobs.concat(jobs);

    if (jobs.length < PAGE_SIZE) break;
    startIndex += PAGE_SIZE;
  }

  return allJobs;
}

export async function syncJobs(): Promise<{ synced: number; errors: number }> {
  console.log('[Sync] Starting LP job sync by active statuses...');

  let synced = 0;
  let errors = 0;
  const seenJobIds = new Set<number>();
  const allJobs: any[] = [];

  for (const status of ACTIVE_STATUSES) {
    const jobs = await fetchByStatus(status);
    console.log(`[Sync] Status ${status}: ${jobs.length} jobs`);

    for (const job of jobs) {
      const id = parseInt(job.job_id ?? job.JobID ?? 0);
      if (id && !seenJobIds.has(id)) {
        seenJobIds.add(id);
        allJobs.push(job);
      }
    }
  }

  console.log(`[Sync] Total unique active jobs: ${allJobs.length}`);

  for (const job of allJobs) {
    try {
      const lpJobId = parseInt(job.job_id ?? job.JobID ?? 0);
      if (!lpJobId) { errors++; continue; }

      const statusCode = job.jbs_id ?? job.JBS_ID ?? '';

      const { error } = await supabase
        .from('jobs')
        .upsert(
          {
            lp_job_id: lpJobId,
            customer_first: job.firstname ?? '',
            customer_last: job.lastname ?? '',
            address: job.address1 ?? job.address ?? '',
            city: job.city ?? '',
            state: job.state ?? '',
            zip: String(job.zip ?? '').trim(),
            lp_status: statusCode,
            lp_status_label: STATUS_LABELS[statusCode] ?? statusCode,
            gross_amount: parseFloat(String(job.grossamount ?? 0).replace(/[^0-9.]/g, '')) || 0,
            balance_due: 0,
            salesperson: job.salesrepname ?? '',
            installer_1: job.installer1 ?? '',
            installer_2: job.installer2 ?? '',
            product: job.productid ?? '',
            contract_date: job.contractdate ? new Date(job.contractdate).toISOString() : null,
            contract_id: job.contractid ?? '',
            raw_lp_data: job,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'lp_job_id' }
        );

      if (error) { console.error(`[Sync] Upsert error job ${lpJobId}:`, error.message); errors++; }
      else synced++;
    } catch (e: any) {
      console.error('[Sync] Job error:', e.message);
      errors++;
    }
  }

  console.log(`[Sync] Done. Synced: ${synced}, Errors: ${errors}`);
  return { synced, errors };
}
