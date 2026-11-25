const assert = require("node:assert/strict");
const test = require("node:test");
const { openDatabase, addPeer } = require("../src/db");
const { isAllowedPeerUrl, pullPeer } = require("../src/peers");

test("peer URLs reject loopback, link-local, metadata, and credentials", () => {
  assert.equal(isAllowedPeerUrl("https://peer.example"), true);
  assert.equal(isAllowedPeerUrl("http://192.168.1.20:3000"), true);
  assert.equal(isAllowedPeerUrl("http://10.1.2.3"), true);
  assert.equal(isAllowedPeerUrl("http://100.64.1.5"), true);
  assert.equal(isAllowedPeerUrl("http://8.8.8.8"), true);
  assert.equal(isAllowedPeerUrl("http://127.0.0.1:3000"), false);
  assert.equal(isAllowedPeerUrl("http://2130706433/"), false);
  assert.equal(isAllowedPeerUrl("http://0x7f000001/"), false);
  assert.equal(isAllowedPeerUrl("http://[::1]/"), false);
  assert.equal(isAllowedPeerUrl("http://[::ffff:7f00:1]/"), false);
  assert.equal(isAllowedPeerUrl("http://169.254.169.254/latest"), false);
  assert.equal(isAllowedPeerUrl("http://100.100.100.200/"), false);
  assert.equal(isAllowedPeerUrl("http://localhost/api"), false);
  assert.equal(isAllowedPeerUrl("http://metadata.google.internal/"), false);
  assert.equal(isAllowedPeerUrl("http://user:pass@example.com/"), false);
  assert.equal(isAllowedPeerUrl("ftp://peer.example"), false);
  assert.equal(isAllowedPeerUrl("https://peer.example/cold-cases"), false);
});

test("peer pull refuses a hostname that resolves to loopback and does not fetch it", async () => {
  const db = openDatabase(":memory:");
  const peer = addPeer(db, { baseUrl: "https://rebind.example", label: "rebind" });
  let fetched = false;
  const result = await pullPeer(db, peer.id, {
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({ cases: [] }) };
    },
    lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /loopback or link-local/);
  assert.equal(fetched, false);
  db.close();
});

test("peer pull stops when nextOffset does not advance", async () => {
  const db = openDatabase(":memory:");
  const peer = addPeer(db, { baseUrl: "https://peer.example", label: "peer" });
  let calls = 0;
  const result = await pullPeer(db, peer.id, {
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ cases: [], page: { nextOffset: 0 } })
      };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 0);
  assert.equal(calls, 1);
  db.close();
});

test("peer pull follows a strictly increasing nextOffset", async () => {
  const db = openDatabase(":memory:");
  const peer = addPeer(db, { baseUrl: "https://peer.example", label: "peer" });
  const pages = [
    { cases: [], page: { nextOffset: 200 } },
    { cases: [], page: { nextOffset: null } }
  ];
  let calls = 0;
  const result = await pullPeer(db, peer.id, {
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: async (url) => {
      const expected = ["0", "200"][calls];
      assert.equal(new URL(url).searchParams.get("offset"), expected);
      const body = pages[calls];
      calls += 1;
      return { ok: true, status: 200, json: async () => body };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  db.close();
});
