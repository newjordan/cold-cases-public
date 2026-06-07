# ECDSF Cold Cases Mod

## Decision

Build an optional **ECDSF Cold Cases Mod** as a fork or branch of the
`ecdsafail-challenge` repository. The mod retargets Cold Cases to the ECDSF
research group's workflow without becoming an upstream pull request, payload
host, database, or replacement for the core Cold Cases app.

The mod is an add-on distribution:

- Researchers can adopt it if they want the Cold Cases workflow in their local
  ECDSF challenge workspace.
- The upstream ECDSF project does not need to merge it.
- The core Cold Cases app remains the authoritative ledger.
- GitHub remains a coordination and review surface, not artifact storage.

## Goal

Give a 20-40 researcher group a low-friction way to collate failed,
abandoned, stale-loop, or unreproducible ECDSF research attempts into a shared
metadata corpus named `corpus_newjordan`.

The group needs:

- A base corpus seeded from Newjordan's known cold cases, leads, and research
  metadata.
- Per-researcher opt-in profiles.
- Local manifest files that can be reviewed before submission.
- ECDSF-specific field conventions, metrics, tags, and failure-class guidance.
- One command to validate local metadata.
- One command to submit metadata-only records to a configured Cold Cases
  instance.
- No artifact uploads, no repository spam, and no public exposure by accident.

## Non-Goals

The ECDSF mod must not:

- Become a pull request requirement for upstream ECDSF.
- Host zips, datasets, model weights, logs, binaries, checkpoints, or payloads.
- Copy, mirror, download, unpack, hash-stream, or verify external artifacts.
- Store `.env`, tokens, database files, local credentials, or private keys.
- Replace the Cold Cases Express/SQLite ledger.
- Pretend submitter-provided hashes are independently verified.
- Publish private artifact paths or tailnet/local host details.

## Architecture

There are three separate surfaces.

### 1. Core Cold Cases App

Repository: `cold_case`

Role:

- Owns the database.
- Stores canonical Cold Case receipts.
- Stores append-only create, amend, hide, and HeadChain event history.
- Authenticates submitters through GitHub OAuth or agent bearer tokens.
- Provides `/api/cases`, `/api/facets`, `/api/schema`, and HeadChain endpoints.
- Optionally pulls public metadata from trusted peer instances.

This app is the source of truth.

### 2. ECDSF Cold Cases Mod

Repository or branch: fork/mod of `ecdsafail-challenge`

Role:

- Provides ECDSF-specific schemas, manifests, prompts, and scripts.
- Gives researchers a familiar workspace inside the challenge repo shape.
- Lets researchers opt in by adding a profile and metadata manifest.
- Validates records locally before submission.
- Submits valid metadata-only records to a configured Cold Cases instance.

This mod is an adapter and workflow kit. It is not the ledger.

### 3. Optional Public Relay

Role:

- Later static, sanitized read-only projection for public agents.
- Only includes approved public-safe metadata.
- Redacts local, SMB, file, tailnet, private IP, private hostname, and home-path
  artifact references.

This is not required for the group pilot.

## Recommended Fork Branch

Use a branch name that makes the add-on nature obvious:

```text
cold-cases/corpus_newjordan
```

Avoid names that imply upstream acceptance:

- `feature/cold-cases`
- `fix/cold-cases`
- `pr/cold-cases`
- `upstream-cold-cases`

## Mod Directory Layout

Place all add-on files under one top-level directory so the fork remains easy
to rebase against upstream ECDSF:

```text
coldcases/
  README.md
  GROUP_CORPUS.md
  corpus_newjordan.json
  researchers/
    template.json
    newjordan.json
  manifests/
    newjordan.seed.jsonl
  schemas/
    ecdsf.case.schema.json
    researcher.schema.json
    manifest.schema.json
  scripts/
    extract_candidates.js
    validate_manifest.js
    submit_to_cold_cases.js
  prompts/
    agent-intake.md
    verifier.md
  examples/
    cold-case.example.json
    head.example.json
```

Optional CI can live under:

```text
.github/workflows/coldcases-validate.yml
```

CI should validate manifests only. It must not submit records, fetch
artifacts, or touch payloads.

## Corpus Descriptor

File:

```text
coldcases/corpus_newjordan.json
```

Purpose:

- Names the base corpus.
- Defines ECDSF conventions.
- Defines default namespace, tags, and chain id.
- Documents the submission endpoint contract without storing secrets.

Example:

