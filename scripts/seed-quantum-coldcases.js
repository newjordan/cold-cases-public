#!/usr/bin/env node
// Seeds REAL cold cases transcribed from the ecdsafail-challenge (quantum_ec) project's
// documented failed/abandoned attempts. No fabricated data: every command, metric, failure
// reason, and revive condition is transcribed from the source files below, and every
// `zipSha256` is computed here from the real referenced evidence file at submit time.
//
// Usage:
//   COLD_CASES_BASE_URL=http://127.0.0.1:3001 \
//   COLD_CASES_AGENT_TOKEN=replace-with-agent-token \
//   QUANTUM_EC_ATTEMPTS_LOG=/path/to/creative_attempts_log.md \
//   QUANTUM_EC_CLIFF_DOC=/path/to/CLIFF.md \
//   QUANTUM_EC_OPS_BIN=/path/to/ops.bin \
//   node scripts/seed-quantum-coldcases.js
//
// Idempotent: each record carries a stable clientRecordId, so re-running returns the
// existing case instead of creating duplicates.

const crypto = require("node:crypto");
const fs = require("node:fs");

const BASE_URL = requiredEnv("COLD_CASES_BASE_URL").replace(/\/+$/, "");
const TOKEN = requiredEnv("COLD_CASES_AGENT_TOKEN");
const REPO_URL = "https://github.com/ecdsafail/ecdsafail-challenge";

