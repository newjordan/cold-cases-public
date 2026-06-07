const { validateCertInput } = require("./validation");
const { getPeer, recordPeerPull, upsertPeerCase, countPeerCases } = require("./db");

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 10_000;

// Read-only peer pull. Fetches the PUBLIC `/api/cases` projection of a peer
// instance and mirrors it into the local `peer_cases` table. It only copies
// metadata the peer already publishes; it never uploads, writes to the peer,
// fetches artifacts, or merges remote rows into the local `certs` table.

function isAllowedPeerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function normalizePeerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function fetchPage(fetchImpl, baseUrl, offset, signal) {
  const url = `${baseUrl}/api/cases?limit=${PAGE_LIMIT}&offset=${offset}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal
  });
  if (!response.ok) {
    throw new Error(`peer responded with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.cases)) {
    throw new Error("peer response missing a cases array");
  }
  return body;
}

async function pullPeer(db, peerId, { fetchImpl = globalThis.fetch } = {}) {
  const peer = getPeer(db, peerId);
  if (!peer) return { ok: false, error: "peer not found" };
  if (!isAllowedPeerUrl(peer.baseUrl)) {
    recordPeerPull(db, peerId, { status: "error", error: "peer base URL must be http(s)" });
    return { ok: false, error: "peer base URL must be http(s)" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let pulled = 0;
  let rejected = 0;

  try {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await fetchPage(fetchImpl, peer.baseUrl, offset, controller.signal);
      for (const remoteCase of body.cases) {
        if (!remoteCase || !remoteCase.id) {
          rejected += 1;
          continue;
        }
        // Re-validate the published metadata before mirroring it. Malformed or
        // unexpected payloads from a peer are skipped rather than stored.
        const validation = validateCertInput(remoteCase);
        if (!validation.ok) {
          rejected += 1;
          continue;
        }
        upsertPeerCase(db, peerId, remoteCase);
        pulled += 1;
      }
      const next = body.page?.nextOffset;
      if (next === null || next === undefined) break;
      offset = next;
    }

    const total = countPeerCases(db, peerId);
    recordPeerPull(db, peerId, { status: "ok", error: null, pulledCount: total });
    return { ok: true, pulled, rejected, total };
  } catch (error) {
    const message = error?.name === "AbortError" ? "peer request timed out" : String(error?.message || error);
    recordPeerPull(db, peerId, { status: "error", error: message });
    return { ok: false, error: message, pulled, rejected };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { pullPeer, isAllowedPeerUrl, normalizePeerUrl };