```json
{
  "schema": "cold_cases.ecdsf_corpus.v1",
  "corpusId": "corpus_newjordan",
  "displayName": "Newjordan ECDSF Cold Cases",
  "projectNamespace": "ecdsf/point-add",
  "defaultChainId": "ecdsf.pointadd.corpus_newjordan",
  "artifactPolicy": "metadata_only",
  "hashPolicy": "submitter_provided_or_local_researcher_computed",
  "payloadBoundary": [
    "no_upload",
    "no_mirror",
    "no_download",
    "no_unpack",
    "no_hash_stream_by_cold_cases"
  ],
  "submitTargetEnv": {
    "baseUrl": "COLD_CASES_BASE_URL",
    "agentToken": "COLD_CASES_AGENT_TOKEN"
  }
}
```

## Researcher Opt-In Profile

Each researcher opts in by adding one profile:

```text
coldcases/researchers/<handle>.json
```

Example:

```json
{
  "schema": "cold_cases.ecdsf_researcher.v1",
  "handle": "newjordan",
  "displayName": "Newjordan",
  "corpusId": "corpus_newjordan",
  "projectNamespace": "ecdsf/point-add",
  "defaultTags": ["ecdsf", "secp256k1", "point-add"],
  "visibilityDefault": "group",
  "artifactContactPolicy": "handled_outside_cold_cases",
  "optInStatement": "I want my metadata-only cold cases included in corpus_newjordan."
}
```

Required fields:

- `schema`
- `handle`
- `corpusId`
- `projectNamespace`
- `visibilityDefault`
- `optInStatement`

No token or secret belongs in this file.

## Manifest Rows

Each researcher keeps local metadata rows in:

```text
coldcases/manifests/<handle>.jsonl
```

One line equals one cold case attempt.

Rows should be compatible with the core Cold Cases `/api/cases` schema, plus
ECDSF mod metadata.

Example:

```json
{"schema":"cold_cases.ecdsf_case.v1","corpusId":"corpus_newjordan","researcherId":"newjordan","clientRecordId":"ecdsf/newjordan/pointadd-kaliski-phase-leak-001","projectNamespace":"ecdsf/point-add","projectTarget":"secp256k1 affine point-add - kaliski phase leak attempt","repoUrl":"https://github.com/ecdsafail/ecdsafail-challenge","artifactUri":"file://local/researcher/path/redacted-or-private","artifactKind":"log","artifactLabel":"local point-add failure log","zipSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","command":"./benchmark.sh --attempt kaliski-phase-leak","metric":"toffoli=unknown; peak_qubits=unknown; failed correctness check","failureClass":"correctness_failure","failureReason":"Phase garbage was not uncomputed; output did not match the classical point-add oracle. Source citation required before submission.","reviveCondition":"Retry only if the circuit includes an explicit uncompute path and passes a classical oracle comparison on the same seed set.","provenance":"Metadata-only ECDSF manifest row; artifact reference and SHA256 supplied by researcher; payload not uploaded or inspected by Cold Cases.","tags":["ecdsf","secp256k1","point-add","phase-leak","correctness"]}
```

Required Cold Cases fields:

- `projectTarget`
- `repoUrl`
- `zipSha256`
- `command`
- `metric`
- `failureClass`
- `failureReason`
- `reviveCondition`
- `provenance`
- `hostedZipUrl` or `artifactUri`

Required ECDSF mod fields:

- `schema`
- `corpusId`
- `researcherId`
- `clientRecordId`
- `projectNamespace`
- `tags`

## ECDSF Field Conventions

### corpusId

Use:

```text
corpus_newjordan
```

This groups the base corpus and opt-in researcher additions.

### projectNamespace

Use stable namespaces:

```text
ecdsf/point-add
ecdsf/rnd
ecdsf/control
ecdsf/quantum-fleet
```

Only include private namespaces in group-shared manifests if the owner has
explicitly opted in.

### clientRecordId

Use a stable idempotency key:

```text
ecdsf/<researcher>/<domain>/<slug>
```

Example:

```text
ecdsf/newjordan/point-add/kaliski-phase-leak-001
```

Do not include timestamps unless the attempt is genuinely time-scoped. Stable
IDs make retries safe.

### failureClass

Use only the core enum:

- `correctness_failure`
- `metric_regression`
- `reproducibility_failure`
- `resource_exhaustion`
- `safety_boundary`
- `stale_loop`
- `abandoned`

ECDSF guidance:

- Use `correctness_failure` for wrong point output, phase garbage, unclean
  ancilla, failed oracle comparison, or non-equivalent circuit behavior.
- Use `metric_regression` for worse Toffoli count, qubit count, depth, runtime,
  memory, score, or no meaningful win over baseline.
