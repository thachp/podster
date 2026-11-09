/**
 * Crawling is allowed so a crawler can read each public page's `noindex` (decision 156). A page it can't fetch could still be
 * listed from links alone, with nothing to say it shouldn't be.
 */
export function GET() {
  return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
