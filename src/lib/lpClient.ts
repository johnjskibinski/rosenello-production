import axios from 'axios';
import qs from 'qs';
import { env } from '../config/env';

interface TokenCache {
  token: string;
  expiresAt: number;
}

const LP_BASE = 'https://api.leadperfection.com';
let tokenCache: TokenCache | null = null;

export async function getLPToken(): Promise<string> {
  const now = Date.now();

  if (tokenCache && tokenCache.expiresAt > now + 30 * 60 * 1000) {
    return tokenCache.token;
  }

  const response = await axios.post(
    `${LP_BASE}/token`,
    qs.stringify({
      grant_type: 'password',
      username: env.lp.username,
      password: env.lp.password,
      clientid: env.lp.clientId,
      appkey: env.lp.appKey,
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
    }
  );

  const token = response.data.access_token;
  if (!token) throw new Error('No access_token: ' + JSON.stringify(response.data).slice(0, 200));

  tokenCache = {
    token,
    expiresAt: now + 23.5 * 60 * 60 * 1000,
  };

  console.log('[LP] Token refreshed');
  return token;
}

export async function lpPost(endpoint: string, body: Record<string, any> = {}): Promise<any> {
  const token = await getLPToken();
  const url = `${LP_BASE}/api/${endpoint}`;
  console.log('[LP] POST', url, body);

  // Convert all values to strings like Apps Script does
  const formData = new URLSearchParams();
  for (const [key, val] of Object.entries(body)) {
    formData.append(key, String(val ?? ''));
  }

  const response = await axios.post(
    url,
    formData.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      maxRedirects: 0,
      validateStatus: (status) => status < 600,
    }
  );

  console.log('[LP] Response status:', response.status);
  if (response.status >= 400) {
    throw new Error(`LP API ${endpoint} failed (HTTP ${response.status}): ${JSON.stringify(response.data).slice(0, 300)}`);
  }

  return response.data;
}
