# Runner's test pre-release

**Ruling, 2026-11-20:** the owner said: "i don't want to need to approve stage release.. you can go ahead and release .. it". Staged publishing is no longer used. The workflow now runs `npm publish` directly through trusted publishing (OIDC), so no version needs the owner's npm two-factor approval. The architect runs the workflow and approves the `npm-test-prerelease` GitHub environment. The owner's one-time step: on npmjs.com, open `podster`, then Settings, then Trusted publishing, edit the GitHub Actions publisher and tick "Allow npm publish". Until that is ticked, the workflow's publish step is refused by npm. After publishing, the workflow prints the registry's shasum and integrity for the version and fails if the shasum differs from the packed file's. Older notes below describe staging as it was, for the record.

**Status, 2026-11-19 (before the ruling):** `0.0.1-test.2` was staged and approved, and its provenance was verified. `0.0.1-test.3` is next: it carries the tool-path fix (#477), nudge interop's A2A-Version check (#476) and a README with a run-policy (`policy.json`) example and the key-file recipe, after the owner's first run hit two snags (a key file must hold exactly one key, mode 600; `allowed_orgs` must not include `owner_org`). It is staged the same way: bump merged, workflow run on `main` with `dry_run` off, then approve the staged version on npmjs.com.

**Note, 2026-11-19:** `0.0.1-test.3` was published on 2026-11-19 with shasum `6c73c26d…`. `0.0.1-test.4` carries a fix found on the owner's Mac (Docker Desktop 28.5.1): when the pinned task image had been deleted, `ensureImage` stopped with `INSPECT_FAILED` instead of rebuilding, because Docker 28.5.1 answers `Error response from daemon: {"message":"No such image: sha256:…"}` and only the plain forms were recognised. The JSON-wrapped form is now accepted when it is one object whose only key is `message` and whose value names the pinned image; anything else still stops.

*Earlier status, 2026-11-19, later:* `0.0.1-test.1` is on npm, published by the owner through path B. The trusted publisher is added, with staging required, and `0.0.1-test.2` is the first version for the workflow to stage. [What happened.](#2026-11-19-the-first-publish-and-staged-publishing)

*Earlier still, 2026-11-19:* built, not published. The workflow hadn't run.

The owner decided on 2026-11-19 to publish a marked test pre-release of Runner to npm before M7's staging run ([step 16](m7-plan.md#build-order)), so the owner and Long can run it with `npx`. This narrows [decision 26](spec/PRODUCT.md#decisions-needed) for this pre-release only. The gated release is unchanged, and once M7's step 17 passes it supersedes this one.

## The terms

- **Package:** the unscoped `podster`. The owner has no `@podster` organization, and `npm view podster` showed it unpublished on 2026-11-19.
- **Version:** `0.0.x-test.N`, starting at `0.0.1-test.1`.
- **Tag:** published only under npm's `test` dist-tag. npm may also point `latest` at the first version, because a package's first publish gets `latest` when it has none; step 4 checks.
- **Gateway:** staging's, `https://gateway-staging.podster.dev`, by default. `pair --gateway <origin>` still names another.
- **Unattended runs:** off by default, as before.
- **Install:** the package ships `npm-shrinkwrap.json`, the same tree as `package-lock.json`, so an install gets exactly what CI tested. No production dependency has an install script, so users run it with scripts off: `npx --ignore-scripts podster@test …`.
- **Publisher:** only `.github/workflows/runner-prerelease.yml`, run by hand from `main` by the architect (since 2026-11-20), behind the GitHub environment `npm-test-prerelease`, with npm provenance and npm trusted publishing (OIDC). There's no npm token secret.
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

## 2026-11-19: the first publish and staged publishing (superseded 2026-11-20)

*Superseded:* on 2026-11-20 the owner ruled that versions publish directly, without a staged approval (see the ruling at the top). The workflow runs `npm publish`, and the owner ticks "Allow npm publish" on the trusted publisher. What follows is the record of why staging was used.

**Path B was done for `0.0.1-test.1`.** The owner ran the workflow with `dry_run` on (run 44559029335), checked the `.tgz` against its SHA-256 `d22db7e7…d00e3`, and published it by hand as step 3 says. `npm view podster dist-tags` then showed `{ latest: '0.0.1-test.1', test: '0.0.1-test.1' }`, as step 4 expected. npm also lists a version `0.0.0-stage`; see [the placeholder](#the-000-stage-placeholder).

**The trusted publisher was added with "Allow npm publish" off.** Step 5 was done with `thachp` / `podster` / `runner-prerelease.yml` / `npm-test-prerelease`. npm's form now has an "Allow npm publish" option, which npm marks "Not recommended" and suggests leaving off to require staged publishing. The owner left it off. So the workflow can't publish a version directly: it can only stage one, and a staged version goes live only when the owner approves it.

What npm's docs say, read 2026-11-19:

- [Trusted publishers](https://docs.npmjs.com/trusted-publishers) (last edited 2026-10-06), "Allowed actions": `npm stage publish` "is always allowed". Whether the publisher can "also publish directly with `npm publish`" is a separate choice. The page doesn't say what a plain `npm publish` prints or exits with when that choice is off.
- [Staged publishing](https://docs.npmjs.com/staged-publishing) (last edited 2026-11-10): staging needs npm 11.15.0 or later and Node 22.14.0 or later. The workflow installs npm 11.21.2.
- Approving: on npmjs.com, the **Staged Packages** tab, which the page places in your account settings, then **Approve**. Or `npm stage list podster`, then `npm stage approve <stage-id>`. Both ask for two-factor authentication, and a trusted publisher can't approve: `npm stage list`, `view`, `approve` and `reject` don't accept OIDC tokens ([trusted publishers](https://docs.npmjs.com/trusted-publishers)). `npm stage reject <stage-id>` removes a staged version.
- [`npm stage`](https://docs.npmjs.com/cli/v11/commands/npm-stage) (v11.21.3): `npm stage publish` takes `--tag`, `--access`, `--provenance`, `--dry-run` and `--otp`. The tag is fixed when the version is staged: to change it, reject the staged version and stage it again. A pre-release needs an explicit `--tag`.
- Provenance: `--provenance` is a flag of `npm stage publish`, and trusted publishing generates provenance by default. The docs don't say whether the attestation is made at staging or at approval, so step 8's check, after approval, is what settles it.
- Expiry: the docs don't say whether staged versions expire. The 2-day rule on the trusted-publisher page is about a new publisher's first publish, not about staged versions, and the docs don't say whether a staged version counts as that first publish. Approve soon after the workflow stages it.

**So the workflow ran `npm stage publish`** (until 2026-11-20) instead of `npm publish`, with the same `--provenance --tag test --access public`, the same SHA-256 check and the same jobs and permissions. A local `npm stage publish ./podster-0.0.1-test.2.tgz --dry-run --tag test` with npm 11.21.2, against an unreachable registry, accepted the `.tgz` and reported it "staged with tag test".

**The owner's step then (no longer needed),** after approving the `npm-test-prerelease` environment in GitHub: approve the staged version on npmjs.com (Staged Packages, Approve, two-factor code), or with `npm stage approve <stage-id>` at their own terminal. Until then, `npm view podster versions` doesn't list it and `npx podster@test` still gets `0.0.1-test.1`.

### The `0.0.0-stage` placeholder

npm lists it as "Temporary package placeholder for staged publishing". [Staged publishing](https://docs.npmjs.com/staged-publishing) says that when you stage a package that doesn't exist yet, npm publishes a placeholder version `0.0.0-stage`, which is public, while the staged version stays private until approved. The docs don't say whether npm removes it once a real version exists.

Whether it can or should be deprecated: npm documents deprecating one version with `npm deprecate <package>@<version> "<message>"` ([deprecating](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions)), and unpublishing one version within 72 hours of publish ([unpublishing](https://docs.npmjs.com/unpublishing-packages-from-the-registry), [policy](https://docs.npmjs.com/policies/unpublish)). None of those pages mentions the staging placeholder, so the docs don't say whether either applies to it. The architect's view: leave it. It's npm's own record, it sorts below every `0.0.x-test.N`, no tag points at it, and unpublishing a version can't be undone. If the owner wants a signpost anyway, deprecating it is the reversible choice (`npm deprecate podster@0.0.0-stage "npm's staging placeholder; use podster@test"`); that's the owner's, at their own terminal, and agents don't run it.

**Step 7 still applies, with or without staging.** Once the first workflow version is approved and live, set publishing access to "Require two-factor authentication and disallow tokens". Staging doesn't replace it: it covers how the trusted publisher's versions go live, and step 7 covers tokens.

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

   *Done 2026-11-19, with "Allow npm publish" left off, so the workflow staged each version. [See above.](#2026-11-19-the-first-publish-and-staged-publishing)*

   **The owner's, one time, since 2026-11-20:** edit this trusted publisher and tick "Allow npm publish". Without it npm refuses the workflow's `npm publish`. No other change is needed, and the owner approves no individual version on npmjs.com.
6. **The owner's, recommended after path B:** bump `apps/runner/package.json` to `0.0.1-test.2` in a PR, then run the workflow on `main` with that version and `dry_run` off, and approve its publish job. It publishes with provenance, and `npx podster@test` then gets that version. This also uses the trusted publisher inside its 2 days.

   *Note, 2026-11-19, superseded 2026-11-20:* the workflow then staged the version. Now it publishes directly, so there is nothing to approve on npmjs.com.
7. **The owner's, required once the first workflow publish has succeeded:** in `podster`'s settings on npmjs.com, set publishing access to "Require two-factor authentication and disallow tokens". From then on, only the trusted publisher can publish.
8. **The owner's and Long's, before running a version:** check its provenance, either way:
   - `npm view podster@0.0.1-test.2 dist.attestations --json` shows a `provenance` entry with `predicateType` `https://slsa.dev/provenance/v1`. Open the attestation from the version's page on npmjs.com to see it was built from `thachp/podster`, workflow `runner-prerelease.yml`, on `refs/heads/main`.
   - Or, in an empty scratch folder: `npm init -y`, then `npm install --ignore-scripts podster@test`, then `npm audit signatures`. It reports verified registry signatures and verified attestations.

   `0.0.1-test.1` from path B has no attestation, by design.
9. **The owner's, later runs:** each new pre-release is a PR that bumps the version, then a run of the workflow on `main` with that version and `dry_run` off. *Since 2026-11-20:* the architect runs the workflow and approves the environment; the owner approves nothing on npmjs.com.

## What the workflow does

`workflow_dispatch` only, with the inputs `version` and `dry_run` (default on). Every action is pinned by full commit SHA. It has three jobs:

1. **`main-only`** fails a run from any ref but `main`, and the jobs after it are skipped.
2. **`build`** has `contents: read`, and no OIDC token or environment. It refuses a `version` input that isn't the version in `apps/runner/package.json`, or isn't `0.0.x-test.N`. Then it runs `npm ci --ignore-scripts`, the typecheck, the tests, the build and `npm pack --dry-run`. It packs the `.tgz`, prints its SHA-256, passes the file name and SHA-256 on as job outputs, and uploads the `.tgz` as an artifact kept 7 days.
3. **`publish`**, only with `dry_run` off and on `main`, runs in the `npm-test-prerelease` environment, with `contents: read` and `id-token: write`. It checks out nothing and runs no dependency code. It installs npm 11.21.2, downloads the artifact, checks the `.tgz` against build's SHA-256, then runs `npm publish ./podster-<version>.tgz --provenance --tag test --access public`, then prints the registry's `dist.shasum` and `dist.integrity` for the version (retrying a few times for propagation) and fails if the shasum differs from the packed file's. (On 2026-11-19 this step was `npm stage publish`, while the trusted publisher required staging; on 2026-11-20 it went back to `npm publish`.)

The package holds:
- `build/`;
- `git/credential-helper`, which Git runs for Runner as `/bin/sh <path>`, so it needs no execute bit;
- the two Dockerfiles, `sandbox/Dockerfile` and `claude-image/Dockerfile`, from which `run --provider-key-file` builds a missing image and pins it;
- `npm-shrinkwrap.json`;
- the README;
- `package.json`.

It has no tests, source maps, fixtures or secrets.
