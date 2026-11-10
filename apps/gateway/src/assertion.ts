import { importJWK, SignJWT, type JWK } from "jose";

export const KEY_ID_DEFAULT = "gateway-1";

/** Who the caller is, never what they may do. */
export type Identity =
  | { kind: "agent"; id: string; org: string; generation: number; spends?: { key: string; expiresAt: number }; linker?: { person: string; since: number } }
  | { kind: "person"; id: string; org: string; orgs: string[]; adminOrgs: string[]; orgSince: Record<string, number>; targetMember?: { person: string; orgs: Record<string, number> }; departure?: { person: string; org: string; left_at: number } };

let cached: { source: string; key: CryptoKey | Uint8Array; kid: string } | undefined;

async function signingKey(jwkJson: string) {
  if (cached?.source !== jwkJson) {
    const jwk = JSON.parse(jwkJson) as JWK;
    cached = { source: jwkJson, key: (await importJWK(jwk, "EdDSA")) as CryptoKey, kid: jwk.kid ?? KEY_ID_DEFAULT };
  }
  return cached;
}

export async function mintAssertion(identity: Identity, jwkJson: string): Promise<string> {
  const { key, kid } = await signingKey(jwkJson);
  const claims = identity.kind === "agent"
    ? { kind: "agent", org: identity.org, gen: identity.generation, ...(identity.spends ? { agent_jti: identity.spends.key, agent_jti_exp: identity.spends.expiresAt } : {}), ...(identity.linker ? { linker: identity.linker } : {}) }
    : { kind: "person", org: identity.org, orgs: identity.orgs, admin_orgs: identity.adminOrgs, org_since: identity.orgSince, ...(identity.targetMember ? { target_member: identity.targetMember } : {}), ...(identity.departure ? { departure: identity.departure } : {}) };
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer("podster-gateway")
    .setAudience("podster-api")
    .setSubject(identity.id)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(key);
}

/**
 * The public room page's assertion (ADR 0008): `kind: "public"`, with no subject, organization or anything else. Only
 * `PublicReads` mints it, from nothing a client sends, and the API takes it on that one route.
 */
export async function mintPublicAssertion(jwkJson: string): Promise<string> {
  const { key, kid } = await signingKey(jwkJson);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "public" })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer("podster-gateway")
    .setAudience("podster-api")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(key);
}

/**
 * A provider webhook delivery's assertion (M5 step 5, ADR 0009): `kind: "provider_delivery"`, the provider, its delivery ID
 * and the SHA-256 of the exact body sent with it. It names no one. Only the webhook route mints it, after the provider's
 * signature checks out, and the API takes it on its one delivery route.
 */
export async function mintProviderDelivery(provider: "github", delivery: string, bodySha256: string, jwkJson: string): Promise<string> {
  const { key, kid } = await signingKey(jwkJson);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: "provider_delivery", provider, delivery, body_sha256: bodySha256 })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer("podster-gateway")
    .setAudience("podster-api")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(key);
}
