# ECDSF Genesis Worm — structure & comb spec

**Audience:** 20-person ECDSF (ecdsa.fail) research group working the secp256k1 quantum
point-add challenge.
**Purpose:** a shared, append-only ledger of **failed/abandoned attempts** so the group stops
re-running known dead-ends. Metadata only — no payloads, code, or weights ever leave disk.

---

## 1. What the worm IS

The worm is a **HeadChain** (existing protocol, `.codex/skills/cold-case-dump/references/headchain.md`):
a linear chain of *heads*, each embedding one valid Cold Case payload, linked by `prevHeadHash`
(server computes `headHash`). Every 10 accepted heads auto-dump into 10 Cold Case records.

- **One head = one distinct failed/abandoned attempt.** (Granularity: per-attempt, like the 8
  quantum_ec records already loaded — not per-project summaries.)
- **chainId:** `ecdsf.pointadd.genesis` *(charset [A-Za-z0-9._:-], confirm name)*.
- **Ordering:** deterministic — by real attempt date ascending, tie-break `(repo, clientRecordId)`.
  Genesis head = earliest documented attempt.

## 2. Per-head Cold Case payload (existing schema + ECDSF conventions)

| field | convention |
| --- | --- |
| `projectTarget` | `secp256k1 affine point-add — <attempt>` |
| `repoUrl` | `https://github.com/ecdsafail/ecdsafail-challenge` (real remote) |
| `projectNamespace` | `ecdsafail/point-add` |
| `runId` | the real run/experiment id from the source log |
| `command` | the real harness command (`./benchmark.sh`, real env vars/notes) |
| `metric` | real numbers — toffoli, peak qubits, score, shots, survival |
| `failureClass` | enum, via rubric below |
| `failureReason` | transcribed verbatim from the source (cite `file:line`) |
| `reviveCondition` | transcribed / distilled "what would justify retrying" |
| `artifactUri` | `file://<real evidence path>` (log/source/run dir) |
| `artifactKind` | `log` \| `source` \| `binary` \| `run` |
| `zipSha256` | **computed real SHA256** of the referenced evidence file (never invented) |
| `tags` | controlled vocab: quantum, secp256k1, kaliski, toffoli, qubit-reduction, phase-leak, coset, jacobian, montgomery, gpu-scan, correctability, iteration-floor, … |
| `clientRecordId` | `ecdsf/<repo>/<slug>` — stable → idempotent dedup |
| `provenance` | standard: metadata-only transcription; real file ref; submitter-computed SHA256 |
| head `summary` | one-line compact hot-chain summary |

### failureClass rubric (the enum is fixed in `src/validation.js`)
- `correctness_failure` — phase garbage, ancilla not zeroed, classical mismatch, wrong output.
- `metric_regression` — Toffoli / qubit / score got worse (or no win).
- `reproducibility_failure` — seed-dependent / flaky / fails N-seed test.
- `resource_exhaustion` — OOM, walltime, GPU-days-infeasible.
- `stale_loop` — parked grind, no progress at the bottom of a tail.
- `abandoned` — design dead-end / structurally blocked / out-of-scope harness change.
- `safety_boundary` — (unused for this domain).

## 3. Hard quality gates (every head)
1. **Real or it doesn't ship.** Each record cites a real `file:line`; numbers must match the
   source. No fabrication, no rounding-as-fact.
2. **Schema-valid** — passes `validateCertInput` (all required fields, 64-hex SHA, valid enum).
3. **Deduped** — by `clientRecordId` and by content across sibling repos (quantum_ec vs
   ecdsafail-rnd vs ecdsafail-control are near-forks; the same attempt must collapse to one head).
4. **Adversarially verified** — an independent agent confirms the claim is real and correctly
   classified before it enters the chain.

## 4. The comb operation (team of Sonnet agents — a Workflow)

- **Phase 0 · Manifest** (1–2 scouts): enumerate real failure-evidence files in the in-scope
  repos; cluster into candidate *attempts*; emit a worklist (no extraction yet).
- **Phase 1 · Comb** (fan-out, Sonnet — partitioned by evidence-cluster, ~8–16 agents): each
  agent extracts structured candidate records from its slice, with `file:line` citations, real
  metrics, and real commands. Read-only.
- **Phase 2 · Normalize / dedup / classify** (synthesis): merge candidates, collapse cross-repo
  duplicates, assign canonical namespace/tags/failureClass, compute real SHA256 per evidence
  file, order deterministically, assign `seq`.
- **Phase 3 · Verify** (adversarial fan-out): each record independently checked real + correctly
  classified + schema-valid; rejects are dropped/flagged.
- **Phase 4 · Manifest emit**: ordered JSONL of heads + a human summary table → **owner review**.
- **Phase 5 · Assemble** (on approval): submit heads in order to
  `/api/headchains/{chainId}/heads` with `prevHeadHash` linking; verify 10-head dump batching;
  output the genesis worm + resulting case IDs.

## 5. Open scope decision (blocking)
- Which of `quantum_ec`, `ecdsafail-rnd`, `ecdsafail-control`, `quantum-fleet` are in-scope for a
  worm shared with all 20 researchers? `rnd`/`control` may be private and must be excluded if so.
- Confirm chainId name.
