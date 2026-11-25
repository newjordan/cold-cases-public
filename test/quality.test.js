const assert = require("node:assert/strict");
const test = require("node:test");
const request = require("supertest");
const { createApp } = require("../src/app");
const { openDatabase } = require("../src/db");

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

function fixture(env = {}) {
  const db = openDatabase(":memory:");
  const app = createApp({
    db,
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-secret",
      ADMIN_GITHUB_LOGINS: "admin",
      AGENT_SUBMIT_TOKENS: "atlas:atlas-token,other:other-token",
      ...env
    }
  });
  return { app, db };
}

async function login(agent, loginName = "researcher") {
  await agent.post("/__test/login").send({ login: loginName, id: `${loginName}-id` }).expect(200);
}

test("production startup rejects a missing or placeholder session secret", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => createApp({ db, env: { NODE_ENV: "production" } }), /SESSION_SECRET/);
  assert.throws(() => createApp({
    db,
    env: { NODE_ENV: "production", SESSION_SECRET: "change-me" }
  }), /SESSION_SECRET/);
  const app = createApp({
    db,
    env: { NODE_ENV: "production", SESSION_SECRET: "a-real-production-secret" }
  });
  assert.equal(typeof app.handle, "function");
  db.close();
});

test("health and an empty public relay are served without auth", async () => {
  const { app, db } = fixture();
  await request(app).get("/health").expect(200).expect({ ok: true });
  const index = await request(app).get("/cases.json").expect(200);
  assert.equal(index.body.count, 0);
  assert.deepEqual(index.body.cases, []);
  const facets = await request(app).get("/facets.json").expect(200);
  assert.equal(facets.body.total, 0);
  const schema = await request(app).get("/schema.json").expect(200);
  assert.equal(schema.body.schema, "cold_cases.public_case.v1");
  db.close();
});

test("homepage links to browse and does not list case rows", async () => {
  const { app, db } = fixture();
  const response = await request(app).get("/").expect(200);
  assert.match(response.text, /href="\/browse"/);
  assert.match(response.text, /GitHub login is not configured/);
  assert.doesNotMatch(response.text, /href="\/login"/);
  assert.match(response.headers["content-security-policy"], /style-src 'self'/);
  assert.doesNotMatch(response.headers["content-security-policy"], /unsafe-inline/);
  db.close();
});

test("unconfigured GitHub login explains itself", async () => {
  const { app, db } = fixture();
  const response = await request(app).get("/login").expect(503);
  assert.match(response.text, /GitHub login is not configured/);
  db.close();
});

test("browse lists a visible case that the homepage keeps out of the row list", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  await agent.post("/api/cases").send({
    ...VALID_CERT,
    projectTarget: "browse-only target phrase"
  }).expect(201);

  const home = await request(app).get("/").expect(200);
  assert.doesNotMatch(home.text, /browse-only target phrase/);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(home.text, new RegExp(`${today}: 1 submissions`));

  const browse = await request(app).get("/browse").expect(200);
  assert.match(browse.text, /browse-only target phrase/);
  assert.match(browse.text, /class="cert-row/);
  db.close();
});

test("literal percent and underscore searches do not act as wildcards", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "100% done" }).expect(201);
  await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "1000 done" }).expect(201);
  await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "a_b marker" }).expect(201);
  await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "axb marker" }).expect(201);

  const percent = await request(app).get("/api/cases").query({ q: "100%" }).expect(200);
  assert.deepEqual(percent.body.cases.map((item) => item.projectTarget), ["100% done"]);

  const underscore = await request(app).get("/api/cases").query({ projectTarget: "a_b" }).expect(200);
  assert.deepEqual(underscore.body.cases.map((item) => item.projectTarget), ["a_b marker"]);
  db.close();
});

test("zero-byte artifact size survives the amend form", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  const created = await agent.post("/api/cases").send({
    ...VALID_CERT,
    artifactUri: "smb://atlas/cold_case/empty.zip",
    hostedZipUrl: "",
    artifactSizeBytes: 0
  }).expect(201);
  assert.equal(created.body.case.artifactSizeBytes, 0);
  const page = await agent.get(`/cases/${created.body.case.id}/amend`).expect(200);
  assert.match(page.text, /name="artifactSizeBytes" value="0"/);
  const detail = await agent.get(`/cases/${created.body.case.id}`).expect(200);
  assert.match(detail.text, /0 bytes/);
  db.close();
});

