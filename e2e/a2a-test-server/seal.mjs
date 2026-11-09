// How a run's values reach the test A2A server without a Worker secret per run. The server holds one long-lived key, RUN_KEY,
// that the owner sets once. Each run seals what the server needs (the endpoint's signing secret, the agent's `/a2a` token and
// an expiry) under that key with AES-256-GCM, and sets the sealed value as the endpoint's bearer token. Podster stores it
// sealed again and sends it on every request. The server opens it, then checks `X-Podster-Signature` with the signing
// secret inside, exactly as a real agent would.
//
// Nobody without RUN_KEY can make a bearer the server accepts, so nobody can choose the signing secret it checks against.
// The signature still proves Podster sent the request. Shared by the server and e2e/a2a-roundtrip.mjs, on WebCrypto only.

const PREFIX = "a2atest1.";
const AAD = new TextEncoder().encode("podster-a2a-test-server:bearer:v1");

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** RUN_KEY is 64 hex characters. */
export async function runKey(hex) {
  if (!/^[0-9a-f]{64}$/.test(hex ?? "")) throw new Error("RUN_KEY must be 64 lowercase hex characters");
  const raw = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** A bearer token holding `{ s: signing secret, a?: /a2a token, x: expiry in unix seconds }`. */
export async function seal(key, values) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(values));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return PREFIX + b64url(out);
}

/** The values in a bearer, or null if it isn't one this key made, or it has expired. */
export async function open(key, bearer, nowSeconds) {
  if (typeof bearer !== "string" || !bearer.startsWith(PREFIX) || bearer.length > 4096) return null;
  try {
    const bytes = unb64url(bearer.slice(PREFIX.length));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: AAD }, key, bytes.slice(12));
    const values = JSON.parse(new TextDecoder().decode(plain));
    if (typeof values?.s !== "string" || !Number.isInteger(values?.x) || values.x < nowSeconds) return null;
    return values;
  } catch {
    return null;
  }
}

/** A value both sides can compare to show they hold the same RUN_KEY, without showing it. */
export async function keyCheck(hex) {
  const raw = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  const mac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode("podster-a2a-test-server:key-check")));
  return [...out.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `X-Podster-Signature`'s value for a body at a time, as `crates/egress::sign` makes it: `t=<unix>,v1=<hex HMAC-SHA256>`. */
export async function sign(secret, unixSeconds, body) {
  const mac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`${unixSeconds}.${body}`)));
  return `t=${unixSeconds},v1=${[...out].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether a signature header is good for this body, within `skew` seconds of now. Compared in constant time. */
export async function verify(secret, header, body, nowSeconds, skew = 300) {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const at = Number(match[1]);
  if (Math.abs(nowSeconds - at) > skew) return false;
  const expected = (await sign(secret, at, body)).split("v1=")[1];
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ match[2].charCodeAt(i);
  return diff === 0;
}
