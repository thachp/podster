# Spike B: a separate A2A audience

M3's second spike, from the [M3 plan](../../docs/m3-plan.md#spikes). It's a throwaway experiment, local only ([decision 126](../../docs/spec/PRODUCT.md#decisions-needed)), and not product code. It asks whether the gateway's OAuth package, `@cloudflare/workers-oauth-provider` 1.2.4, can issue tokens for a second resource, `/a2a`, with its own scope. Those tokens must belong to the same agent identity and consent as `/mcp` ([decision 111](../../docs/spec/PRODUCT.md#decisions-needed)), and AC-12's wrong-audience refusals must hold both ways.

```bash
npm install
npm test                          # 9 tests in workerd
npm run dev                       # then, in another shell:
node clients/oauth-then-a2a.mjs
```

## What it is

- **One Worker,** with one `OAuthAuthorizationServer` declaring two resources, `/mcp` and `/a2a`. Each is hosted by its own `OAuthResourceServer`. The gateway today uses the combined `OAuthProvider`, which has one resource, so every route it protects shares one audience.
- **`defaultResource` and `legacyGrantResource` are both `/mcp`,** so a client that leaves `resource` out, and grants stored before the change, stay MCP.
- **A stand-in consent page** approves one test person at once. It grants only the scope that matches the resource, `mcp` or `a2a`, with the same `externalId` either way, which is what the gateway resolves to a Podster agent.
- **`/v1/files`** repeats the gateway's download check: the token's own record has to have an `/mcp` audience and the `mcp` scope.
- **`/spike/disconnect`** revokes every grant the person holds, as the gateway's disconnect does.

## Results, 2026-11-08 UTC

| Check | Result |
| --- | --- |
| Tests in workerd (`npm test`), each a full authorization-code flow with PKCE | **9 passed** |
| An `/a2a` token works at `/a2a` and resolves to the same agent | Passed |
| An `/a2a` token at `/mcp` or `/v1/files` | 401 at both |
| An `/mcp` token at `/a2a` | 401. It still works at `/mcp` and `/v1/files` |
| A client that leaves `resource` out | Gets an `/mcp` token, as today |
| An `/a2a` request that also asks for `mcp` scope | Granted `a2a` only, and refused at `/mcp` |
| Refreshing an `/a2a` token with `resource=/mcp` | 400 `invalid_target`. A grant can't be moved to another resource |
| An unknown resource | Refused before consent |
| An unauthenticated `/a2a` call | 401 whose challenge names `/.well-known/oauth-protected-resource/a2a`, which publishes `/a2a` as its resource |
| Disconnect | Both kinds of token stop working, downloads included |
| A standard OAuth client, then the A2A SDK client, against `wrangler dev` (`clients/oauth-then-a2a.mjs`) | **10 passed**. The MCP SDK's generic OAuth flow (discovery from the 401, registration, PKCE, `resource`) got an `/a2a` token unpatched, and the A2A JavaScript client used it. An `/mcp` token was refused there |

## Findings

1. **The package can do it, but not in the shape the gateway uses now.** The combined `OAuthProvider` takes one `resourceMetadata.resource`, so `/mcp` and `/a2a` would share an audience. Step 7 has to move the gateway to `OAuthAuthorizationServer` with two `OAuthResourceServer`s, still in one Worker. The gateway then owns the routing, and calls `getOAuthApi(env)` where it uses `env.OAUTH_PROVIDER` today. That's a larger change to `apps/gateway/src/index.ts` than the plan assumed, so step 7 should be its own PR with the deeper security pass [decision 127](../../docs/spec/PRODUCT.md#decisions-needed) already requires.
2. **Two resources change what a client gets when it leaves `resource` out.** With one resource, the package picks it. With two, it refuses the request unless `defaultResource` is set. So `defaultResource: /mcp` is required, or today's MCP clients that don't send `resource` would stop working.
3. **Old grants need `legacyGrantResource: /mcp`.** The gateway's `forMcp` treats a token with no audience as an old MCP grant. That must stay MCP-only, and the A2A path must never accept a token without an audience. The setting is in the spike, but I couldn't make an old, unbound grant to test it with.
4. **Neither A2A SDK runs OAuth itself.** The JavaScript client takes headers through `createAuthenticatingFetchWithRetry`, and the Python client takes an `AuthInterceptor`, so the agent's own code gets the token. Any standard OAuth 2.1 client that does RFC 9728 discovery and RFC 8707 `resource` works, as the MCP SDK's did here. The profile should say so, and name the scope `a2a`.
5. **The consent page has to know the resource.** The gateway's consent code refuses any scope other than `mcp` and `offline_access`. It has to grant `a2a` for an `/a2a` request, and say on screen that the agent will act over A2A.
6. **The card can point clients at the flow.** Its `oauth2SecurityScheme` names the authorization server's metadata URL and an authorization-code flow with PKCE. The SDK clients don't act on it, though, so it's for the agent's own code.
7. **Don't export anything but the handler from a Worker's entry module.** workerd reads every export as an entrypoint, and an exported string stopped `wrangler dev` from starting. Tests didn't catch this.

## Not proven

- **Nothing ran on a deployment.**
- **No real consent page or sign-in:** the stand-in approves at once.
- **An old grant with no stored resource,** which finding 3 is about. There's no way to make one with 1.2.4.
- **Agent Auth JWTs on `/a2a`.** They're refused simply because `/a2a` accepts only these OAuth tokens. [Decision 111](../../docs/spec/PRODUCT.md#decisions-needed) leaves them out at first.
- **The gateway's real `resolveAgent`, rate limits and the API.** The token resolves to a fixed `externalId`, and nothing calls Rust.
