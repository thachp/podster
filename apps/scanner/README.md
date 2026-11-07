# Scanner

M2 step 3: a queue consumer and a ClamAV Container. It reads each file from R2, and tells the room what it found. Rules: [upload policy](../../docs/spec/UPLOAD-POLICY.md). Design: [ADR 0006](../../docs/adr/0006-uploads-and-scanning.md).

The Container reads hostile files, so it holds no secrets, has no outbound traffic, and carries its signatures in its image. The Worker has no route, and treats every answer as if the Container could be wrong.

## What can happen to a file

| What happened | Sent to the room | Queue |
| --- | --- | --- |
| clamd says OK, and every zip reads through | `no_known_malware` | Ack |
| clamd finds something | `malware_found` | Ack |
| Password-protected, limits, damaged, wrong hash or size, missing | `unreadable` | Ack |
| Scanner never answers, a stall, clamd dies, a bad answer | Nothing | Retry |
| Signatures past 7 days old | Nothing | Retry |
| The room answers 404, 409 or 422 | | Ack, logged as `not_recorded` |
| The room answers anything else | | Retry |

Retries run out at about 25 minutes, in the dead-letter queue, which records nothing. The room's own sweep ends the file as Scan failed after an hour. So the scanner never reports `failed`, and nothing here can turn a failure into a pass.

## Shapes

Queue message:

```json
{ "v": 1, "workspace_id": "...", "object_id": "...", "key": "...", "size": 123, "sha256": "<hex>" }
```

`POST /internal/scan-result` over the service binding, with header `x-podster-scanner`, from the Worker's secret `SCANNER_SECRET`:

```json
{ "v": 1, "workspace_id": "...", "object_id": "...", "report": "no_known_malware", "reason": "none", "sha256": "<hex>", "bytes": 123, "database": { "engine": "1.5.4", "version": "28176", "built_at": "2026-11-07T06:24:18Z" }, "scanned_at": 1794000000000 }
```

`report` uses the words `ScanOutcome::from_report` reads. There's no idempotency key, because the room runs `record_scan` each time and a report can only tighten. `reason` can be a signature name, so it's stored and never logged.

## Signatures

They come in the image ([decision 83](../../docs/spec/PRODUCT.md#decisions-needed)). The build runs `freshclam`, then fails unless the database is under 3 days old, then removes `freshclam`. A rebuild has to skip Docker's layer cache, or it keeps the old signatures.

**Proposed:** rebuild and deploy daily. Past 7 days files stop getting verdicts ([decision 84](../../docs/spec/PRODUCT.md#decisions-needed)), so daily leaves six failed runs to notice before anyone's affected. Creating the schedule needs the owner.

## Tests

```bash
npm ci && npm run typecheck && npm test
```

```bash
npm run test:container
```

The Container's tests use a fake clamd and need only Python. The two below need Docker and the signature mirror, so they aren't in CI:

```bash
docker build --no-cache -t podster-scanner:local container
```

```bash
python3 container/tests/integration.py podster-scanner:local
```

```bash
npm run test:local
```
