# Deploying to staging

Staging runs at `gateway-staging.podster.dev`, on the Cloudflare account that holds `podster.dev`.

## Running locally

The gateway's default `BASE_URL` is the production hostname, and a deployment on HTTPS redirects HTTP to it, so a plain `wrangler dev` would send your browser to production. Put this in `apps/gateway/.dev.vars`, which git ignores, before you start it:

```bash
BASE_URL=http://localhost:8787
```

This only stops the redirect. A working local run also needs `AUTH_SECRET` and `ASSERTION_SIGNING_JWK` there, local D1 migrations, and the API Worker running with a matching `ASSERTION_KEYS`.

An OAuth client's redirect URI can't be on the gateway's own hostname, whatever the port, so a gateway on `http://localhost:8787` refuses `http://localhost:*` redirects. Use `http://127.0.0.1:<port>` for a local client.

## Before you start

- Node, and `npm ci` in `apps/gateway` and `apps/api`.
- Rust and `worker-build` 0.8.7, because deploying the API builds it: `cargo install worker-build --version 0.8.7 --locked`.
- `npx wrangler login` from an app folder, or `CLOUDFLARE_API_TOKEN` in your shell.
- The account ID in your shell. It stays out of this repo.

```bash
export CLOUDFLARE_ACCOUNT_ID=<the account that holds podster.dev>
```

Run every `wrangler` command from the app folder named in its step, so it uses that app's pinned version.

## First deploy

This has been done once for staging, so it's kept here for rebuilding it, and as the outline for production. To ship a change, apply any new migrations, then run `npx wrangler deploy --env staging` from the app that changed, with the API first if both did.

### 1. Register the GitHub OAuth app

In GitHub, go to Settings, then Developer settings, then OAuth Apps. Use these values, and keep the client ID and secret for step 6:

- **Homepage URL:** `https://gateway-staging.podster.dev`
- **Authorization callback URL:** `https://gateway-staging.podster.dev/api/auth/callback/github`

### 2. Create the databases and KV namespace

From `apps/gateway`. If wrangler offers to add a binding to your config, answer no, because it would write to the top level and not to `env.staging`.

```bash
npx wrangler d1 create podster-gateway-staging
```

```bash
npx wrangler kv namespace create podster-oauth-staging
```

From `apps/api`, again answering no:

```bash
npx wrangler d1 create podster-api-staging
```

```bash
npx wrangler queues create podster-wake-staging
```

