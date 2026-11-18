/**
 * The key's RFC 7638 thumbprint, the same value Podster's confirm screen shows: the base64url SHA-256 of the key's
 * required members, in lexicographic order with no whitespace. For an Ed25519 key those are `crv`, `kty` and `x`.
 * Computed here from the public key itself, never taken from its `kid`.
 */
export type PublicKey = { kty?: string; crv?: string; x?: string };

const base64url = (bytes: ArrayBuffer) => {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function thumbprintOf(key: PublicKey): Promise<string> {
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x)) {
    throw new Error("not an Ed25519 public key");
  }
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x });
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

/** The whole thumbprint in groups of four, as the confirm screen shows it. The groups are only spacing. */
export const grouped = (thumbprint: string) => thumbprint.match(/.{1,4}/g)?.join(" ") ?? thumbprint;
