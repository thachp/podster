// What every public response carries, a not-found and a refusal included (ADR 0008, M4-11). The page has no script, so its
// own CSP allows none, and it loads only its stylesheet from this host.
export const PUBLIC_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export const PUBLIC_HEADERS: [string, string][] = [
  ["Content-Security-Policy", PUBLIC_CSP],
  ["X-Robots-Tag", "noindex, nofollow"],
  ["Cache-Control", "no-store"],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "same-origin"],
];

export function publicResponse(body: string, status: number, contentType = "text/html; charset=utf-8", extra: [string, string][] = []): Response {
  const headers = new Headers([...PUBLIC_HEADERS, ["Content-Type", contentType], ...extra]);
  return new Response(body, { status, headers });
}
