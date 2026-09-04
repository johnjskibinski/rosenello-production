import type { Request, Response, NextFunction } from 'express';

/**
 * Requires the shared secret on every /api request.
 * The Next.js proxy (app/api/proxy) attaches it server-side, so it never
 * reaches the browser.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    console.error('[Auth] API_KEY is not set — rejecting request.');
    return res.status(500).json({ error: 'Server auth is not configured' });
  }

  const supplied = req.header('x-api-key');
  if (typeof supplied === 'string' && supplied.length === apiKey.length && supplied === apiKey) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}