test("amending onto another clientRecordId returns 409", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  const first = await agent.post("/api/cases").send({ ...VALID_CERT, clientRecordId: "one" }).expect(201);
  await agent.post("/api/cases").send({ ...VALID_CERT, clientRecordId: "two", projectTarget: "second case" }).expect(201);
  const conflict = await agent.post(`/api/cases/${first.body.case.id}/amend`).send({
    ...VALID_CERT,
    clientRecordId: "two"
  }).expect(409);
  assert.match(conflict.body.errors.join("\n"), /conflicts/);
  const reread = await agent.get(`/api/cases/${first.body.case.id}`).expect(200);
  assert.equal(reread.body.case.clientRecordId, "one");
  db.close();
});

test("missing API cases are JSON and a wrong agent token is rejected", async () => {
  const { app, db } = fixture();
  const missing = await request(app).get("/api/cases/does-not-exist").expect(404);
  assert.deepEqual(missing.body.errors, ["Not found"]);
  await request(app)
    .post("/api/cases")
    .set("Authorization", "Bearer wrong-token")
    .send(VALID_CERT)
    .expect(401);
  db.close();
});

test("browser hide requires the session token and publish state is admin-only", async () => {
  const { app, db } = fixture();
  const owner = request.agent(app);
  const admin = request.agent(app);
  await login(owner, "owner");
  await login(admin, "admin");
  const created = await owner.post("/api/cases").send(VALID_CERT).expect(201);

  await owner.post(`/api/cases/${created.body.case.id}/publish`).send({ state: "public_relay" }).expect(403);
  await admin.post(`/cases/${created.body.case.id}/hide`).send({ reason: "spam" }).expect(403);

  const published = await admin.post(`/api/cases/${created.body.case.id}/publish`).send({ state: "public_relay" }).expect(200);
  const relay = await request(app).get("/cases.json").expect(200);
  assert.equal(relay.body.count, 1);
  assert.equal(relay.body.cases[0].publicCaseId, published.body.case.publicCaseId);
  const one = await request(app).get(`/cases/${published.body.case.publicCaseId}.json`).expect(200);
  assert.equal(one.body.schema, "cold_cases.public_case.v1");
  assert.equal(JSON.stringify(one.body).includes(created.body.case.id), false);

  await admin.post(`/api/cases/${created.body.case.id}/publish`).send({ state: "private" }).expect(200);
  const after = await request(app).get("/cases.json").expect(200);
  assert.equal(after.body.count, 0);
  await request(app).get(`/cases/${published.body.case.publicCaseId}.json`).expect(404);
  db.close();
});

test("write rate limit returns 429 after the configured cap", async () => {
  const { app, db } = fixture({ WRITE_RATE_LIMIT_MAX: "2" });
  const agent = request.agent(app);
  await login(agent);
  await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "first write" }).expect(201);
  await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "second write" }).expect(201);
  const limited = await agent.post("/api/cases").send({ ...VALID_CERT, projectTarget: "third write" }).expect(429);
  assert.match(limited.body.errors.join("\n"), /Rate limit exceeded/);
  assert.ok(limited.headers["retry-after"]);
  db.close();
});

test("list limits are clamped and a genesis head cannot name a previous hash", async () => {
  const { app, db } = fixture();
  const agent = request.agent(app);
  await login(agent);
  await agent.post("/api/cases").send(VALID_CERT).expect(201);
  const page = await request(app).get("/api/cases?limit=0&offset=-4").expect(200);
  assert.equal(page.body.page.limit, 1);
  assert.equal(page.body.page.offset, 0);

  const rejected = await request(app)
    .post("/api/headchains/atlas/heads")
    .set("Authorization", "Bearer atlas-token")
    .send({
      schema: "cold_cases.head.v1",
      clientHeadId: "head-1",
      summary: "not genesis",
      prevHeadHash: "b".repeat(64),
      coldCase: VALID_CERT
    })
    .expect(409);
  assert.match(rejected.body.errors.join("\n"), /genesis/);
  db.close();
});

test("admin can register a LAN peer and cannot register loopback", async () => {
  const { app, db } = fixture();
  const admin = request.agent(app);
  await login(admin, "admin");
  await admin.post("/api/peers").send({ baseUrl: "http://127.0.0.1:3000" }).expect(400);
  await admin.post("/api/peers").send({ baseUrl: "http://[::ffff:7f00:1]/" }).expect(400);
  const added = await admin.post("/api/peers").send({ baseUrl: "http://192.168.1.20:3000", label: "lan" }).expect(201);
  assert.equal(added.body.peer.baseUrl, "http://192.168.1.20:3000");
  db.close();
});
