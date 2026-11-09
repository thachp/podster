# The test A2A server

A stand-in for an outside agent's A2A server, for M3's staging round trip and Spike C's staging half. It's option A from [#184](https://github.com/thachp/podster/pull/184), which the owner approved on 2026-11-09: one Worker, `podster-a2a-test-staging`, on `workers.dev`, on the account that holds `podster.dev`. It has no bindings, KV, D1 or Durable Object, and its logs are off.

It isn't an independent implementation, so it doesn't count for [decision 143](../../docs/spec/PRODUCT.md#decisions-needed). LangGraph does that ([../langgraph](../langgraph)).

| File | What it is |
| --- | --- |
| `worker.mjs` | The server: `SendMessage`, `GetTask` and `CancelTask`, plus Spike C's slow and redirecting paths |
| `seal.mjs` | Sealing a run's values into the bearer, and the signature check, on WebCrypto. Shared with the run script |
| `selftest.mjs` | Its rules, checked in Node with no network: `node a2a-test-server/selftest.mjs` |
| `wrangler.jsonc` | The Worker. Staging only |

## How a run's values reach it

The server holds one secret, `RUN_KEY`, which the owner sets once. Each run then works like this:

1. The run seals the endpoint's signing secret, the agent's `/a2a` token and an expiry at most 1 hour away under `RUN_KEY`, with AES-256-GCM. The server refuses a bearer that has expired or claims to live longer.
2. It sets the sealed value as the endpoint's bearer token, so Podster stores it sealed again and sends it with every request.
3. The server opens the bearer and checks `X-Podster-Signature` with the signing secret inside, as a real agent would.

So no Worker secret is set per run. Without `RUN_KEY` nobody can make a bearer the server accepts, so nobody can choose the secret it checks against. The signature still proves Podster sent the request. A missing, expired, altered or foreign bearer is refused with 401, and so is a wrong, stale or malformed signature.

The run reads `RUN_KEY` from `~/.config/podster/a2a-test-run.key`, mode 600. To set it on the Worker, which only the owner does:

```bash
CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev> ~/repos/podster/apps/gateway/node_modules/.bin/wrangler secret put RUN_KEY --name podster-a2a-test-staging < ~/.config/podster/a2a-test-run.key
```

## What it answers

- **`SendMessage`** answers a `SUBMITTED` task.
  - For an offer, it first makes one GET of the first `/a2a/files` link on `GATEWAY_URL`, with the `/a2a` token from the bearer. It follows no redirects and gives up after 5 s.
  - For a change request, which has `referenceTaskIds`, it makes a new task in the referenced task's context.
- **`GetTask`** answers `WORKING` on read 1, read from the JSON-RPC id `<attempt>:<read>`. From read 2 on, it answers `COMPLETED`, with one artifact holding:
  - a note naming the download's HTTP status and the first 12 hex characters of the bytes' SHA-256;
  - when Podster's send reached it;
  - for a change request, which task it changes and the `contextId` it arrived with;
  - one `example.com` URL.
- **`CancelTask`** answers `CANCELED`.

It keeps nothing. What a later read needs is in the task ID it handed out. `GET /ready` says whether `RUN_KEY` is set, with a short check value.

For Spike C, two more paths are checked the same way first:
- `/a2a/slow` waits 15 s, past Podster's 10 s send timeout;
- `/a2a/redirect` answers 302 to the cloud metadata address.

## Running it

```bash
cd e2e && PODSTER_E2E_SIGNUP_SECRET="$(cat ~/.config/podster/e2e-signup.secret)" node a2a-roundtrip.mjs
```

It takes about 13 minutes. It deletes its agents' endpoints and disconnects them at the end.

## Deploying and removing it

```bash
cd e2e/a2a-test-server && CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev> ../../apps/gateway/node_modules/.bin/wrangler deploy -c wrangler.jsonc
```

```bash
CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev> ~/repos/podster/apps/gateway/node_modules/.bin/wrangler delete podster-a2a-test-staging
```

Deleting it also removes `RUN_KEY`.
