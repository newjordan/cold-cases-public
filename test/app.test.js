const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const request = require("supertest");
const { createApp } = require("../src/app");
const { openDatabase } = require("../src/db");
const { buildPublicRelayExport } = require("../src/publicRelay");
const { validateCertInput } = require("../src/validation");

const VALID_CERT = {
  projectTarget: "sloptomizer/warpgate trial 17",
  repoUrl: "https://github.com/example/research",
  hostedZipUrl: "https://example.com/research.zip",
  zipSha256: "a".repeat(64),
  command: "npm run eval -- --case trial-17",
  metric: "accuracy dropped from 0.81 to 0.12",
  failureClass: "metric_regression",
  failureReason: "The candidate regressed the acceptance metric under the locked condition.",
  reviveCondition: "Revive only if a new representation changes the measured failure mode.",
  provenance: "Submitted from local cold-case SOP receipt 2026-06-04."
};

function headPayload(index, overrides = {}) {
  return {
    schema: "cold_cases.head.v1",
    clientHeadId: `head-${index}`,
    summary: `Cold head ${index}`,
    coldCase: {
      ...VALID_CERT,
      hostedZipUrl: "",
      artifactUri: `smb://atlas/cold_case/head-${index}.zip`,
      projectTarget: `headchain target ${index}`,
      metric: `headchain metric ${index}`,
      tags: ["headchain", "worm"]
    },
    ...overrides
  };
}

function fixture() {
  const db = openDatabase(":memory:");
  const app = createApp({
    db,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-secret",
      ADMIN_GITHUB_LOGINS: "admin",
      AGENT_SUBMIT_TOKENS: "atlas:atlas-token"
    }
  });
  return { app, db };
}

async function login(agent, login = "researcher") {
  await agent.post("/__test/login").send({ login, id: `${login}-id` }).expect(200);
}

test("schema validation accepts a valid minimal cold case", () => {
  const result = validateCertInput(VALID_CERT);
  assert.equal(result.ok, true);
  assert.equal(result.cert.zipSha256, "a".repeat(64));
});

test("schema validation rejects missing required fields", () => {
  for (const field of ["repoUrl", "zipSha256", "command", "metric", "failureClass", "reviveCondition"]) {
    const input = { ...VALID_CERT, [field]: "" };
    const result = validateCertInput(input);
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`${field} is required`));
  }
});

test("schema validation accepts non-hosted artifact references", () => {
  const result = validateCertInput({
    ...VALID_CERT,
    hostedZipUrl: "",
    artifactUri: "smb://atlas/cold_case/ecc/run-17.zip",
    artifactKind: "zip",
    artifactLabel: "atlas cold_case run-17",
    artifactSizeBytes: "12345"
  });
  assert.equal(result.ok, true);
  assert.equal(result.cert.hostedZipUrl, null);
  assert.equal(result.cert.artifactUri, "smb://atlas/cold_case/ecc/run-17.zip");
  assert.equal(result.cert.artifactSizeBytes, 12345);
});

