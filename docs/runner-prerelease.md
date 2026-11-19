# Runner's test pre-release

**Status, 2026-11-19:** built, not published. The workflow hasn't run.

The owner decided on 2026-11-19 to publish a marked test pre-release of Runner to npm before M7's staging run ([step 16](m7-plan.md#build-order)), so the owner and Long can run it with `npx`. This narrows [decision 26](spec/PRODUCT.md#decisions-needed) for this pre-release only. The gated release is unchanged, and once M7's step 17 passes it supersedes this one.

## The terms

- **Package:** the unscoped `podster`. The owner has no `@podster` organization, and `npm view podster` showed it unpublished on 2026-11-19.
- **Version:** `0.0.x-test.N`, starting at `0.0.1-test.1`.
- **Tag:** published only under npm's `test` dist-tag. npm may also point `latest` at the first version, because a package's first publish gets `latest` when it has none; step 4 checks.
- **Gateway:** staging's, `https://gateway-staging.podster.dev`, by default. `pair --gateway <origin>` still names another.
- **Unattended runs:** off by default, as before.
- **Install:** the package ships `npm-shrinkwrap.json`, the same tree as `package-lock.json`, so an install gets exactly what CI tested. No production dependency has an install script, so users run it with scripts off: `npx --ignore-scripts podster@test …`.
- **Publisher:** only `.github/workflows/runner-prerelease.yml`, run by hand from `main`, behind the GitHub environment `npm-test-prerelease`, with npm provenance and npm trusted publishing (OIDC). There's no npm token secret.
- **Locally:** a plain `npm publish` from `apps/runner` is refused by the package's `prepublishOnly` guard, `apps/runner/scripts/publish-guard.mjs`. The guard only stops a mistake: `--ignore-scripts` skips it, and npm runs no script when it publishes a `.tgz`.

## Why the environment's protection is required

`workflow_dispatch` runs the workflow file as it is on the branch it's dispatched from. So the workflow's `if:` checks, its main-only job and `publish-guard` are all under the control of whoever can push a branch and edit them. As far as we know, npm's trusted publisher matches the repository, the workflow's file name and the environment, not the branch or ref.

The check a branch can't edit is the environment's own rule in GitHub's settings: deployment branches limited to `main`, and the owner as required reviewer. A job from any other branch can't enter the environment, so it gets no OIDC token for it. That's why step 2 is required, and why it comes before the trusted publisher is added.

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

1. **The owner's, required:** have an npm account with two-factor authentication on.
2. **The owner's, required, before step 5:** in GitHub, open thachp/podster, then Settings, then Environments. Create `npm-test-prerelease`. Add yourself as a required reviewer. Under deployment branches, choose selected branches and add only `main`. [Why this is required.](#why-the-environments-protection-is-required)
3. **The owner's:** make `podster` exist on npm, with path A or path B.
   - **Path A, only if npmjs.com allows it:** do step 5 now. Then run the workflow on `main` with version `0.0.1-test.1` and `dry_run` off, and approve its publish job. It publishes `0.0.1-test.1` with provenance, and you can skip step 6.
   - **Path B, the expected one:** in GitHub, open Actions, choose **Runner pre-release**, and run it on `main` with version `0.0.1-test.1` and `dry_run` on. Its build job builds, tests and packs `podster-0.0.1-test.1.tgz`, prints the file's SHA-256 in the step "Pack the .tgz and print its SHA-256", and uploads the file as the run's artifact.
     - GitHub downloads an artifact as a `.zip`. Unzip it to get the `.tgz`.
     - Check that `shasum -a 256 podster-0.0.1-test.1.tgz` prints the same SHA-256 as the log. Stop if it doesn't.
     - Publish that file yourself:

     ```bash
     npm publish ./podster-0.0.1-test.1.tgz --tag test --access public --provenance=false
     ```

     `--provenance=false` is needed because provenance can only be made in CI, not at a terminal. So this first version carries no provenance attestation, though CI built the file. npm asks for your two-factor code.
4. **The owner's, after the first publish:** run `npm view podster dist-tags`. Expect `test: '0.0.1-test.1'`, and possibly `latest: '0.0.1-test.1'` too, which npm sets on a package's first publish. A `latest` here is expected: leave it. Every version is a test pre-release, and the gated release later takes `latest`.
5. **The owner's:** on npmjs.com, open `podster`, then Settings, then Trusted publishing. Add a GitHub Actions publisher:
   - organization or user: `thachp`
   - repository: `podster`
   - workflow filename: `runner-prerelease.yml`
   - environment: `npm-test-prerelease`

   npm doesn't check these when you save them, and the publisher must publish within 2 days of being added.
6. **The owner's, recommended after path B:** bump `apps/runner/package.json` to `0.0.1-test.2` in a PR, then run the workflow on `main` with that version and `dry_run` off, and approve its publish job. It publishes with provenance, and `npx podster@test` then gets that version. This also uses the trusted publisher inside its 2 days.
7. **The owner's, required once the first workflow publish has succeeded:** in `podster`'s settings on npmjs.com, set publishing access to "Require two-factor authentication and disallow tokens". From then on, only the trusted publisher can publish.
8. **The owner's and Long's, before running a version:** check its provenance, either way:
   - `npm view podster@0.0.1-test.2 dist.attestations --json` shows a `provenance` entry with `predicateType` `https://slsa.dev/provenance/v1`. Open the attestation from the version's page on npmjs.com to see it was built from `thachp/podster`, workflow `runner-prerelease.yml`, on `refs/heads/main`.
   - Or, in an empty scratch folder: `npm init -y`, then `npm install --ignore-scripts podster@test`, then `npm audit signatures`. It reports verified registry signatures and verified attestations.

   `0.0.1-test.1` from path B has no attestation, by design.
9. **The owner's, later runs:** each new pre-release is a PR that bumps the version, then a run of the workflow on `main` with that version and `dry_run` off.

## What the workflow does

`workflow_dispatch` only, with the inputs `version` and `dry_run` (default on). Every action is pinned by full commit SHA. It has three jobs:

1. **`main-only`** fails a run from any ref but `main`, and the jobs after it are skipped.
2. **`build`** has `contents: read`, and no OIDC token or environment. It refuses a `version` input that isn't the version in `apps/runner/package.json`, or isn't `0.0.x-test.N`. Then it runs `npm ci --ignore-scripts`, the typecheck, the tests, the build and `npm pack --dry-run`. It packs the `.tgz`, prints its SHA-256, passes the file name and SHA-256 on as job outputs, and uploads the `.tgz` as an artifact kept 7 days.
3. **`publish`**, only with `dry_run` off and on `main`, runs in the `npm-test-prerelease` environment, with `contents: read` and `id-token: write`. It checks out nothing and runs no dependency code. It installs npm 11.21.2, downloads the artifact, checks the `.tgz` against build's SHA-256, then runs `npm publish ./podster-<version>.tgz --provenance --tag test --access public`.

The package holds:
- `build/`;
- `git/credential-helper`, which Git runs for Runner as `/bin/sh <path>`, so it needs no execute bit;
- the two Dockerfiles, `sandbox/Dockerfile` and `claude-image/Dockerfile`, from which `run --provider-key-file` builds a missing image and pins it;
- `npm-shrinkwrap.json`;
- the README;
- `package.json`.

It has no tests, source maps, fixtures or secrets.