- Use `reproducibility_failure` for seed-dependent success, flaky harness
  behavior, or failure to reproduce a claimed improvement.
- Use `resource_exhaustion` for infeasible GPU-days, walltime, memory, solver
  explosion, or circuit size explosion.
- Use `stale_loop` for repeated grind with no new mechanism or no movement at
  the bottom of a search tail.
- Use `abandoned` for a design dead-end or approach intentionally parked.
- Use `safety_boundary` only when the record is blocked by legal, safety,
  access, or disclosure constraints.

### tags

Prefer controlled tags:

```text
ecdsf
secp256k1
point-add
kaliski
toffoli
qubit-reduction
phase-leak
coset
jacobian
montgomery
gpu-scan
correctability
iteration-floor
oracle-check
```

Do not use long prose as tags.

## Validation Rules

The mod validator should fail closed.

Reject if:

- Required Cold Cases fields are missing.
- Required ECDSF mod fields are missing.
- `zipSha256` is not 64 hex characters.
- `failureClass` is not in the core enum.
- `corpusId` is not `corpus_newjordan` for this branch.
- `researcherId` does not have a matching opt-in profile.
- `clientRecordId` is missing or duplicated in the manifest set.
- `tags` is empty or contains non-string values.
- Any payload file is present under `coldcases/`.
- A public or group-visible row includes obvious secrets.
- A public row includes `file:`, `smb:`, `nfs:`, `ssh:`, private IPs,
  localhost, home paths, Windows drive paths, or tailnet-only hostnames.

Warn, but do not necessarily reject, if:

- `metric` lacks concrete numeric values.
- `failureReason` lacks a source citation.
- `reviveCondition` is vague.
- `artifactLabel` is missing.
- `artifactKind` is not one of the group's preferred kinds.

For the initial group pilot, warnings can block merge by reviewer policy even
if the script exits successfully. The validator should print them clearly.

## Submission Rules

Submission script:

```text
coldcases/scripts/submit_to_cold_cases.js
```

Environment:

```text
COLD_CASES_BASE_URL=https://your-private-instance.example
COLD_CASES_AGENT_TOKEN=researcher-or-operator-token
```

Behavior:

1. Read one or more JSONL manifests.
2. Validate all rows before submitting any row.
3. Convert ECDSF mod fields into core Cold Cases fields.
4. Preserve `corpusId` and `researcherId` in tags or in dedicated fields once
   the core app supports them.
5. POST each row to `/api/cases`.
6. Treat HTTP 200 idempotent replays as success.
7. Treat HTTP 201 creates as success.
8. Stop on any validation or server error.
9. Print returned case id, submitter login, API URL, and canonical URL.

No background submitter is needed for v1.

## HeadChain Use

The mod may provide examples for a group HeadChain:

```text
ecdsf.pointadd.corpus_newjordan
```

Use HeadChain only for ordered hot-chain coordination between agents on the
same Cold Cases instance.

Do not use HeadChain as cross-instance federation. Peer federation and public
relay are separate mechanisms.

## Researcher Workflow

1. Pull or clone the ECDSF mod branch.
2. Copy `coldcases/researchers/template.json` to
   `coldcases/researchers/<handle>.json`.
3. Fill the opt-in profile.
4. Add local metadata rows to `coldcases/manifests/<handle>.jsonl`.
5. Run:

```sh
node coldcases/scripts/validate_manifest.js coldcases/manifests/<handle>.jsonl
```

6. Review warnings.
7. Submit to the private instance:

```sh
node coldcases/scripts/submit_to_cold_cases.js coldcases/manifests/<handle>.jsonl
```

8. Keep artifacts where they already live. Only references and
   submitter-provided hashes go into Cold Cases.

## Operator Workflow

1. Provision a Cold Cases instance.
2. Create per-researcher or per-agent tokens in `AGENT_SUBMIT_TOKENS`.
3. Share `COLD_CASES_BASE_URL` and each researcher's own token out of band.
4. Review manifests before first group import.
5. Seed `corpus_newjordan` from Newjordan's base manifest.
6. Use `/api/cases?projectNamespace=ecdsf/point-add` and `/api/facets` for
   discovery until the core app has first-class `corpusId` filters.
7. Hide or amend bad records in the Cold Cases app, not by rewriting manifest
   history after submission.

## Core App Changes Needed

The core `cold_case` app should add first-class group fields before broad use:

- `corpusId`
- `researcherId`
- `visibility`

Minimum behavior:

- Accept optional `corpusId`, `researcherId`, and `visibility` in
  `/api/cases`.
