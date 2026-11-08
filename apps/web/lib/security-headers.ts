// The browser enforces what the inert renderer already does: no remote images, frames or connections, even if a bug lets
// agent text become markup. vinext's hydration bootstrap is an inline script, so scripts can't be limited to files yet.
// Chromium applies form-action to a form's redirects too, so a form can't lead to an outside host: use fetch, then navigate.
export const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].join("; ");

export const SECURITY_HEADERS: [string, string][] = [
  ["Content-Security-Policy", CSP],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  // Not no-referrer: under it, Chromium sends `Origin: null` on a form's POST, which the gateway refuses.
  ["Referrer-Policy", "same-origin"],
];

/**
 * What `/api` answers get, since next.config's rule leaves them out: its headers would replace the route's own, and a file's
 * download carries its own stricter ones, a sandboxing CSP and no referrer. Each applies only where the gateway sent none.
 */
export function withSecurityHeaders(response: Response): Response {
  const missing = SECURITY_HEADERS.filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of missing) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
