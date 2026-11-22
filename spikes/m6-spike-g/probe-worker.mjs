// Spike G's probe: a Worker on the second account's existing workers.dev address, for the parts that must run inside
// a Worker. It lives for one run and is deleted at its end. The runner fills in the two constants below for the run.
//
// - It answers only a request carrying the run's header; anything else is a bare 404.
// - `/doh?name=<n>`: looks up `<n>`'s TXT through three DNS-over-HTTPS resolvers, each with a 5 s timeout, and
//   answers what each said. Only the run's two TXT names and a fixed list of public names are looked up.
// - `/doh-timeout`: one lookup with a 1 ms timeout, to show how a resolver that doesn't answer looks from here.
// - `/memory?case=<1-5>`: builds one upload body in memory the way the API's release job does, raw bytes and their
//   base64 held at once, then a copy as a request body, and answers its size. Fixed sizes only.
// - `/compress?nt=<0|1>`: 200 KB of compressible text, with `Cache-Control` with or without `no-transform`.
// It logs nothing.

const KEY = "__SPIKE_G_KEY__";
const RUN_TXT_NAMES = ["__SPIKE_G_TXT_A__", "__SPIKE_G_TXT_B__"];

const FIXED_NAMES = [
  "nothing-here-spike-g.invalid", // NXDOMAIN
  "dnssec-failed.org", // SERVFAIL
  "www.github.com", // a CNAME, then TXT owned by another name
  "cloudflare.com", // signed, many TXT
];
const RESOLVERS = [
  { id: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { id: "1.1.1.1", url: "https://1.1.1.1/dns-query" },
  { id: "dns.google", url: "https://dns.google/resolve" },
];
const MEMORY_CASES = {
  1: { files: 1, each: 5_000_000 }, // one file at the cap
  2: { files: 2, each: 4_194_304 }, // one request at the plan's 8 MiB
  3: { files: 5, each: 5_000_000 }, // a whole release at its 25 MB cap, as one body
  4: { files: 10, each: 5_000_000 }, // twice that
  5: { files: 20, each: 5_000_000 }, // four times that
};

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function lookup(resolver, name, timeoutMs) {
  const url = `${resolver.url}?name=${encodeURIComponent(name)}&type=TXT`;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const keep = (rr) => (rr ?? []).map((r) => ({ name: r.name, type: r.type, TTL: r.TTL, data: r.data }));
    return {
      resolver: resolver.id,
      http: res.status,
      type: res.headers.get("content-type"),
      ms: Date.now() - started,
      json: body && {
        Status: body.Status,
        TC: body.TC,
        AD: body.AD,
        Answer: keep(body.Answer),
        Authority: keep(body.Authority),
        Comment: body.Comment,
      },
    };
  } catch (e) {
    return { resolver: resolver.id, ms: Date.now() - started, error: e?.name ?? "Error" };
  }
}

function base64Of(bytes) {
  const parts = [];
  const step = 3 * 8_192;
  for (let i = 0; i < bytes.length; i += step) parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + step))));
  return parts.join("");
}

async function memory(c) {
  const started = Date.now();
  const files = [];
  for (let f = 0; f < c.files; f++) {
    const raw = new Uint8Array(c.each);
    for (let i = 0; i < raw.length; i += 65_536) crypto.getRandomValues(raw.subarray(i, Math.min(i + 65_536, raw.length)));
    files.push(raw);
  }
  // As the release job holds them: each file's bytes, and the bucket's body as base64 parts, at once.
  const boundary = "podster-release-upload";
  const parts = files.map((raw, f) => `--${boundary}\r\nContent-Disposition: form-data; name="f${f}"; filename="f${f}"\r\nContent-Type: application/octet-stream\r\n\r\n${base64Of(raw)}\r\n`);
  const text = `${parts.join("")}--${boundary}--\r\n`;
  const body = new TextEncoder().encode(text);
  // A copy as a request's body, read back, as a send would hold it.
  const copy = await new Request("https://spike-g.invalid/", { method: "POST", body }).arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return {
    files: c.files,
    raw_bytes: files.reduce((n, r) => n + r.length, 0),
    body_bytes: body.length,
    copy_bytes: copy.byteLength,
    digest_first_byte: digest[0],
    ms: Date.now() - started,
  };
}

export default {
  async fetch(request) {
    if (request.method !== "GET" || request.headers.get("x-spike-g-key") !== KEY) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    if (url.pathname === "/doh") {
      const name = url.searchParams.get("name");
      if (!RUN_TXT_NAMES.includes(name) && !FIXED_NAMES.includes(name)) return new Response(null, { status: 404 });
      return json({ name, answers: await Promise.all(RESOLVERS.map((r) => lookup(r, name, 5_000))) });
    }
    if (url.pathname === "/doh-timeout") {
      return json({ answers: await Promise.all(RESOLVERS.map((r) => lookup(r, "cloudflare.com", 1))) });
    }
    if (url.pathname === "/memory") {
      const c = MEMORY_CASES[url.searchParams.get("case")];
      if (!c) return new Response(null, { status: 404 });
      return json(await memory(c));
    }
    if (url.pathname === "/compress") {
      const line = "podster spike g: the same line again, so any compressor would shrink it a great deal.\n";
      const nt = url.searchParams.get("nt") === "1";
      return new Response(line.repeat(Math.ceil(200_000 / line.length)).slice(0, 200_000), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": nt ? "max-age=60, no-transform" : "max-age=60" },
      });
    }
    return new Response(null, { status: 404 });
  },
};