- Store them in `certs`.
- Include them in canonical JSON.
- Add filters for `corpusId` and `researcherId`.
- Add facets for corpora and researchers.
- Default `visibility` to `group` for private group deployments, or `private`
  for public-facing deployments.

Until these fields exist, use:

- `projectNamespace`: `ecdsf/point-add`
- `tags`: include `corpus:corpus_newjordan` and `researcher:<handle>`
- `clientRecordId`: include researcher and corpus in the id

## Execution Plan

### Phase 0: Freeze the Contract

Deliverables:

- This document.
- A concise `coldcases/README.md` for the mod.
- `corpus_newjordan.json`.
- `researchers/template.json`.
- One example manifest row.

Acceptance:

- A researcher can understand the mod without reading the core app.
- The doc states clearly that the fork is an add-on, not an upstream PR.
- No payload files are introduced.

### Phase 1: Scaffold the ECDSF Mod

Deliverables:

- Directory structure under `coldcases/`.
- JSON schemas.
- `validate_manifest.js`.
- Example manifest.
- Optional GitHub Actions validation workflow.

Acceptance:

- Validator passes the example manifest.
- Validator rejects missing required fields.
- Validator rejects payload-like files under `coldcases/`.
- Validator rejects duplicate `clientRecordId`.
- Validator rejects invalid failure classes and malformed SHA256 values.

### Phase 2: Add Submission

Deliverables:

- `submit_to_cold_cases.js`.
- Dry-run mode.
- Idempotent retry handling.
- Summary output.

Acceptance:

- Dry run validates and prints rows without network writes.
- Real run posts to `/api/cases`.
- HTTP 200 replay and HTTP 201 create are both success.
- Any failed row stops the run and prints the failing `clientRecordId`.

### Phase 3: Patch Core Group Fields

Deliverables in `cold_case`:

- Schema support for `corpusId`, `researcherId`, and `visibility`.
- SQLite migration.
- API filters and facets.
- Tests for create, list, facet, and idempotent replay.
- README/schema updates.

Acceptance:

- `/api/cases?corpusId=corpus_newjordan` returns only that corpus.
- `/api/facets` includes corpus and researcher counts.
- Existing records still migrate.
- Existing tests still pass.

### Phase 4: Seed Base Corpus

Deliverables:

- `manifests/newjordan.seed.jsonl`.
- Review summary.
- Validation output.
- Submission receipt list.

Acceptance:

- Every seed row has a stable `clientRecordId`.
- Every seed row has a concrete revive condition.
- Every seed row has provenance.
- Submitted records return case IDs and canonical URLs.

### Phase 5: Group Onboarding

Deliverables:

- One-page onboarding doc.
- Researcher profile template.
- Manifest template.
- Token provisioning checklist.

Acceptance:

- A researcher can opt in without changing app code.
- A researcher can validate locally before submitting.
- Operator can revoke or rotate a token without changing manifests.

## Fast Path

If the group needs this immediately, do only:

1. Create the ECDSF mod branch with `coldcases/`.
2. Add `corpus_newjordan.json`.
3. Add `researchers/template.json` and `researchers/newjordan.json`.
4. Add `manifests/newjordan.seed.jsonl`.
5. Add `validate_manifest.js`.
6. Use existing Cold Cases fields:
   - `projectNamespace=ecdsf/point-add`
   - `tags=corpus:corpus_newjordan,researcher:<handle>,ecdsf,...`
   - `clientRecordId=ecdsf/<handle>/<domain>/<slug>`
7. Submit with the existing `/api/cases` endpoint.

Defer first-class `corpusId` storage until after the pilot if needed.

## Review Checklist

Before sharing the mod with researchers:

- No payload files are present.
- No secrets are committed.
- No local home paths are committed in public/group-visible examples.
- Every profile is opt-in.
- Every manifest row has a stable `clientRecordId`.
- Every row has a real or clearly provisional provenance statement.
- Every row has a revive condition.
- The submit script requires explicit `COLD_CASES_BASE_URL`.
- The submit script requires explicit `COLD_CASES_AGENT_TOKEN`.
- The README says the fork/mod is optional and not an upstream PR.

## Naming

Preferred names:

- `ECDSF Cold Cases Mod`
- `Cold Cases ECDSF Add-On`
- `corpus_newjordan adapter`

Avoid:

- `ECDSF Cold Cases PR`
- `upstream integration`
- `official ECDSF ledger`
- `public archive`

The language matters. The mod is opt-in infrastructure for the group, not an
authority over the upstream project.
