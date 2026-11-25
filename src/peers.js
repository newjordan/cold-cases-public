const dns = require("node:dns").promises;
const net = require("node:net");
const { validateCertInput } = require("./validation");
const { getPeer, recordPeerPull, upsertPeerCase, countPeerCases } = require("./db");

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_CASE_CHARS = 32_768;
const REQUEST_TIMEOUT_MS = 10_000;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.azure.com",
  "instance-data"
]);

// Read-only peer pull. Fetches the PUBLIC `/api/cases` projection of a peer
// instance and mirrors it into the local `peer_cases` table. It only copies
// metadata the peer already publishes; it never uploads, writes to the peer,
// fetches artifacts, or merges remote rows into the local `certs` table.
//
// Loopback, link-local, and well-known metadata hosts are rejected so an
// operator-supplied base URL cannot be aimed at the instance itself or at a
// cloud metadata service. RFC1918 and carrier-grade NAT addresses stay
// allowed so a peer on a LAN or tailnet can still be pulled.

function stripHost(hostname) {
  return String(hostname || "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedIPv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return true;
    if (part.length > 1 && part.startsWith("0")) return true;
    const value = Number(part);
    if (value > 255) return true;
    nums.push(value);
  }
  const [a, b, c, d] = nums;
  if (a === 0 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  if (a === 100 && b === 100 && c === 100 && d === 200) return true;
  return false;
}

function expandIPv6(host) {
  if (host.includes(".")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => group.padStart(4, "0")).join(":");
}

function isBlockedIPv6(host) {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return isBlockedIPv4(dotted[1]);
  const expanded = expandIPv6(host);
  if (!expanded) return true;
  const groups = expanded.split(":").map((part) => Number.parseInt(part, 16));
  if (groups.slice(0, 5).every((value) => value === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isBlockedIPv4(v4);
  }
  if (groups.every((value) => value === 0)) return true;
  if (groups.slice(0, 7).every((value) => value === 0) && groups[7] === 1) return true;
  const first = groups[0];
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (expanded === "fd00:0ec2:0000:0000:0000:0000:0000:0254") return true;
  return false;
}

function isBlockedHost(hostname) {
  const host = stripHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  if (net.isIP(host) === 4) return isBlockedIPv4(host);
  if (host.includes(":")) return isBlockedIPv6(host);
  return false;
}

function isAllowedPeerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.pathname !== "/" || url.search || url.hash) return false;
  return !isBlockedHost(url.hostname);
}

function normalizePeerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function assertPeerHostSafe(baseUrl, lookupImpl = defaultLookup) {
  const host = stripHost(new URL(baseUrl).hostname);
  if (isBlockedHost(host)) {
    throw new Error("peer host is loopback, link-local, or a metadata address");
  }
  if (net.isIP(host) || host.includes(":")) return;

  let records;
  try {
    records = await lookupImpl(host);
  } catch {
    throw new Error("peer host did not resolve");
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw new Error("peer host did not resolve");
  for (const record of list) {
    const address = typeof record === "string" ? record : record?.address;
    if (!address || isBlockedHost(address)) {
      throw new Error("peer host resolved to a loopback or link-local address");
    }
  }
}

async function readJsonBody(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_CHARS) {
    throw new Error("peer response exceeds 1 MB");
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new Error("peer response exceeds 1 MB");
    return JSON.parse(text);
  }
  if (typeof response.json === "function") {
    const body = await response.json();
    if (JSON.stringify(body).length > MAX_RESPONSE_CHARS) throw new Error("peer response exceeds 1 MB");
    return body;
  }
  throw new Error("peer response was not readable");
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
  const body = await readJsonBody(response);
  if (!body || !Array.isArray(body.cases)) {
    throw new Error("peer response missing a cases array");
  }
  return body;
}

function mirrorableCase(remoteCase) {
  if (!remoteCase || (typeof remoteCase.id !== "string" && typeof remoteCase.id !== "number")) return null;
  const remoteId = String(remoteCase.id).trim();
  if (!remoteId || remoteId.length > 200) return null;
  let rawSize = 0;
  try {
    rawSize = JSON.stringify(remoteCase).length;
  } catch {
    return null;
  }
  if (rawSize > MAX_CASE_CHARS) return null;
  const validation = validateCertInput(remoteCase);
  if (!validation.ok) return null;
  return {
    ...validation.cert,
    id: remoteId,
    createdAt: typeof remoteCase.createdAt === "string" ? remoteCase.createdAt.slice(0, 40) : null,
    submitterLogin: typeof remoteCase.submitterLogin === "string" ? remoteCase.submitterLogin.slice(0, 200) : null
  };
}

async function pullPeer(db, peerId, { fetchImpl = globalThis.fetch, lookupImpl } = {}) {
  const peer = getPeer(db, peerId);
  if (!peer) return { ok: false, error: "peer not found" };
  if (!isAllowedPeerUrl(peer.baseUrl)) {
    recordPeerPull(db, peerId, { status: "error", error: "peer base URL must be an http(s) origin" });
    return { ok: false, error: "peer base URL must be an http(s) origin" };
  }

  try {
    await assertPeerHostSafe(peer.baseUrl, lookupImpl);
  } catch (error) {
    const message = String(error?.message || error);
    recordPeerPull(db, peerId, { status: "error", error: message });
    return { ok: false, error: message, pulled: 0, rejected: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let pulled = 0;
  let rejected = 0;

  try {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await fetchPage(fetchImpl, peer.baseUrl, offset, controller.signal);
      for (const remoteCase of body.cases.slice(0, PAGE_LIMIT)) {
        const stored = mirrorableCase(remoteCase);
        if (!stored) {
          rejected += 1;
          continue;
        }
        upsertPeerCase(db, peerId, stored);
        pulled += 1;
      }
      const next = body.page?.nextOffset;
      if (!Number.isInteger(next) || next <= offset) break;
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

module.exports = {
  isAllowedPeerUrl,
  isBlockedHost,
  normalizePeerUrl,
  pullPeer
};