const ATTEMPTS_LOG = requiredEnv("QUANTUM_EC_ATTEMPTS_LOG");
const CLIFF_DOC = requiredEnv("QUANTUM_EC_CLIFF_DOC");
const OPS_BIN = requiredEnv("QUANTUM_EC_OPS_BIN");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256OfFile(path) {
  const buf = fs.readFileSync(path);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const PROVENANCE =
  "Metadata-only transcription of a documented attempt in the ecdsafail-challenge repo. " +
  "Cold Cases did not upload, mirror, download, unpack, or hash the research payload; " +
  "zipSha256 is the submitter-computed SHA256 of the referenced evidence file.";

// Each record names the real evidence file it was transcribed from; its zipSha256 is
// computed from that file at submit time.
const RECORDS = [
  {
    clientRecordId: "quantum-ec/attempt-1-mhist-hmr",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 affine point-add — classical m_hist via HMR + phase correction",
    failureClass: "correctness_failure",
    command: "./benchmark.sh   # _mc forward/backward variants: HMR after step 2 + cz_if phase corrections",
    metric: "Classical correctness PASS (0 mismatches); 320 phase-garbage batches across 5 seeds x 4096 shots (FAIL).",
    failureReason:
      "HMR yields a RANDOM classical bit, not the stored quantum value. Phase correction can " +
      "disentangle a measurement-collapsed qubit for single-use cases, but m_hist is reloaded in " +
      "the backward pass, where the random classical bit cannot represent the entangled-with-input value.",
    reviveCondition:
      "Only revive if m_hist can be restricted to qubits never used after measurement, or via a " +
      "measure-restore on a fresh ancilla copy whose added cost still nets the ~407-qubit saving.",
    tags: ["quantum", "secp256k1", "qubit-reduction", "phase-leak"]
  },
  {
    clientRecordId: "quantum-ec/attempt-2-step9-removal",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 affine point-add — step-9 cswap removal with persistent a_f",
    failureClass: "correctness_failure",
    command: "./benchmark.sh   # remove redundant swap-back cswap at end of each Kaliski iter",
    metric: "Python pre-check: only 13/30 trials match final (u,v,r,s) after 407 iters, even with a final parity-swap correction.",
    failureReason:
      "a_k is computed from CURRENT register contents. Without step 9, register state evolves " +
      "differently each round, so a_{k+1} diverges from the with-step-9 variant. The two variants " +
      "compute DIFFERENT TRAJECTORIES, not results differing only by a swap.",
    reviveCondition:
      "Would require a Kaliski reformulation that does not depend on the swap-back invariant; " +
      "likely structurally impossible for binary EEA as currently expressed.",
    tags: ["quantum", "secp256k1", "kaliski", "toffoli-reduction"]
  },
  {
    clientRecordId: "quantum-ec/attempt-3-rowwise-mul",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 affine point-add — rowwise schoolbook mul (n-wide tmp vs 2n)",
    failureClass: "metric_regression",
    command: "KAL_ROWWISE_MUL=1 ./benchmark.sh   # mod_mul_add_rowwise_into_acc via cmod_add_qq + mod_double_inplace_fast",
    metric: "At pair1_mul1: correctness PASS, peak unchanged at 2716 qubits, Toffoli +300k. All three mul sites: 1 phase-garbage batch.",
    failureReason:
      "The rowwise mul's uncompute via halve-back has a rare edge case that leaks phase, likely an " +
      "intermediate tmp value crossing a boundary mod_halve does not handle cleanly. Peak did not " +
      "drop (other phases hit the same 2716 peak) while Toffoli rose 300k.",
    reviveCondition:
      "Revive only if the halve-back uncompute is made phase-exact at tmp boundaries AND a peak-" +
      "dominant phase (not just pair1_mul1) is converted, so the 256-qubit saving actually lowers peak.",
    tags: ["quantum", "secp256k1", "multiplier", "peak-qubits", "phase-leak"]
  },
  {
    clientRecordId: "quantum-ec/attempt-4-nonfast-cuccaro",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 affine point-add — non-fast cuccaro in backward step 4",
    failureClass: "metric_regression",
    command: "./benchmark.sh   # cuccaro_sub/add (no carry ancilla) in place of _fast variants at backward step 4",
    metric: "Correctness PASS; peak UNCHANGED (forward mul1 remains dominant peak); Toffoli +330k.",
    failureReason:
      "Dropping the carry ancilla at backward step 4 does not reduce the global peak because the " +
      "forward mul1 phase still dominates, while removing the fast path costs +330k Toffoli.",
    reviveCondition:
      "Only worthwhile if combined with a reduction of the forward mul1 peak so the freed qubits " +
      "actually move the global maximum.",
    tags: ["quantum", "secp256k1", "adder", "peak-qubits"]
  },
  {
    clientRecordId: "quantum-ec/attempt-6-jacobian",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 point-add — internal Jacobian coordinates to drop one inversion",
    failureClass: "metric_regression",
    command: "./benchmark.sh   # Jacobian add (4 muls + 3 squarings) + 1 Kaliski + 2 muls for affine conversion",
    metric: "Classical 100/100 match affine; cost model ~5.5M Toffoli vs current 4.18M (worse); peak ~2700q (no reduction).",
    failureReason:
      "Jacobian add costs ~2.8M Toffoli (1.4M forward + 1.4M backward) plus a final ~1.6M Kaliski " +
      "and 2 muls for affine conversion = ~5.5M, exceeding the 4.18M baseline. Jacobian temps also " +
      "peak ~2560-2700q, so it is not a peak reduction either.",
    reviveCondition:
      "Revive only with a scheme that amortizes the inversion across multiple point-adds (batched/" +
      "Montgomery-trick inversion) so the per-add cost falls below the single-inversion affine baseline.",
    tags: ["quantum", "secp256k1", "jacobian", "cost-model"]
  },
  {
    clientRecordId: "quantum-ec/attempt-7-coset",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 point-add — coset representation (Zalka / Gidney-Ekera 2021)",
    failureClass: "abandoned",
    command: "design-only (not implemented) — coset modular arithmetic, target 2n -> ~1.5n CCX modular add",
    metric: "Potential 33% modular-add reduction (2n -> ~1.5n CCX); blocked before implementation.",
    failureReason:
      "The harness checks get_register == expected mod p. Coset-form registers hold jN + x, which " +
      "matches mod p but exceeds n bits, so the harness rejects it. Options were to edit the harness " +
      "(out of scope under the 'only edit src/point_add' constraint) or use c_pad=0 and accept rare " +
      "errors (fails the 100% correctness gate).",
    reviveCondition:
      "Revive if the harness is extended to validate output mod p for coset-form registers, or if " +
      "c_pad is implemented with a bounded-error analysis (per Gidney-Ekera) that stays within the " +
      "harness's allowed approximate-correctness tolerance.",
    tags: ["quantum", "secp256k1", "coset", "harness-constraint"]
  },
  {
    clientRecordId: "quantum-ec/attempt-9-iter-floor",
    source: ATTEMPTS_LOG,
    projectTarget: "secp256k1 point-add — fewer Kaliski iterations (sub-400 GCD steps)",
    failureClass: "abandoned",
    command: "./benchmark.sh   # sweep active iteration counts: 405, 401, 390",
    metric: "405 and 401 iters work but yield only 0.2% improvement; 390 iters fails the 24-seed test badly.",
    failureReason:
      "Kaliski convergence for secp256k1 binary EEA floors near ~400 iterations. Below ~400 the " +
      "algorithm diverges and breaks the 24-seed reproducibility test, so iteration count is an " +
      "algorithmic floor, not a tunable knob.",
    reviveCondition:
      "Only a structurally different GCD/inverse (not a lossy iteration cut) could lower the count " +
      "while preserving exact correctness across all seeds.",
    tags: ["quantum", "secp256k1", "kaliski", "iteration-count"]
  },
  {
    clientRecordId: "quantum-ec/correctability-cliff",
    source: CLIFF_DOC,
    projectTarget: "secp256k1 point-add — lossy sub-frontier score reduction (GPU island scan)",
    failureClass: "abandoned",
    command: "gpu_scout island scanner — full 0/0/0 survival, real rng, N=8192, batch-0 survival",
    metric: "active=392: -3.0M score but survival 0.868/batch -> island rarity ~1 in 4.3e8 (unreachable); trunc W=16 -> ~1 in 1e21.",
    failureReason:
      "The score oracle measures structure (Toffoli x peak), not correctability. One step past the " +
      "frontier on either lossy axis (active 393->392, truncation W=20->19) explodes clean-island " +
      "rarity to 1-in-1e8..1e21: a clean island would need a Fiat-Shamir nonce dodging every per-" +
      "input error across 9024 shots, which is exponentially impossible. Knob-tuning for lower score is dead.",
    reviveCondition:
      "Only a structurally EXACT Toffoli reduction (an equivalent reformulation with zero per-input " +
      "error) can beat the frontier; the GPU scanner can then validate correctability (~survival 1.0) in ~75s before a full hunt.",
    tags: ["quantum", "secp256k1", "gpu-scan", "correctability", "dead-end"]
  }
];

async function submit(record) {
  const zipSha256 = sha256OfFile(record.source);
  const payload = {
    projectTarget: record.projectTarget,
    repoUrl: REPO_URL,
    artifactUri: `file://${record.source}`,
    artifactKind: record.source.endsWith(".md") ? "log" : "binary",
    artifactLabel: record.source.split("/").pop(),
    zipSha256,
    command: record.command,
    metric: record.metric,
    failureClass: record.failureClass,
    failureReason: record.failureReason,
    reviveCondition: record.reviveCondition,
    provenance: PROVENANCE,
    clientRecordId: record.clientRecordId,
    projectNamespace: "ecdsafail/point-add",
    runId: "creative-attempts-2026-04-24",
    tags: record.tags
  };

  const res = await fetch(`${BASE_URL}/api/cases`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${record.clientRecordId}: HTTP ${res.status} ${JSON.stringify(body.errors || body)}`);
  }
  const id = body.case?.id || body.cert?.id;
  const replay = res.status === 200 ? " (existing)" : "";
  console.log(`  ${res.status} ${record.failureClass.padEnd(20)} ${id}${replay}  ${record.projectTarget}`);
  return id;
}

(async () => {
  console.log(`Seeding ${RECORDS.length} real cold cases -> ${BASE_URL}/api/cases (agent token)\n`);
  // ops.bin sha is referenced in provenance discussions but not required per-record here.
  void OPS_BIN;
  let ok = 0;
  for (const record of RECORDS) {
    try {
      await submit(record);
      ok += 1;
    } catch (error) {
      console.error(`  FAILED ${error.message}`);
    }
  }
  console.log(`\nDone: ${ok}/${RECORDS.length} submitted.`);
  process.exit(ok === RECORDS.length ? 0 : 1);
})();
