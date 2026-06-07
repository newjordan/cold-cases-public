#!/usr/bin/env node

const path = require("node:path");
const { listCerts, openDatabase, setCertPublishState } = require("../src/db");
const { projectPublicCase } = require("../src/publicRelay");

const dbPath = process.argv[2] || process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "cold-cases.sqlite");
const namespace = process.env.PUBLIC_RELAY_NAMESPACE || "";
const submitter = process.env.PUBLIC_RELAY_SUBMITTER || "";
const tag = process.env.PUBLIC_RELAY_TAG || "";
const admin = { login: process.env.PUBLIC_RELAY_ADMIN || "relay-publisher", id: null, avatarUrl: null };

const db = openDatabase(dbPath);
try {
  const cases = listCerts(db, { projectNamespace: namespace, submitter, tag }, { includeHidden: false, limit: 500 });
  let published = 0;
  const rejected = [];

  for (const cert of cases) {
    const projection = projectPublicCase(cert);
    if (!projection.ok) {
      rejected.push({ id: cert.id, projectTarget: cert.projectTarget, errors: projection.errors });
      continue;
    }
    const updated = setCertPublishState(db, cert.id, "public_relay", admin);
    published += 1;
    console.log(`${updated.publicCaseId} ${updated.projectTarget}`);
  }

  if (rejected.length) {
    console.error(JSON.stringify({ published, rejected }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`published ${published} public relay case(s)`);
} finally {
  db.close();
}