test("schema validation requires at least one artifact pointer", () => {
  const result = validateCertInput({ ...VALID_CERT, hostedZipUrl: "", artifactUri: "" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /hostedZipUrl or artifactUri is required/);
});

test("schema validation rejects invalid failure class, URLs, and hash", () => {
  const result = validateCertInput({
    ...VALID_CERT,
    failureClass: "wishful_thinking",
    repoUrl: "ftp://example.com/research",
    hostedZipUrl: "not a url",
    zipSha256: "z".repeat(64)
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /failureClass is not allowed/);
  assert.match(result.errors.join("\n"), /repoUrl must be an http\(s\) URL/);
  assert.match(result.errors.join("\n"), /hostedZipUrl must be an http\(s\) URL/);
  assert.match(result.errors.join("\n"), /zipSha256 must be a 64-character hex SHA256/);
});

test("legacy databases can store artifact-only references after migration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cold-cases-legacy-"));
  const dbPath = path.join(dir, "legacy.sqlite");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE certs (
      id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitter_login TEXT NOT NULL,
      submitter_id TEXT,
      submitter_avatar_url TEXT,
      client_record_id TEXT,
      project_namespace TEXT,
      run_id TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      project_target TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      hosted_zip_url TEXT NOT NULL,
      zip_sha256 TEXT NOT NULL,
      command TEXT NOT NULL,
      metric TEXT NOT NULL,
      failure_class TEXT NOT NULL,
      failure_reason TEXT NOT NULL,
      revive_condition TEXT NOT NULL,
      provenance TEXT NOT NULL
    );
  `);
  legacy.close();

  const db = openDatabase(dbPath);
  const app = createApp({
    db,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-secret",
      AGENT_SUBMIT_TOKENS: "atlas:atlas-token"
    }
  });
  const response = await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send({
      ...VALID_CERT,
      hostedZipUrl: "",
      artifactUri: "smb://atlas/cold_case/ecc/run-17.zip",
      artifactKind: "zip"
    })
    .expect(201);

  assert.equal(response.body.case.hostedZipUrl, null);
  assert.equal(response.body.case.artifactUri, "smb://atlas/cold_case/ecc/run-17.zip");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("public index renders without auth", async () => {
  const { app, db } = fixture();
  const response = await request(app).get("/").expect(200);

  assert.match(response.text, /Agent-first cold-case dump/);
  assert.match(response.text, /query this Cold Cases public relay at \/cases\.json/);
  assert.match(response.text, /authorized ledger endpoint configured for your environment/);
  assert.match(response.text, /metadata-only cold case/);
  assert.match(response.text, /Do not upload, mirror, download, unpack, or hash-stream artifacts/);
  assert.match(response.text, /Hook up your agent/);
  assert.match(response.text, /Ask your agent: did you pull the latest\?/);
  assert.match(response.text, /Waiting for agent dumps/);
  assert.doesNotMatch(response.text, /class="filters"/);
  assert.doesNotMatch(response.text, /class="cert-row/);
  assert.doesNotMatch(response.text, /snippet-grid/);
  assert.doesNotMatch(response.text, /api-strip/);
  db.close();
});

test("public index prompt does not echo request host information", async () => {
  const { app, db } = fixture();
  const response = await request(app).get("/").set("Host", "192.168.1.176:3002").expect(200);
  assert.doesNotMatch(response.text, /192\.168\.1\.176/);
  assert.doesNotMatch(response.text, /3002/);
  db.close();
});

test("public index activity map renders populated metadata without case rows", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  await agent.post("/api/cases").send({
    ...VALID_CERT,
    projectTarget: "homepage unique target should not be browsed",
    projectNamespace: "homepage/ns",
    artifactKind: "zip",
    failureClass: "stale_loop"
  }).expect(201);

  const response = await request(app).get("/").expect(200);
  assert.match(response.text, /Visible activity map/);
  assert.match(response.text, /1 total/);
  assert.match(response.text, /homepage\/ns/);
  assert.match(response.text, /stale_loop/);
  assert.match(response.text, /zip/);
  assert.match(response.text, /researcher/);
  assert.doesNotMatch(response.text, /homepage unique target should not be browsed/);
  assert.doesNotMatch(response.text, /class="cert-row/);
  db.close();
});

test("unauthenticated submit is rejected", async () => {
  const { app, db } = fixture();
  await request(app).post("/api/cases").send(VALID_CERT).expect(401);
  await request(app).get("/submit").expect(401);
  db.close();
});

test("agent token submit creates cold case under agent profile", async () => {
  const { app, db } = fixture();
  const response = await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send({
      ...VALID_CERT,
      clientRecordId: "atlas/run-1/case-1",
      projectNamespace: "atlas/ecc",
      runId: "run-1",
      tags: ["ecc", "smoke"]
    })
    .expect(201);

  assert.equal(response.body.case.submitterLogin, "agent:atlas");
  assert.equal(response.body.case.clientRecordId, "atlas/run-1/case-1");
  assert.equal(response.body.case.projectNamespace, "atlas/ecc");
  assert.equal(response.body.case.runId, "run-1");
  assert.deepEqual(response.body.case.tags, ["ecc", "smoke"]);
  assert.equal(response.body.case.events[0].actorLogin, "agent:atlas");
  db.close();
});

test("clientRecordId makes agent submissions idempotent per profile", async () => {
  const { app, db } = fixture();
  const payload = { ...VALID_CERT, clientRecordId: "stable-agent-key", tags: "retry, smoke" };
  const first = await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send(payload)
    .expect(201);
  const second = await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send({ ...payload, metric: "changed but should not create duplicate" })
    .expect(200);

  assert.equal(second.body.case.id, first.body.case.id);
  assert.equal(second.body.case.idempotentReplay, true);
  assert.deepEqual(second.body.case.tags, ["retry", "smoke"]);
  const listed = await request(app).get("/api/cases").expect(200);
  assert.equal(listed.body.page.total, 1);
  db.close();
});

test("agent schema and canonical JSON endpoints are machine-readable", async () => {
  const { app, db } = fixture();
  const created = await request(app)
    .post("/api/cases")
    .set("X-Cold-Cases-Agent-Token", "atlas-token")
    .send(VALID_CERT)
    .expect(201);

  const schema = await request(app).get("/api/schema").expect(200);
  assert.equal(schema.body.schema, "cold_cases.agent_dump.v1");
  assert.deepEqual(schema.body.query.filters, ["q", "projectTarget", "projectNamespace", "runId", "failureClass", "submitter", "repo", "artifactKind", "tag", "date"]);
  assert.equal(schema.body.endpoints.facets, "/api/facets");
  assert.equal(schema.body.endpoints.getCanonicalJson, "/api/cases/{id}/canonical");
  assert.equal(schema.body.auth.agent, "Bearer token from AGENT_SUBMIT_TOKENS, attributed as agent:{profile}");

  const canonical = await request(app).get(`/api/cases/${created.body.case.id}/canonical`).expect(200);
  assert.equal(canonical.body.schema, "cold_cases.cold_case.v1");
  assert.equal(canonical.body.submitter.login, "agent:atlas");
  db.close();
});

test("headchain API requires authentication", async () => {
  const { app, db } = fixture();
  await request(app).get("/api/headchains/atlas/head").expect(401);
  await request(app).get("/api/headchains/atlas/heads").expect(401);
  await request(app).post("/api/headchains/atlas/heads").send(headPayload(1)).expect(401);
  db.close();
});

test("agent tokens can poll and post a genesis head", async () => {
  const { app, db } = fixture();
  const empty = await request(app)
    .get("/api/headchains/atlas/head")
    .set("Authorization", "Bearer atlas-token")
    .expect(200);
  assert.equal(empty.body.chain.latestSeq, 0);
  assert.equal(empty.body.head, null);

  const created = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(1))
    .expect(201);

  assert.equal(created.body.head.seq, 1);
  assert.equal(created.body.head.prevHeadHash, null);
  assert.equal(created.body.head.authorLogin, "agent:atlas");
  assert.equal(created.body.head.coldCase.artifactUri, "smb://atlas/cold_case/head-1.zip");
  assert.match(created.body.head.headHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(created.body.dumpedCases, []);

  const latest = await request(app)
    .get("/api/headchains/atlas/head")
    .set("Authorization", "Bearer atlas-token")
    .expect(200);
  assert.equal(latest.body.chain.latestSeq, 1);
  assert.equal(latest.body.chain.latestHash, created.body.head.headHash);
  assert.equal(latest.body.head.clientHeadId, "head-1");
  db.close();
});

test("headchain requires matching prevHeadHash and exposes catch-up heads", async () => {
  const { app, db } = fixture();
  const first = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(1))
    .expect(201);

  await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(2, { prevHeadHash: "b".repeat(64) }))
    .expect(409)
    .expect((response) => {
      assert.match(response.body.errors.join("\n"), /prevHeadHash does not match/);
      assert.equal(response.body.latestHead.headHash, first.body.head.headHash);
    });

  const second = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(2, { prevHeadHash: first.body.head.headHash }))
    .expect(201);
  assert.equal(second.body.head.seq, 2);

  const catchup = await request(app)
    .get("/api/headchains/atlas/heads?afterSeq=1&limit=10")
    .set("Authorization", "Bearer atlas-token")
    .expect(200);
  assert.equal(catchup.body.heads.length, 1);
  assert.equal(catchup.body.heads[0].clientHeadId, "head-2");
  assert.equal(catchup.body.heads[0].prevHeadHash, first.body.head.headHash);
  db.close();
});

test("duplicate clientHeadId returns the existing accepted head", async () => {
  const { app, db } = fixture();
  const first = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(1))
    .expect(201);

  const replay = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(1, {
      summary: "changed summary ignored",
      prevHeadHash: "c".repeat(64)
    }))
    .expect(200);

  assert.equal(replay.body.head.headHash, first.body.head.headHash);
  assert.equal(replay.body.head.idempotentReplay, true);
  const listed = await request(app)
    .get("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .expect(200);
  assert.equal(listed.body.heads.length, 1);
  db.close();
});

test("ten accepted heads create ten cold cases and mark dumped heads", async () => {
  const { app, db } = fixture();
  let prevHeadHash = null;
  let tenth;
  for (let index = 1; index <= 10; index += 1) {
    const response = await request(app)
      .post("/api/headchains/atlas/heads")
      .set("Authorization", "Bearer atlas-token")
      .send(headPayload(index, { prevHeadHash }))
      .expect(201);
    prevHeadHash = response.body.head.headHash;
    if (index < 10) assert.deepEqual(response.body.dumpedCases, []);
    if (index === 10) tenth = response;
  }

  assert.equal(tenth.body.dumpedCases.length, 10);
  assert.deepEqual(tenth.body.dumpedCases.map((item) => item.submitterLogin), Array(10).fill("agent:atlas"));
  assert.equal(tenth.body.dumpedCases[0].clientRecordId.startsWith("headchain/atlas/"), true);

  const cases = await request(app).get("/api/cases?submitter=agent:atlas").expect(200);
  assert.equal(cases.body.page.total, 10);

  const heads = await request(app)
    .get("/api/headchains/atlas/heads?limit=20")
    .set("Authorization", "Bearer atlas-token")
    .expect(200);
  assert.equal(heads.body.heads.length, 10);
  for (const head of heads.body.heads) {
    assert.ok(head.dumpedAt);
    assert.ok(head.caseId);
  }

  const replay = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(10, { prevHeadHash: heads.body.heads[8].headHash }))
    .expect(200);
  assert.deepEqual(replay.body.dumpedCases, []);
  const afterReplay = await request(app).get("/api/cases?submitter=agent:atlas").expect(200);
  assert.equal(afterReplay.body.page.total, 10);
  db.close();
});

test("headchain rejects incomplete embedded cold case payloads", async () => {
  const { app, db } = fixture();
  const response = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send(headPayload(1, { coldCase: { ...VALID_CERT, zipSha256: "" } }))
    .expect(400);
  assert.match(response.body.errors.join("\n"), /coldCase.zipSha256 is required/);
  db.close();
});

test("list API supports pagination, filters, and facets", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  await agent.post("/api/cases").send({
    ...VALID_CERT,
    projectTarget: "case one",
    projectNamespace: "ns/ecc",
    runId: "run-a",
    artifactKind: "zip",
    tags: ["ecc", "gpu"]
  }).expect(201);
  await agent.post("/api/cases").send({
    ...VALID_CERT,
    projectTarget: "case two",
    failureClass: "stale_loop",
    projectNamespace: "ns/ecc",
    runId: "run-b",
    artifactKind: "log",
    tags: ["ecc", "stale"]
  }).expect(201);

  const page = await request(app).get("/api/cases?limit=1&offset=0&projectNamespace=ns/ecc&tag=ecc").expect(200);
  assert.equal(page.body.cases.length, 1);
  assert.equal(page.body.page.total, 2);
  assert.equal(page.body.page.limit, 1);
  assert.equal(page.body.page.nextOffset, 1);

  const facets = await request(app).get("/api/facets?projectNamespace=ns/ecc").expect(200);
  assert.equal(facets.body.facets.total, 2);
  assert.deepEqual(facets.body.facets.projectNamespaces, [{ projectNamespace: "ns/ecc", count: 2 }]);
  assert.equal(facets.body.facets.failureClasses.find((item) => item.failureClass === "stale_loop").count, 1);
  assert.equal(facets.body.facets.artifactKinds.find((item) => item.artifactKind === "zip").count, 1);
  db.close();
});

test("GitHub-authenticated submit creates cold case and event log row", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);

  const response = await agent.post("/api/cases").send(VALID_CERT).expect(201);
  assert.equal(response.body.case.currentVersion, 1);
  assert.equal(response.body.case.events.length, 1);
  assert.equal(response.body.case.events[0].eventType, "create");

  await request(app).get(`/cases/${response.body.case.id}`).expect(200).expect(/Canonical JSON/);
  db.close();
});

test("amendment creates a new version and preserves prior version", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);

  const created = await agent.post("/api/cases").send(VALID_CERT).expect(201);
  const amended = await agent.post(`/api/cases/${created.body.case.id}/amend`).send({
    ...VALID_CERT,
    metric: "accuracy dropped from 0.81 to 0.14",
    failureReason: "Amended failure text with the same external artifacts."
  }).expect(200);

  assert.equal(amended.body.case.currentVersion, 2);
  assert.equal(amended.body.case.versions.length, 2);
  assert.match(amended.body.case.versions[0].canonicalJson, /0\.12/);
  assert.match(amended.body.case.versions[1].canonicalJson, /0\.14/);
  assert.deepEqual(amended.body.case.events.map((event) => event.eventType), ["create", "amend"]);
  db.close();
});

test("only original submitter or admin can amend", async () => {
  const { app, db } = fixture();
  const owner = request.agent(app);
  const other = request.agent(app);
  await login(owner, "owner");
  await login(other, "other");

  const created = await owner.post("/api/cases").send(VALID_CERT).expect(201);
  await other.post(`/api/cases/${created.body.case.id}/amend`).send(VALID_CERT).expect(403);
  db.close();
});

test("admin hide removes cold case from default index but keeps audit available to admins", async () => {
  const { app, db } = fixture();
  const submitter = request.agent(app);
  const admin = request.agent(app);
  await login(submitter, "researcher");
  await login(admin, "admin");

  const created = await submitter.post("/api/cases").send(VALID_CERT).expect(201);
  await admin.post(`/cases/${created.body.case.id}/hide`).send({ reason: "spam" }).expect(302);

  const publicIndex = await request(app).get("/api/cases").expect(200);
  assert.equal(publicIndex.body.cases.length, 0);
  await request(app).get(`/api/cases/${created.body.case.id}`).expect(404);
  await submitter.get(`/cases/${created.body.case.id}/amend`).expect(404);
  await submitter.post(`/api/cases/${created.body.case.id}/amend`).send(VALID_CERT).expect(404);

  const adminDetail = await admin.get(`/api/cases/${created.body.case.id}`).expect(200);
  assert.equal(adminDetail.body.case.hidden, true);
  assert.equal(adminDetail.body.case.currentVersion, 2);
  assert.equal(adminDetail.body.case.versions.length, 2);
  assert.equal(adminDetail.body.case.events.at(-1).eventType, "hide");
  assert.equal(adminDetail.body.case.events.at(-1).version, 2);
  assert.match(adminDetail.body.case.versions.at(-1).canonicalJson, /"hidden": true/);
  db.close();
});

// Bridges pullPeer's fetch to another in-process app via supertest, so peer
// federation can be tested offline without real network access.
function bridgeFetch(targetApp) {
  return async (url) => {
    const parsed = new URL(url);
    const res = await request(targetApp).get(parsed.pathname + parsed.search);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body
    };
  };
}

test("peer pull mirrors a peer's public cases without merging into local certs", async () => {
  const { addPeer } = require("../src/db");
  const { pullPeer } = require("../src/peers");

  const peerInstance = fixture();
  await request(peerInstance.app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send({ ...VALID_CERT, clientRecordId: "peer/case-1", projectTarget: "peer case one" })
    .expect(201);

  const local = fixture();
  const peer = addPeer(local.db, { baseUrl: "https://peer.example/", label: "peer one" });
  const result = await pullPeer(local.db, peer.id, { fetchImpl: bridgeFetch(peerInstance.app) });
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 1);
  assert.equal(result.rejected, 0);

  // The local certs table is untouched — remote data never merges into it.
  const localCases = await request(local.app).get("/api/cases").expect(200);
  assert.equal(localCases.body.cases.length, 0);

  // Mirrored cases are readable through the dedicated peer endpoint.
  const mirrored = await request(local.app).get(`/api/peers/${peer.id}/cases`).expect(200);
  assert.equal(mirrored.body.cases.length, 1);
  assert.equal(mirrored.body.cases[0].projectTarget, "peer case one");
  assert.equal(mirrored.body.cases[0].remote.zipSha256, "a".repeat(64));

  // Pull status is recorded on the peer.
  const peers = await request(local.app).get("/api/peers").expect(200);
  assert.equal(peers.body.peers[0].lastStatus, "ok");
  assert.equal(peers.body.peers[0].pulledCount, 1);

  local.db.close();
  peerInstance.db.close();
});

test("peer registration and pull are admin-only; listing is public", async () => {
  const { app, db } = fixture();

  // Listing peers is public.
  await request(app).get("/api/peers").expect(200);

  // Non-admin users cannot register a peer.
  const researcher = request.agent(app);
  await login(researcher, "researcher");
  await researcher.post("/api/peers").send({ baseUrl: "https://peer.example" }).expect(403);

  // Admins can register, and bad URLs are rejected.
  const admin = request.agent(app);
  await login(admin, "admin");
  await admin.post("/api/peers").send({ baseUrl: "ftp://nope.example" }).expect(400);
  const added = await admin.post("/api/peers").send({ baseUrl: "https://peer.example", label: "peer" }).expect(201);
  assert.equal(added.body.peer.baseUrl, "https://peer.example");
  assert.equal(added.body.peer.enabled, true);

  // Admins can remove a peer.
  await admin.delete(`/api/peers/${added.body.peer.id}`).expect(200);
  const after = await request(app).get("/api/peers").expect(200);
  assert.equal(after.body.peers.length, 0);
  db.close();
});

test("schema descriptor advertises the read-only federation endpoints", async () => {
  const { app, db } = fixture();
  const schema = await request(app).get("/api/schema").expect(200);
  assert.equal(schema.body.endpoints.listPeers, "/api/peers");
  assert.equal(schema.body.endpoints.pullPeer, "/api/peers/{id}/pull");
  assert.equal(schema.body.federation.peerPull, "read_only_public_cases_only");
  db.close();
});

test("new cold cases are private by default and omitted from public relay export", async () => {
  const { app, db } = fixture();
  await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send(VALID_CERT)
    .expect(201)
    .expect((response) => {
      assert.equal(response.body.case.publishState, "private");
    });

  const relay = buildPublicRelayExport(db);
  assert.equal(relay.ok, true);
  assert.equal(relay.cases.length, 0);
  db.close();
});

test("admin can publish a sanitized public relay projection with private artifact URI redacted", async () => {
  const { app, db } = fixture();
  const created = await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send({
      ...VALID_CERT,
      hostedZipUrl: "",
      artifactUri: "smb://atlas/cold_case/ecc/run-17.zip",
      artifactKind: "zip",
      artifactLabel: "run-17 package",
      artifactSizeBytes: "12345",
      projectNamespace: "atlas/ecc",
      tags: ["ecc", "private-artifact"]
    })
    .expect(201);

  const admin = request.agent(app);
  await login(admin, "admin");
  const published = await admin
    .post(`/api/cases/${created.body.case.id}/publish`)
    .send({ state: "public_relay" })
    .expect(200);

  assert.equal(published.body.case.publishState, "public_relay");
  assert.match(published.body.case.publicCaseId, /^[a-f0-9]{32}$/);
  assert.equal(published.body.publicCase.schema, "cold_cases.public_case.v1");
  assert.equal(published.body.publicCase.artifact.publicUri, null);
  assert.equal(published.body.publicCase.artifact.accessMode, "private_reference_redacted");
  assert.equal(published.body.publicCase.artifact.redactionReason, "private_smb_reference");
  assert.equal(published.body.publicCase.artifact.submittedSha256, "a".repeat(64));
  assert.equal(published.body.publicCase.pipeline.projectNamespace, "atlas/ecc");
  assert.deepEqual(published.body.publicCase.pipeline.tags, ["ecc", "private-artifact"]);
  assert.equal(JSON.stringify(published.body.publicCase).includes("smb://atlas"), false);

  const relay = buildPublicRelayExport(db);
  assert.equal(relay.ok, true);
  assert.equal(relay.cases.length, 1);
  assert.equal(relay.files["cases.json"].cases[0].publicCaseId, published.body.case.publicCaseId);
  assert.equal(relay.files["facets.json"].artifactKinds[0].artifactKind, "zip");
  db.close();
});

test("public relay publication fails closed on unsafe public text", async () => {
  const { app, db } = fixture();
  const created = await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer atlas-token")
    .send({
      ...VALID_CERT,
      projectTarget: "local run on 192.168.1.176"
    })
    .expect(201);

  const admin = request.agent(app);
  await login(admin, "admin");
  await admin
    .post(`/api/cases/${created.body.case.id}/publish`)
    .send({ state: "public_relay" })
    .expect(400)
    .expect((response) => {
      assert.match(response.body.errors.join("\n"), /private ip reference/);
    });

  const detail = await admin.get(`/api/cases/${created.body.case.id}`).expect(200);
  assert.equal(detail.body.case.publishState, "private");

  db.prepare("UPDATE certs SET publish_state = 'public_relay', public_case_id = 'unsafe-test' WHERE id = ?")
    .run(created.body.case.id);
  const relay = buildPublicRelayExport(db);
  assert.equal(relay.ok, false);
  assert.match(relay.rejected[0].errors.join("\n"), /private ip reference/);
  db.close();
});
