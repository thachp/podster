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

## Shipping a change

Agents deploy with `scripts/deploy-staging`, and not by hand. It takes main's tip once its CI has passed, applies only the migrations you name, deploys the API, then the gateway, then with `--web` the dashboard, and ends with the signed-out probes in `scripts/staging-probes`. Once the owner has set the gateway's `GITHUB_WEBHOOK_SECRET`, give either script `--webhook-secret-set`: the webhook probe then wants 401 `invalid_signature` for an unsigned delivery, and without the flag it wants the 404 of an unset secret. Each case accepts its own answer only. `scripts/deploy-staging --help` lists what it refuses. It sets no secret or variable, and doesn't deploy the scanner.

The steps below are what it follows. They stay here as the reference, and for rebuilding staging.

**Deploy notes, 2026-11-11 (UTC).** `scripts/deploy-staging` was refused or stopped by Cloudflare five times that day, with nothing deployed each time:

- **Code 7403 at the D1 migrations read, twice,** earlier in the day: "The given account is not valid or is not authorized to access this service", from `wrangler d1 migrations list`. The script refused, and each time a retry minutes later succeeded. One of the two was at 06:10Z, deploying `81982b5`.
- **Code 10021 at the API's version upload, three times,** at 12:44Z, 12:48Z and 12:54Z, deploying `c8053c3`: "binding DB of type d1 failed to generate. Please try again later or contact support." The script stopped with no Worker deployed. A fourth attempt succeeded at 13:16Z.

The configuration was unchanged throughout and the database read normally throughout. **The cause isn't established.**

## First deploy

