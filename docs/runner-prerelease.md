# Runner's test pre-release

**Status, 2026-11-19:** built, not published. The workflow hasn't run.

The owner decided on 2026-11-19 to publish a marked test pre-release of Runner to npm before M7's staging run ([step 16](m7-plan.md#build-order)), so the owner and Long can run it with `npx podster@test`. This narrows [decision 26](spec/PRODUCT.md#decisions-needed) for this pre-release only. The gated release is unchanged, and once M7's step 17 passes it supersedes this one.

## The terms

- **Package:** the unscoped `podster`. The owner has no `@podster` organization, and `npm view podster` showed it unpublished on 2026-11-19.
- **Version:** `0.0.x-test.N`, starting at `0.0.1-test.1`.
- **Tag:** npm's `test` dist-tag, never `latest`.
- **Gateway:** staging's, `https://gateway-staging.podster.dev`, by default. `pair --gateway <origin>` still names another.
- **Unattended runs:** off by default, as before.
- **Publisher:** only `.github/workflows/runner-prerelease.yml`, run by hand from `main`, behind the GitHub environment `npm-test-prerelease`, with npm provenance and npm trusted publishing (OIDC). There's no npm token secret.
- **Locally:** a plain `npm publish` from `apps/runner` is refused by the package's `prepublishOnly` guard, `apps/runner/scripts/publish-guard.mjs`. The guard only stops a mistake: `--ignore-scripts` skips it, and npm doesn't run a tarball's scripts. Two settings hold on npm's side: the trusted publisher, and disallowing tokens in step 6.

## What npm's documentation says

[npm's trusted publishers page](https://docs.npmjs.com/trusted-publishers), read 2026-11-19:

- You add a trusted publisher in the package's own settings on npmjs.com. The page never says it can be added for a name that hasn't been published, and never says it can't.
- A new trusted publisher must "complete its first successful publish within 2 days".
- Trusted publishing needs npm 11.5.1 or later and Node 22.14.0 or later, on GitHub-hosted runners only, and the workflow needs `id-token: write`.
- Provenance is generated automatically with trusted publishing, for a public package from a public repository.
- After that, the package's publishing access can be set to "Require two-factor authentication and disallow tokens". Trusted publishers keep working.

The page doesn't settle whether a trusted publisher can be added before the first publish. So this plan assumes it can't, and the first version reaches npm through path B. Try path A first only if npmjs.com offers the setting for `podster` before it exists.

## The owner's steps

Every step here is the owner's. Agents don't sign in to npm, publish, create tokens, or change GitHub settings.

1. **The owner's:** have an npm account with two-factor authentication on.
2. **The owner's, optional:** in GitHub, open thachp/podster, then Settings, then Environments. Create `npm-test-prerelease`, add yourself as a required reviewer, and limit its deployment branches to `main`. If the environment doesn't exist, the first run creates it without these protections.
3. **The owner's:** make `podster` exist on npm, with path A or path B.
   - **Path A, only if npmjs.com allows it:** add the trusted publisher of step 4 now. Then run the workflow with `dry_run` off. Its run publishes `0.0.1-test.1` with provenance, and you can skip step 5.
   - **Path B, the expected one:** in GitHub, open Actions, choose **Runner pre-release**, and run it on `main` with version `0.0.1-test.1` and `dry_run` on. It builds, tests and packs `podster-0.0.1-test.1.tgz` and uploads it as the run's artifact. The log shows the file's SHA-256. Download the artifact, check that `shasum -a 256 podster-0.0.1-test.1.tgz` matches the log, then publish that file yourself:

     ```bash
     npm publish ./podster-0.0.1-test.1.tgz --tag test --access public --provenance=false
     ```

     `--provenance=false` is needed because provenance can only be made in CI, not at a terminal. So this first version carries no provenance attestation, though the file was still built by CI. npm asks for your two-factor code.
4. **The owner's:** on npmjs.com, open `podster`, then Settings, then Trusted publishing. Add a GitHub Actions publisher:
   - organization or user: `thachp`
   - repository: `podster`
   - workflow filename: `runner-prerelease.yml`
   - environment: `npm-test-prerelease`

   npm doesn't check these when you save them, and the publisher must publish within 2 days of being added.
5. **The owner's, recommended after path B:** bump `apps/runner/package.json` to `0.0.1-test.2` in a PR, then run the workflow on `main` with that version and `dry_run` off. It publishes with provenance, and `npx podster@test` then gets that version. This also uses the trusted publisher inside its 2 days.
6. **The owner's, recommended:** in `podster`'s settings on npmjs.com, set publishing access to "Require two-factor authentication and disallow tokens".
7. **The owner's, later runs:** each new pre-release is a PR that bumps the version, then a run of the workflow on `main` with that version and `dry_run` off.

## What the workflow does

`workflow_dispatch` only. A run from a ref other than `main` fails in its first job, and the publish job is skipped. The publish job runs in the `npm-test-prerelease` environment, with `contents: read` and `id-token: write` only, and every action is pinned by full commit SHA. It:

1. refuses a `version` input that isn't the version in `apps/runner/package.json`, or isn't `0.0.x-test.N`;
2. installs npm 11.21.2;
3. runs `npm ci --ignore-scripts`, the typecheck, the tests, the build and `npm pack --dry-run`;
4. with `dry_run` on, packs the `.tgz`, prints its SHA-256 and uploads it as an artifact, kept 7 days;
5. with `dry_run` off, runs `npm publish --provenance --tag test --access public` from `apps/runner`, after the package's guard checks it's this workflow on `main`.

The package holds `build/`; `git/credential-helper`, which Git runs for Runner as `/bin/sh <path>`, so it needs no execute bit; the two Dockerfiles, `sandbox/Dockerfile` and `claude-image/Dockerfile`, from which `run --provider-key-file` builds a missing image and pins it; the README; and `package.json`. It has no tests, source maps, fixtures or secrets.
