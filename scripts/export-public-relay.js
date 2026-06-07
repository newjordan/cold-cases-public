#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../src/db");
const { buildPublicRelayExport } = require("../src/publicRelay");

const dbPath = process.argv[2] || process.env.DATABASE_PATH || process.env.COLD_CASES_DB || path.join(__dirname, "..", "data", "cold-cases.sqlite");
const outputDir = process.argv[3] || path.join(__dirname, "..", "public-relay");

const db = openDatabase(dbPath);
try {
  const result = buildPublicRelayExport(db);
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, rejected: result.rejected }, null, 2));
    process.exitCode = 1;
    return;
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outputDir, "cases"), { recursive: true });
  for (const [name, payload] of Object.entries(result.files)) {
    writeJson(path.join(outputDir, name), payload);
  }
  for (const publicCase of result.cases) {
    writeJson(path.join(outputDir, "cases", `${publicCase.publicCaseId}.json`), publicCase);
  }
  console.log(`exported ${result.cases.length} public relay case(s) to ${outputDir}`);
} finally {
  db.close();
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}
