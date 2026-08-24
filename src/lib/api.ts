/**
 * Thin fetch wrapper.
 *
 * Session tokens are no longer read or written by client JavaScript — they live
 * in an httpOnly cookie the browser attaches automatically. That removes the
 * `localStorage.getItem('v12_jwt_token')` calls that were scattered across four
 * components, and it means code executed in the REPL cannot steal the session.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Reads the double-submit CSRF token. This cookie is deliberately readable —
 * that is what lets us echo it in a header a cross-origin page cannot forge.
 * The session cookie remains httpOnly and is never touched here.
 */
function csrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)apex_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const token = UNSAFE_METHODS.has(method) ? csrfToken() : null;

  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-CSRF-Token': token } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError('Network unreachable. Check your connection and retry.', 0);
  }

  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof (body as any).error === 'string'
        ? (body as any).error
        : null) || `Request failed with status ${res.status}.`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(data ?? {}) }),
};
