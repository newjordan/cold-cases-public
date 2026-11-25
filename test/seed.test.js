const assert = require("node:assert/strict");
const test = require("node:test");
const { RECORDS } = require("../scripts/seed-quantum-coldcases");
const { FAILURE_CLASSES } = require("../src/validation");

test("quantum seed exposes eight unique transcribed attempts", () => {
  assert.equal(RECORDS.length, 8);
  const ids = RECORDS.map((record) => record.clientRecordId);
  assert.equal(new Set(ids).size, ids.length);
  for (const record of RECORDS) {
    assert.ok(FAILURE_CLASSES.includes(record.failureClass), record.clientRecordId);
    assert.ok(record.projectTarget);
    assert.ok(record.command);
    assert.ok(record.metric);
    assert.ok(record.failureReason);
    assert.ok(record.reviveCondition);
    assert.ok(record.sourceEnv === "QUANTUM_EC_ATTEMPTS_LOG" || record.sourceEnv === "QUANTUM_EC_CLIFF_DOC");
    assert.ok(Array.isArray(record.tags) && record.tags.length > 0);
  }
});