A2A offers have their own queue and dead-letter queue ([decision 129](spec/PRODUCT.md#decisions-needed), M3 step 12). The owner created both on 2026-11-08:

```bash
npx wrangler queues create podster-a2a-staging
```

```bash
npx wrangler queues create podster-a2a-dlq-staging
```

Staging's IDs are already in the two `wrangler.jsonc` files. If you ever recreate these, put the new IDs under `env.staging` there.

### 3. Apply migrations

From `apps/gateway`:

```bash
npx wrangler d1 migrations apply podster-gateway-staging --remote --env staging
```

From `apps/api`:

```bash
npx wrangler d1 migrations apply podster-api-staging --remote --env staging
```

### 4. Generate the assertion keys

The gateway signs with the private key, and the API verifies with the public half. This prints both, in the formats each Worker needs. Don't save the output in the repo.

```bash
node --input-type=module -e "import {generateKeyPairSync as g} from 'node:crypto';const {publicKey:p,privateKey:s}=g('ed25519');const kid='gateway-1';console.log('ASSERTION_KEYS='+JSON.stringify({[kid]:p.export({format:'jwk'}).x}));console.log('ASSERTION_SIGNING_JWK='+JSON.stringify({...s.export({format:'jwk'}),kid}))"
```

### 5. Deploy the API

The gateway's service binding needs the API to exist. From `apps/api`, paste the `ASSERTION_KEYS` value when asked:

```bash
npx wrangler secret put ASSERTION_KEYS --env staging
```

```bash
npx wrangler deploy --env staging
```

### 6. Deploy the gateway, then set its secrets

From `apps/gateway`:

```bash
npx wrangler deploy --env staging
```

The domain goes live on this deploy, and that's safe before the secrets are set. Without `AUTH_SECRET`, anything using sign-in, sessions or claims fails rather than using a default secret. OAuth discovery, `/oauth/register` and `/mcp`'s 401 still answer, and no token can exist yet.

Paste each value when asked. For `AUTH_SECRET`, generate one first with `openssl rand -base64 32`.

```bash
npx wrangler secret put AUTH_SECRET --env staging
```

```bash
npx wrangler secret put ASSERTION_SIGNING_JWK --env staging
```

```bash
npx wrangler secret put GITHUB_CLIENT_ID --env staging
```

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --env staging
```

## Deploying the dashboard

The dashboard runs at `app-staging.podster.dev`. Its build reads the environment, so set it when building, and deploy the file the build writes. From `apps/web`:

```bash
CLOUDFLARE_ENV=staging npm run build
```

```bash
npx wrangler deploy --config dist/server/wrangler.json
```

Deploy in the order API, gateway, web. The gateway's `APP_URL` moves sign-in to the application host, so GitHub's callback has to be `https://app-staging.podster.dev/api/auth/callback/github`. An OAuth app has one callback host, so sign-in fails until the two match.

## Email sign-in

Sign-in links go through Cloudflare Email Service, and [ADR 0004](adr/0004-email-sign-in.md) has the rules. It's off until `ENABLE_EMAIL_SIGNIN`, the `EMAIL` binding, `EMAIL_FROM` and `APP_URL` are all set, which only `env.staging` does. There are no secrets or migrations. The sender is `sign-in@podster.dev`.

Before the first deploy, check these in the Cloudflare dashboard, under Compute, then Email Service:

- `podster.dev` is onboarded on this account. Until a domain is onboarded, mail only reaches verified addresses.
- Whether Email preview is on. It's on by default for new sending domains, and keeps messages about seven days, including sign-in links that will have expired.

And check that nobody has an unproven email. A link refuses such a row, so that person would only get the notice. From `apps/gateway`, this should say 0:

```bash
npx wrangler d1 execute podster-gateway-staging --remote --env staging --command "SELECT COUNT(*) AS unproven FROM \"user\" WHERE emailVerified = 0"
```

Deploy the gateway before the web Worker, because the web Worker's `SIGN_IN_PROVIDERS` is what shows the option, and asking answers 404 until the gateway has it. Then check on staging, with a mailbox you own:

1. A link arrives, from `sign-in@podster.dev`, and doesn't land in spam.
2. Its button signs you in on `app-staging.podster.dev`, and you have a personal organization.
3. The same link used again goes back to the sign-in page with an error.
4. An address that signs in with GitHub gets the notice, and no link.
5. `POST https://gateway-staging.podster.dev/api/auth/sign-in/magic-link` answers 404.
6. Pasting `https://app-staging.podster.dev/api/auth/magic-link/verify?token=<a fresh token>&callbackURL=%2Fattention` into the address bar goes to the sign-in page with an error and starts no session. The same token then still works from its emailed link's button. This also shows a real browser sends `same-origin` and the referrer from that form, so try Safari too.
7. Asking twice from one browser and then from another network shows the per-client limit counts real addresses, which means `cf-connecting-ip` survived the service binding. If every client shares one count, it didn't.
8. Clicking one link's button in several tabs at once starts one session, which shows a token stays single-use on real D1.

To turn it off, remove `email` from the web Worker's `SIGN_IN_PROVIDERS` and `ENABLE_EMAIL_SIGNIN` from the gateway's vars, then deploy both.

## Test people for the journey

The journey needs two separate people, and staging can make its own when a run has no second human. It's off until all of these hold, and otherwise the route answers like any other private auth route, with a 404:

- `ENABLE_E2E_SIGNUP` is `true`. It's set only under `env.staging` in `apps/gateway/wrangler.jsonc`, and a test fails if the top level or any other environment sets it.
- `BASE_URL` and the request's URL are both exactly `https://gateway-staging.podster.dev`. It doesn't answer on the application host.
- `E2E_SIGNUP_SECRET` is set, at least 32 characters, and sent as a bearer token. It's compared in constant time.

To turn it on, from `apps/gateway`, once a build with the route is deployed. Paste the output of `openssl rand -hex 32` when asked:

```bash
npx wrangler secret put E2E_SIGNUP_SECRET --env staging
```

Turn it off as soon as a run's result is recorded, and set a new secret for the next run. This takes effect at once:

```bash
npx wrangler secret delete E2E_SIGNUP_SECRET --env staging
```

`POST /api/auth/sign-up/e2e` takes no input. Each use makes a new person and answers with their session cookie. The session ends after two hours, and refreshing doesn't move that. It's limited to 6 people a minute and 40 a day across all clients, and wrong guesses count under the limit per client that other sign-up routes have. Password sign-in stays off for everything else, and nobody ever sees a test person's password, so they can't be signed in to again, and no request can name, sign in as or link to anyone else.

Test people are easy to tell apart, and only this route can make them:

| Where | What marks them |
| --- | --- |
| Directory: `user` | The ID starts `e2e_`, the email ends `@e2e.podster.invalid`, and the name starts `E2E test person` |
| Directory: `organization`, `org_member`, `identity_link`, and the API's audit log and events | The person's ID starts `per_e2e_`. A Better Auth ID has no underscore, so a real person's never does. A personal organization has the person's name too |

Agents and rooms have no mark of their own, so find them through the person who owns them. Staging has no delete route, so these rows stay. From `apps/gateway`, this lists the people:

```bash
npx wrangler d1 execute podster-gateway-staging --remote --env staging --command "SELECT id, email, createdAt FROM \"user\" WHERE email LIKE '%@e2e.podster.invalid'"
```

## After a deploy

Run the journey in the [kernel success criteria](spec/PRODUCT.md#coordination-kernel-success-criteria) against the real hostname, and probe that the API has no public route.

## The scanner's secret

The API and `apps/scanner` share `SCANNER_SECRET`. It's a random value, such as the output of `openssl rand -hex 32`, set to the same value on both Workers. Until both have it, nothing can record a verdict, so every file ends as `failed` after an hour, which is the safe way round. A value with whitespace at either end counts as unset, and the API logs `scan.secret_unset`. Deploy the scanner with the API: the API refuses a clean report that doesn't name the file's key, and an older scanner doesn't send one, so its files would end as `failed`.

```bash
cd apps/api && npx wrangler secret put SCANNER_SECRET --env staging
```

```bash
cd apps/scanner && npx wrangler secret put SCANNER_SECRET --env staging
```

## The API's resources on staging

What `apps/api/wrangler.jsonc` binds under `env.staging`, and the secrets it reads. Everything here is on the account that holds `podster.dev`.

| Kind | Name | What it's for |
| --- | --- | --- |
| D1 | `podster-api-staging` | The listing read model. It never authorizes |
| R2 | `podster-assets-staging` | Uploaded files, private, reached only through the API |
| Queue | `podster-wake-staging` | Wake nudges, produced and consumed by the API |
| Queue | `podster-scan-staging` | Upload scans, produced by the API and consumed by the scanner |
| Queue | `podster-a2a-staging` | A2A offers, IDs only, produced and consumed by the API. Five retries, then the dead-letter queue |
| Queue | `podster-a2a-dlq-staging` | A2A offers whose retries ran out. Its consumer logs their IDs and acknowledges them |
| Secret | `ASSERTION_KEYS` | The gateway's assertion public keys |
| Secret | `SCANNER_SECRET` | The scanner's shared secret |
| Secret | `A2A_TOKEN_KEY` | Seals A2A endpoint bearer tokens. The owner set it on 2026-11-08 |
| Var | `APP_URL` | `https://app-staging.podster.dev`, for the link in an A2A offer |
| Var | `GATEWAY_URL` | `https://gateway-staging.podster.dev`, for the input-file links in an A2A offer, which the agent opens with its own credential |

## The A2A token key

`A2A_TOKEN_KEY` is the key the API seals agents' A2A endpoint bearer tokens with ([decision 122](spec/PRODUCT.md#decisions-needed), ADR 0007). It's 64 hex characters, such as the output of `openssl rand -hex 32`. **The owner sets it**, in that session, and nobody else does. Until it's set, or if it isn't 64 hex characters, an agent can still register an endpoint, and setting a token answers 503 `token_storage_unavailable`. Changing the key makes every stored token unopenable: those endpoints send nothing until their token is set again.

```bash
cd apps/api && npx wrangler secret put A2A_TOKEN_KEY --env staging
```

## Operators

`OPERATORS` names Podster's operators (M4 step 10, decision 158): their person IDs, separated by commas. An operator can suspend and lift a room's public surface and an agent's public claims, and reads reports. **The owner names them and runs this**, and nobody else does. It's unset until then, and while it's unset nobody is an operator, so every moderation route answers `not_allowed`.

Operators work from `/moderation` on the dashboard. For anyone else, that page answers not found.

```bash
cd apps/api && npx wrangler secret put OPERATORS --env staging
```

## Explore's cursor key

`EXPLORE_CURSOR_KEY` seals Explore's cursors (M4 step 14): 64 hex characters, such as the output of `openssl rand -hex 32`. **The owner sets it**, and nobody else does. Until then Explore shows its first page only and refuses any cursor, so it's needed before `PUBLIC_ROOMS` is switched on. Changing it later only ends cursors already handed out.

```bash
cd apps/api && npx wrangler secret put EXPLORE_CURSOR_KEY --env staging
```

## Checking uploads on staging

`e2e/upload-check.mjs` sends real uploads down the deployed path, so it shows what the edge does with a chunked upload, which local runs can't. It needs a person's session cookie, and it leaves a room named "Upload check" behind.

```bash
cd e2e && PODSTER_E2E_COOKIE_A='<cookie>' node upload-check.mjs --base-url https://gateway-staging.podster.dev --big
```

**CPU time:** a Worker can't read its own, because its clock doesn't move while it computes. Read it from the platform, with this running while the check does:

```bash
cd apps/api && npx wrangler tail podster-api --env staging --format json --search upload.stored
```

Each stored file logs one `upload.stored` line, with the object ID, bytes, chunks and wall time. Compare the invocation's CPU time with the limit, which is 30 seconds unless `limits.cpu_ms` raises it. An outcome of `exceededCpu` means it went over.

## Checking M2 on staging

`e2e/m2-staging.mjs` is the start of M2 step 11's staging run. It uploads through the gateway and waits for the scanner's verdicts: a clean text file has to become `ready`, and the EICAR test string `blocked`. Then it downloads the clean file as a person and as an agent, checking the bytes and the file headers, and checks the refusals: a blocked file, an unknown file, someone outside the room, no credential, an executable, a file over 100 MB and a wrong hash. Then it runs steps 5 to 8: an input asset linked to a guest agent's task, which only then sees and downloads it, a submission with a file that the reviewer reads by its exact hash and approves, approval refused once a submitted file is removed, an expected output made ready by that approval that stays ready with `files_available` false after its file is removed, and removal answering 410 `file_removed`. Three cases are listed as skipped. Approval refused after a submitted file is blocked is one, because only a later scan can block a file that's already ready, and a run can't cause that scan. The others are the hour sweep and load. Without `--big`, the 100 MB case is skipped too. `--big` adds a 100 MB file through the scanner, retried once with a fresh token if the network fails, and a network failure reports its cause rather than only "fetch failed". It leaves a room named "M2 staging" and its files behind.

With staging's test sign-up, as for the journey:

```bash
cd e2e && PODSTER_E2E_SIGNUP_SECRET='<secret>' node m2-staging.mjs --base-url https://gateway-staging.podster.dev
```

A verdict waits up to 300 s by default, for a Container that may be starting cold. `--verdict-wait-s` changes that. Read the scanner's side while it runs:

```bash
cd apps/scanner && npx wrangler tail --env staging --format json
```

Locally, `node run-m2-staging.mjs` runs it against the local stack with a stand-in for the scanner. The stand-in reports the EICAR string as a finding and anything else as clean, so a local run checks the queue message, the verdict route and downloads, but not ClamAV or the Container. It also checks that no file name, token, scanner secret or finding reached the Workers' logs.