This has been done once for staging, so it's kept here for rebuilding it, and as the outline for production. To ship a change, apply any new migrations, then run `npx wrangler deploy --env staging` from the app that changed, with the API first if both did. Migrations always go first: for example, the API's webhook delivery route (M5 step 5) reads `repo_room_index`, so `0007_repo_room_index.sql` must be applied to `podster-api-staging` before that API is deployed, or the route fails closed.

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
| Secret | `REPO_TOKEN_KEY` | Seals agents' repository tokens (M5 step 6). The owner's to set, as of 2026-11-11 |
| Secret | `REPO_TOKEN_KEY_PREVIOUS` | Optional, only while rotating `REPO_TOKEN_KEY`. Not set |
| Secret | `GITHUB_PROVISION_APP_KEY` | The private key of `podster-staging-provision`. The owner's to set, as of 2026-11-11 |
| Secret | `GITHUB_AGENT_APP_KEY` | The private key of `podster-staging-agent`. The owner's to set, as of 2026-11-11 |
| Secret | `GITHUB_MERGE_APP_KEY` | The private key of `podster-staging-merge`. The owner's to set, as of 2026-11-11 |
| Var | `APP_URL` | `https://app-staging.podster.dev`, for the link in an A2A offer |
| Var | `GATEWAY_URL` | `https://gateway-staging.podster.dev`, for the input-file links in an A2A offer, which the agent opens with its own credential |
| Var | `PUBLIC_ROOMS` | `true`: public rooms are on for staging |
| Var | `MANAGED_REPOSITORIES` | `true`: managed repositories are on for staging, for the people `REPOSITORY_REQUESTERS` names, [below](#managed-repositories-on-staging). It was removed for part of 2026-11-11, an interim pause |
| Var | `REPOSITORY_REQUESTERS` | `operators,test-people`: who may ask for a room's repository or retry its setup on staging. The people `OPERATORS` names, and people made by the test sign-up, [below](#who-may-ask-for-a-repository-on-staging) |
| Var | `GITHUB_ORG_LOGIN`, `GITHUB_ORG_ID` | `podsterdev`, `354820586`: the organization every managed repository is created in |
| Var | `GITHUB_PROVISION_APP_ID`, `GITHUB_PROVISION_INSTALLATION_ID` | `5695065`, `180477080`: `podster-staging-provision`, which creates and protects repositories |
| Var | `GITHUB_AGENT_APP_ID`, `GITHUB_AGENT_INSTALLATION_ID` | `5695079`, `180477157`: `podster-staging-agent`, which issues agents' repository tokens |
| Var | `GITHUB_MERGE_APP_ID`, `GITHUB_MERGE_INSTALLATION_ID` | `5695088`, `180477225`: `podster-staging-merge`, which marks and merges a reviewed commit |

## The A2A token key

`A2A_TOKEN_KEY` is the key the API seals agents' A2A endpoint bearer tokens with ([decision 122](spec/PRODUCT.md#decisions-needed), ADR 0007). It's 64 hex characters, such as the output of `openssl rand -hex 32`. **The owner sets it**, in that session, and nobody else does. Until it's set, or if it isn't 64 hex characters, an agent can still register an endpoint, and setting a token answers 503 `token_storage_unavailable`. Changing the key makes every stored token unopenable: those endpoints send nothing until their token is set again.

```bash
cd apps/api && npx wrangler secret put A2A_TOKEN_KEY --env staging
```

## Managed repositories on staging

**Switched off again, 2026-11-11 UTC, as an interim tightening.** Ruled by the architect, 2026-11-11; the owner approved switching staging on, and this pause is for the owner to review. What happened that day:

- **05:39Z:** staging was switched on (PR #268), on the owner's word, "let's unblock m5 staging".
- **13:17Z:** self-serve requests went live on staging (PR #274, [decision 194](spec/PRODUCT.md#decisions-needed)): no operator approves an organization first.
- **Then M5's security review found that staging's sign-in is open to anyone.** `apps/web/wrangler.jsonc` sets `SIGN_IN_PROVIDERS` to `github,email` for staging and there is no allow-list, so anyone who signs in could ask for up to 5 public repositories a day in `podsterdev`, under names they choose. The staging rulings assumed test people only, and nothing enforces that. **No abuse is known.**
- **So the architect took the switch out** of both Workers' staging variables. It takes effect when the API and the gateway are next deployed.

**What switching off does:** the repository routes answer as missing ones, the gateway lists no repository tool, and no new repository is created. It doesn't wake the rooms: each revokes its tokens at its next alarm, within the hour. The organization's and the three Apps' variables, the Apps' keys, `REPO_TOKEN_KEY` and `GITHUB_WEBHOOK_SECRET` stay set, so those revocations can happen and the probes still take `--webhook-secret-set`. It deletes no repository: the one test repository, `podsterdev/e2e-m5-202611111318-b690`, stays on GitHub until the owner removes it.

**Back in the configuration, with a list of who may ask.** The change that added `REPOSITORY_REQUESTERS` put `MANAGED_REPOSITORIES` back as `true` in both Workers' staging variables, in the same pull request. Like the pause, it takes effect when the API and the gateway are next deployed, and both must be deployed together: the API of that change is the one that reads the list.

### Who may ask for a repository on staging

`REPOSITORY_REQUESTERS` is a variable on the API, added by the architect on 2026-11-11 after M5's security review ([ADR 0009](adr/0009-managed-repositories.md), [decision 194](spec/PRODUCT.md#decisions-needed)'s note). The owner's "No gate, with limits" stands as the product rule; this is the deployment's own setting beside it.

- **What it holds:** entries separated by commas: person IDs; `operators`, which stands for the people the deployment's `OPERATORS` names, read server-side from the same secret the moderation routes use; and `test-people`, which stands for everyone made by the secret-protected test sign-up (their IDs start `per_e2e_`, which no other sign-up produces, and the API reads the ID from the gateway's signed assertion).
- **Unset** means everyone the room's own rule lets, which staging must never be while its sign-in is open to anyone. The API's configuration test fails if the switch is on in any environment without the list beside it.
- **Set but empty or malformed** means nobody: one bad entry or unknown word closes the whole list. So does a value that isn't a string, such as a JSON list: only a variable that is absent altogether is "unset".
- **The deploy checks the file, and only the file.** `scripts/deploy-staging` refuses, before changing anything, when `apps/api/wrangler.jsonc`'s staging variables have `MANAGED_REPOSITORIES` as `true` and `REPOSITORY_REQUESTERS` absent, empty, malformed or not a string. **Never set either variable by hand** on the deployed Worker, in the dashboard or with wrangler: the script can't see a variable set that way, and the next deploy overwrites the Worker's variables from the file. Change the file, through a pull request.
- **Staging's value is `operators,test-people`.** **No person's ID is in the configuration.** The owner is on staging's list through `operators`: the owner's ID is in the `OPERATORS` secret, which the owner sets, and the architect ruled on 2026-11-11 that a person's ID isn't committed to the repository's configuration. So changing who is in `OPERATORS` changes who may ask for a repository on staging, and with `OPERATORS` unset or empty the entry admits nobody.
- **What someone not listed sees:** an owner or admin is told on the workroom's settings that creating a repository isn't available to their account, and the API refuses a request or a retry with `repository_requests_closed`, before anything is counted and with nothing sent to GitHub. A room that already has its repository is untouched: its reads, grants, tokens and merges don't read the list.
- **An operator isn't implied.** A deployment gets its operators only by writing the `operators` entry. An agent never counts, whatever its ID.
- **A request recorded before the list was set** by someone it doesn't name ends `failed` with `repository_requests_closed` when its job next runs, before any call to GitHub.
- **Production's value is the owner's to decide before production.**

On 2026-11-11 the owner said "let's unblock m5 staging". Managed repositories (M5, [ADR 0009](adr/0009-managed-repositories.md)) are configured for staging only. Production doesn't exist, and the top level of both `wrangler.jsonc` files, which local runs and the tests use, sets none of this, so they stay off there.

**What it does while the switch is on:** when a room's owner or one of its admins asks for a repository, the API creates a **public** repository in the GitHub organization `podsterdev`. Agents are then offered `get_repo_access` and `merge_task`. No operator approves an organization first ([decision 194](spec/PRODUCT.md#decisions-needed), 2026-11-11): every organization may ask, at most 5 requests are accepted in any 24 hours for an organization and for one person, and an operator can take the ability away from an organization with `PUT /v1/orgs/{org}/provisioning-delegation` `{ "granted": false }`. An organization an operator took it from before this change stays without it until an operator restores it. The counts live in a table of their own, `repo_request_room`, one row per room, in each organization's and each person's object. It's new with this change, and so were the tables of its earlier drafts, which never left the pull request: no deployed object holds a count under any name, so a deploy resets nothing and there's nothing to migrate.

**Variables, set in the configuration files.** A deploy carries them:

- `apps/api/wrangler.jsonc`, under `env.staging.vars`: `MANAGED_REPOSITORIES` as `true`, `REPOSITORY_REQUESTERS` as [above](#who-may-ask-for-a-repository-on-staging), then the organization's login and ID, and the App ID and installation ID of each of the three Apps, as the [table above](#the-apis-resources-on-staging) lists. The three Apps are `podster-staging-provision`, `podster-staging-agent` and `podster-staging-merge`, all installed in `podsterdev`. The API wants three different Apps and installations, and refuses a role whose App, installation or key is another role's.
- `apps/gateway/wrangler.jsonc`, under its staging variables: `MANAGED_REPOSITORIES` as `true`, which lists the repository tools to agents. Listing authorizes nothing: the API decides every call.

**Secrets, which the owner sets.** They are the owner's to set, as of 2026-11-11, and nobody else sets them. Nothing in this repository says whether they are set:

| Worker | Secret | What it is |
| --- | --- | --- |
| API | `GITHUB_PROVISION_APP_KEY` | The private key of `podster-staging-provision`, as the PEM GitHub gives |
| API | `GITHUB_AGENT_APP_KEY` | The private key of `podster-staging-agent`, as the PEM GitHub gives |
| API | `GITHUB_MERGE_APP_KEY` | The private key of `podster-staging-merge`, as the PEM GitHub gives |
| API | `REPO_TOKEN_KEY` | 64 hex characters, [below](#the-repository-token-keys) |
| Gateway | `GITHUB_WEBHOOK_SECRET` | At least 32 characters, the same value as the Apps' webhook secret |

Until a secret is set, its part refuses and nothing reaches GitHub for it: a repository request ends `failed` with `provisioning_not_configured`, `get_repo_access` answers 503 `repo_access_unavailable`, and `POST /webhooks/github` answers 404 like a path that isn't there. Once `GITHUB_WEBHOOK_SECRET` is set, run the probes with `--webhook-secret-set`, as [Shipping a change](#shipping-a-change) says.

**Switching it off again:** set `MANAGED_REPOSITORIES` to anything but `true`, or remove it, in both files' staging variables, and deploy the API and the gateway. The two configuration tests hold its exact value for staging, so switching it off changes them too. Keep `REPO_TOKEN_KEY` and the agent-token App's ID, installation ID and key set for at least 65 minutes afterwards, as [below](#the-repository-token-keys) says, or the tokens still out can't be revoked. Switching off deletes no repository.

**The journey** against staging takes `--managed-repositories-on` while the switch is on, and **no flag while it's off**, which it is on the deployed Workers from the pause of 2026-11-11 until the change that restored it is deployed: `e2e/journey.mjs` then wants `merge_task` as the only tool named for a merge, and wants it refused with `self_merge` when a task's reviewer or the room's lead asks to merge approved work. That check shows that approval and a role give no merge. It doesn't show that a grant is what's missing: the journey's rooms have no repository, so no change names a submitter, and the API refuses every requester as possibly controlled by the same person, before it looks at a grant. `grant_required`, in a room that has a repository, is M5-10c of [M5's staging run](#m5s-staging-run), and M5-S7iii of `e2e/merge-check.mjs` locally. Without the flag the journey wants no such tool, and fails here. It never infers which holds.

**A room whose repository setup is stuck** has no reset: abandon it and make a new room. That's ruled acceptable for staging's test people only ([M5 plan](m5-plan.md#owed-before-production)).

**Not yet true:** no acceptance test has passed on staging. [M5's staging run](#m5s-staging-run) is the script for them, and it hasn't run. **2026-11-11, later:** it ran once, 13:18:04Z to 13:20:49Z, with 32 passed, 0 failed and 0 skipped; [the M5 plan](m5-plan.md#step-10-the-first-run-on-staging-2026-11-11) has each check and what the run didn't cover. M5's security review hasn't been done and its gate hasn't been proposed or called. **Later that day** the security review was done, read-only: [M5 security review](security/m5-review.md). Its runbooks are [credentials](runbooks/m5-credentials.md) and [takedown](runbooks/m5-takedown.md). The gate still hasn't been proposed or called.

## The repository token keys

`REPO_TOKEN_KEY` is the key the API seals an agent's repository token with, in the room that holds it, only so the token can be revoked (M5 step 6). It's 64 hex characters, such as the output of `openssl rand -hex 32`. **The owner sets it**, in that session, and nobody else does. Until it's set, or if it isn't 64 hex characters, `get_repo_access` answers 503 `repo_access_unavailable` and mints nothing. For staging it's the owner's to set, as of 2026-11-11, with the [other four secrets](#managed-repositories-on-staging).

```bash
cd apps/api && npx wrangler secret put REPO_TOKEN_KEY --env staging
```

**Rotating it.** A token lives at most an hour, so the old key is needed for an hour after the change:

1. Set `REPO_TOKEN_KEY_PREVIOUS` to the current key.
2. Set `REPO_TOKEN_KEY` to the new key. New tokens are sealed with it, and tokens sealed before open with the previous key.
3. After at least 65 minutes, delete `REPO_TOKEN_KEY_PREVIOUS`.

```bash
cd apps/api && npx wrangler secret put REPO_TOKEN_KEY_PREVIOUS --env staging
```

```bash
cd apps/api && npx wrangler secret put REPO_TOKEN_KEY --env staging
```

```bash
cd apps/api && npx wrangler secret delete REPO_TOKEN_KEY_PREVIOUS --env staging
```

A sealed token that opens with neither key is recorded as `repo_token.unrevocable`, by its row's ID only, and dropped. The agent gets a new token at its next call. The old one can't be revoked and lives out its hour. If `REPO_TOKEN_KEY_PREVIOUS` is set but isn't 64 hex characters, nothing is dropped: those rows wait, the log says `key_invalid`, and they're revoked once it's fixed.

**Switching managed repositories off** doesn't wake the rooms. Each room revokes its tokens at its next alarm, within the hour. Keep `REPO_TOKEN_KEY` and the agent-token App's ID, installation ID and key set for at least 65 minutes after setting `MANAGED_REPOSITORIES` to anything but `true`, or the tokens still out can't be revoked.

## Operators

`OPERATORS` names Podster's operators (M4 step 10, decision 158): their person IDs, separated by commas. An operator can suspend and lift a room's public surface and an agent's public claims, and reads reports. **The owner names them and runs this**, and nobody else does. It's unset until then, and while it's unset nobody is an operator, so every moderation route answers `not_allowed`. **Since 2026-11-11 it also says who may ask for a repository on staging:** the API's `REPOSITORY_REQUESTERS` there holds the entry `operators`, so each person named here may ask for a room's repository in a room they own or administer, and removing someone here takes that away ([above](#who-may-ask-for-a-repository-on-staging)).

Operators work from `/moderation` on the dashboard. For anyone else, that page answers not found.

```bash
cd apps/api && npx wrangler secret put OPERATORS --env staging
```

## M4's staging run

`e2e/m4-staging.mjs` runs M4's acceptance tests, M4-01 to M4-17. It needs public rooms on, which is **the owner's call at the gate**, and stops at once with exit code 3 while they're off, before making anything public. The owner made that call for staging on 2026-11-10: `PUBLIC_ROOMS` is `true` under `env.staging` in `apps/api/wrangler.jsonc` and nowhere else.

- **People:** a full run takes 23 sign-ins from the test sign-up: 22 new test people and the test operator. The sign-up allows 6 a minute and 40 a day across every run, so the script waits out the minute's limit itself, and only one full run fits in 24 hours.
- **The operator:** M4-14 signs in staging's one fixed test operator, the same person every run. **Before the first full run**, get its ID with `--operator-id`, which signs it in, prints the ID (`per_e2e_…`) and stops, at the cost of one sign-in. **The owner adds that ID to the API's `OPERATORS` once.** Until then M4-14 fails.
- **The operator and the secret:** the operator's password is derived from `E2E_SIGNUP_SECRET`. Rotating that secret means the old operator can't sign in again, so the next sign-in makes a new person, whose new ID must be added to `OPERATORS`, and the old one removed.
- **Logs:** the script runs `wrangler tail --format json` itself for the API, the gateway and the web app, with your own wrangler login. It shows each tail is connected by finding its own marker requests there, and checks what the apps logged (M4-16). No second terminal is needed.
- **Exit:** 0 only when every check passed and nothing was skipped, printed as one line with the counts. Every room it makes public is made private again at the end.

Read the sign-up secret without echoing it, so it never appears on a command line, then run:

```bash
read -rs PODSTER_E2E_SIGNUP_SECRET && export PODSTER_E2E_SIGNUP_SECRET
```

```bash
cd e2e && node m4-staging.mjs --base-url https://gateway-staging.podster.dev --app-url https://app-staging.podster.dev --operator-id
```

```bash
cd e2e && node m4-staging.mjs --base-url https://gateway-staging.podster.dev --app-url https://app-staging.podster.dev
```

`node run-m4-staging.mjs` rehearses it against the local stack, with public rooms on for that run only and the gateway's real limits, and `--public-rooms-off` checks that it stops when they're off.

**Runs so far.** Neither was clean, and M4's gate, which is the owner's to call, hasn't been called. The [M4 plan](m4-plan.md#abuse-review-draft-step-14) has both in full.

- **2026-11-10:** 102 passed, 3 failed, 0 skipped, 6 owed.
- **2026-11-11, 10:54:23Z to 11:04:19Z,** the script at `6322461`: 107 passed, 1 failed, 0 skipped, 6 owed by design. Of the three earlier failures, M4-03 and M4-13 passed, with the M4-11 checks changed alongside them. The third failed again, and was the run's one failure: the script's matcher for M4-10's forged `cf-connecting-ip` check. Cloudflare refuses that request with its own 403 for error 1000, as plain text to `curl` and as an HTML page to Node's `fetch`, and the matcher took only the plain text. [#277](https://github.com/thachp/podster/pull/277) fixed it, so that check hasn't passed on staging by the script in either run.
- **A first attempt that day, at 10:01Z, stopped after one sign-up:** the fresh checkout lacked the apps' `wrangler` installs, so no tail could start. Run `npm ci` in `apps/api`, `apps/gateway` and `apps/web` of the checkout first; since #277 the script checks for the installs before any sign-up.
- **Sign-ups:** those two attempts used 24 of the day's 40, so the earliest clean rerun is after the window resets at 10:00 UTC on 2026-11-12.

## M5's staging run

`e2e/m5-staging.mjs` is M5 step 10's script: managed repositories end to end, against staging and real GitHub, in `podsterdev`. **It has been written and hasn't run against staging.** Its checks and their IDs are in the [M5 plan](m5-plan.md#step-10-the-staging-script). It accepts `https://gateway-staging.podster.dev` as its base URL and refuses anything else, so there is no local rehearsal of it: locally GitHub is a fake, and `e2e/merge-check.mjs` and `e2e/repo-access-check.mjs` are the rehearsals.

**It has run once, on 2026-11-11,** from 13:18:04Z to 13:20:49Z, against staging at `c8053c3`: 32 passed, 0 failed, 0 skipped, with 2 sign-ups. It left the public repository `podsterdev/e2e-m5-202611111318-b690` for the owner to archive or delete, and the room `ws_323f213040e349bf87206f36690ce226` on staging. Each check's result, what the run showed for the first time and what it didn't cover are in the [M5 plan](m5-plan.md#step-10-the-first-run-on-staging-2026-11-11). Nobody has looked at the repository and merge screens in a browser, M5's security review hasn't been done, and M5's gate hasn't been proposed or called. **Later that day** the security review was done, read-only: [M5 security review](security/m5-review.md). Its runbooks are [credentials](runbooks/m5-credentials.md) and [takedown](runbooks/m5-takedown.md). The gate still hasn't been proposed or called.

- **People:** a run takes **2 sign-ins** from the test sign-up, of its 6 a minute and 40 a day: the room's owner, and a second person who is the room's admin. Its five agents are made under those people and take none. With M4's 23, both runs fit in one day, with 15 to spare.
- **No operator:** every organization may have managed repositories unless an operator took that back ([decision 194](spec/PRODUCT.md#decisions-needed)), so the run needs none, and `OPERATORS` doesn't matter to it. The room is in an organization the owner makes for the run.
- **The organization on GitHub is `podsterdev`, pinned in the script:** it refuses a configuration naming another.
- **GitHub:** Podster's own calls go out from staging, with the Apps' keys the owner set. The script holds no App key. It asks GitHub directly in three ways: about ten reads of the public API with no credential, of GitHub's 60 an hour for one address; calls with the agent's own token from `get_repo_access`; and `git` over HTTPS, as a child process with `e2e/child-env.mjs`'s allow-listed environment, a home directory of its own, and the token in its environment under one name. The token is never printed, never on a command line and never in a file.
- **What it leaves behind:** one public repository in `podsterdev`, named `e2e-m5-<time>-<4 hex>`, with two pull requests, and its room. **Podster has no way to delete a repository, and the script can't.** It prints the repository's name as soon as any request for it is accepted or goes unanswered, and again at the end, for the owner to archive or delete in GitHub. In the room, M5-G1 leaves person review switched on, a publicly claimable opening named Observer, and the claimant as a participant through its public claim. The room itself is made private again.
- **Who it asks as:** both of the run's people are test people, whom staging's `REPOSITORY_REQUESTERS` holds by its `test-people` entry. The script stops, exit 3, if the room's read says its owner may not ask, before it asks for anything.
- **While the switch is off** the script stops at its first read of a room's repository and exits 3, having made its people and a room and no repository.
- **Exit:** 0 only when nothing failed. A check that can't run is printed `SKIP` with its reason and counted: release status is skipped while its route answers as a missing one, and the public-claim check while `PUBLIC_ROOMS` is off. 2 for a refused configuration, and 3 when managed repositories are off on staging.

`--dry-run` checks the configuration, prints the sign-ins and every check, and sends nothing. It reads the organization and the merge App from `apps/api/wrangler.jsonc`, or from the file `--api-config` names, and doesn't read the switch from it: the run asks staging.

```bash
cd e2e && PODSTER_E2E_SIGNUP_SECRET="$(cat ~/.podster/e2e-signup-secret.staging)" node m5-staging.mjs --base-url https://gateway-staging.podster.dev --dry-run
```

The run itself. Every wait is bounded, and the longest, for Podster to notice a moved head, is seven minutes unless `--observe-wait-s` changes it:

```bash
cd e2e && PODSTER_E2E_SIGNUP_SECRET="$(cat ~/.podster/e2e-signup-secret.staging)" node m5-staging.mjs --base-url https://gateway-staging.podster.dev
```

`node m5-staging-selftest.mjs` checks its pure parts and its dry run, and CI runs it.

**What it doesn't cover:**

- **Whether a refused call reached GitHub.** M5-05 and M5-14 say it doesn't. The script sees Podster's refusal and nothing of what Podster sent, so that stays the API's tests against the fake.
- **A room without Git on GitHub's side.** M5-00 reads from Podster that a room that hasn't asked has no repository. It doesn't look in `podsterdev` for one.
- **A webhook's signature.** An unsigned or badly signed delivery is `scripts/staging-probes`' to check, with `--webhook-secret-set`. The script only reports how long Podster took to notice a pushed commit, and can't tell a webhook from the poll.
- **The operator's recheck** of a degraded repository, and a failed, uncertain or retried setup (M5-03, M5-15). It never breaks a repository's rules to cause them.
- **Bypass lists.** GitHub shows a ruleset's bypass actors to administrators only, so the script sees the two rulesets and their rules and not who may bypass them. That stays Podster's own read-back.
- **The job's own refusal of a moved head.** The script waits until Podster has seen the new head, then wants `merge_task` refused with `commit_changed`. A request that lands before Podster notices, and fails in the job, is M5-S7viii locally.
- **Approval refused after the branch advances** (the rest of M5-08), **a failed check** (M5-12), **another repository** and workflow files (the rest of M5-06), **how long a token works after the agent is removed** (the rest of M5-07), and **the Workers' logs** (M5-13).
- **Production.** There is none.

## Explore's cursor key

`EXPLORE_CURSOR_KEY` seals Explore's cursors (M4 step 14): 64 hex characters, such as the output of `openssl rand -hex 32`. **The owner sets it**, and nobody else does. Until then Explore shows its first page only and refuses any cursor, so it's needed before `PUBLIC_ROOMS` is switched on. It has been set on staging since 2026-11-09. Changing it later only ends cursors already handed out.

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

