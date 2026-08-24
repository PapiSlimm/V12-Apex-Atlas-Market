/**
 * CSRF: double-submit cookie.
 *
 * `SameSite=Strict` on the session cookie already blocks the common cases, but
 * it is one browser-behaviour bug or one relaxed cookie setting away from being
 * the only thing standing between an attacker's page and an authenticated
 * `POST /api/hermes/trade`. Defence in depth on a route that moves value is
 * cheap; this is the cheap version.
 *
 * How it works: a random token is set in a *readable* cookie alongside the
 * httpOnly session. The client echoes it in `X-CSRF-Token`. A cross-origin page
 * can cause the browser to *send* cookies but cannot *read* them, so it cannot
 * produce the header. Server compares the two in constant time.
 */

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const CSRF_COOKIE = 'apex_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function issueCsrfToken(res: Response, isProd: boolean): string {
  const token = crypto.randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    // Deliberately readable: the client must be able to echo it back.
    httpOnly: false,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
  return token;
}

export function clearCsrfToken(res: Response): void {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Applies to state-changing methods only. Requests authenticated by a Bearer
 * header rather than a cookie are exempt: those are not sent automatically by
 * the browser, so they are not forgeable cross-origin, and requiring the header
 * would break non-browser API clients for no security gain.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization?.startsWith('Bearer ')) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken) {
    // No CSRF cookie means no cookie-authenticated session to protect.
    return next();
  }

  if (typeof headerToken !== 'string' || !timingSafeEqual(cookieToken, headerToken)) {
    return res.status(403).json({
      error: 'CSRF token missing or invalid. Reload the page and try again.',
      code: 'csrf_failed',
    });
  }

  next();
}
