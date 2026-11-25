const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { canonicalizeCert } = require("./validation");

function openDatabase(path = ":memory:") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS certs (
      id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitter_login TEXT NOT NULL,
      submitter_id TEXT,
      submitter_avatar_url TEXT,
      publish_state TEXT NOT NULL DEFAULT 'private',
      public_case_id TEXT,
      published_at TEXT,
      public_block_reason TEXT,
      client_record_id TEXT,
      project_namespace TEXT,
      run_id TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      artifact_uri TEXT,
      artifact_kind TEXT,
      artifact_label TEXT,
      artifact_size_bytes INTEGER,
      project_target TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      hosted_zip_url TEXT,
      zip_sha256 TEXT NOT NULL,
      command TEXT NOT NULL,
      metric TEXT NOT NULL,
      failure_class TEXT NOT NULL,
      failure_reason TEXT NOT NULL,
      revive_condition TEXT NOT NULL,
      provenance TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cert_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_id TEXT NOT NULL REFERENCES certs(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL,
      canonical_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by_login TEXT NOT NULL,
      UNIQUE(cert_id, version)
    );

    CREATE TABLE IF NOT EXISTS cert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_id TEXT NOT NULL REFERENCES certs(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL,
      version INTEGER,
      actor_login TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS headchains (
      chain_id TEXT PRIMARY KEY,
      latest_seq INTEGER NOT NULL DEFAULT 0,
      latest_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS headchain_heads (
      chain_id TEXT NOT NULL REFERENCES headchains(chain_id) ON DELETE RESTRICT,
      seq INTEGER NOT NULL,
      head_hash TEXT NOT NULL,
      prev_head_hash TEXT,
      author_login TEXT NOT NULL,
      author_id TEXT,
      author_avatar_url TEXT,
      client_head_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      cold_case_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      dumped_at TEXT,
      case_id TEXT REFERENCES certs(id) ON DELETE RESTRICT,
      PRIMARY KEY(chain_id, seq),
      UNIQUE(chain_id, head_hash),
      UNIQUE(chain_id, author_login, client_head_id)
    );

    CREATE INDEX IF NOT EXISTS idx_headchain_heads_latest ON headchain_heads(chain_id, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_headchain_heads_dump ON headchain_heads(chain_id, dumped_at, seq);
  `);
  addColumnIfMissing(db, "certs", "client_record_id", "TEXT");
  addColumnIfMissing(db, "certs", "publish_state", "TEXT NOT NULL DEFAULT 'private'");
  addColumnIfMissing(db, "certs", "public_case_id", "TEXT");
  addColumnIfMissing(db, "certs", "published_at", "TEXT");
  addColumnIfMissing(db, "certs", "public_block_reason", "TEXT");
  addColumnIfMissing(db, "certs", "project_namespace", "TEXT");
  addColumnIfMissing(db, "certs", "run_id", "TEXT");
  addColumnIfMissing(db, "certs", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, "certs", "artifact_uri", "TEXT");
  addColumnIfMissing(db, "certs", "artifact_kind", "TEXT");
  addColumnIfMissing(db, "certs", "artifact_label", "TEXT");
  addColumnIfMissing(db, "certs", "artifact_size_bytes", "INTEGER");
  relaxHostedZipUrlNotNull(db);

  // Read-only peer federation. A self-hosted instance may pull the PUBLIC cases of
  // peer instances it chooses to trust. Pulled rows live in their own table and are
  // never merged into `certs`, so locally-owned data and mirrored remote data stay
  // distinct — this is the data-ownership boundary the operator is responsible for.
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_pulled_at TEXT,
      last_status TEXT,
      last_error TEXT,
      pulled_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS peer_cases (
      peer_id TEXT NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
      remote_id TEXT NOT NULL,
      project_target TEXT,
      failure_class TEXT,
      submitter_login TEXT,
      repo_url TEXT,
      project_namespace TEXT,
      run_id TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      remote_created_at TEXT,
      remote_json TEXT NOT NULL,
      pulled_at TEXT NOT NULL,
      PRIMARY KEY(peer_id, remote_id)
    );

    CREATE INDEX IF NOT EXISTS idx_peer_cases_peer ON peer_cases(peer_id, remote_created_at DESC);
  `);
  ensureCertIndexes(db);
}

function ensureCertIndexes(db) {
  // Recreate these after relaxHostedZipUrlNotNull, which drops and rebuilds `certs`
  // and takes the indexes created earlier in migrate() with it.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_certs_public ON certs(hidden, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_certs_search ON certs(project_target, failure_class, submitter_login, repo_url);
    CREATE INDEX IF NOT EXISTS idx_events_cert ON cert_events(cert_id, id);
    CREATE INDEX IF NOT EXISTS idx_certs_namespace ON certs(project_namespace, run_id, hidden, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_certs_artifact_kind ON certs(artifact_kind, hidden, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_certs_publish_state ON certs(publish_state, hidden, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_certs_client_record ON certs(submitter_login, client_record_id) WHERE client_record_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_certs_public_case_id ON certs(public_case_id) WHERE public_case_id IS NOT NULL;
  `);
}

function addColumnIfMissing(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function relaxHostedZipUrlNotNull(db) {
  const hostedZip = db.prepare("PRAGMA table_info(certs)").all().find((row) => row.name === "hosted_zip_url");
  if (!hostedZip || hostedZip.notnull === 0) return;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS certs_new;
      CREATE TABLE certs_new (
        id TEXT PRIMARY KEY,
        current_version INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        hidden_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitter_login TEXT NOT NULL,
        submitter_id TEXT,
        submitter_avatar_url TEXT,
        publish_state TEXT NOT NULL DEFAULT 'private',
        public_case_id TEXT,
        published_at TEXT,
        public_block_reason TEXT,
        client_record_id TEXT,
        project_namespace TEXT,
        run_id TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        artifact_uri TEXT,
        artifact_kind TEXT,
        artifact_label TEXT,
        artifact_size_bytes INTEGER,
        project_target TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        hosted_zip_url TEXT,
        zip_sha256 TEXT NOT NULL,
        command TEXT NOT NULL,
        metric TEXT NOT NULL,
        failure_class TEXT NOT NULL,
        failure_reason TEXT NOT NULL,
        revive_condition TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
      INSERT INTO certs_new (
        id, current_version, hidden, hidden_reason, created_at, updated_at,
        submitter_login, submitter_id, submitter_avatar_url, publish_state,
        public_case_id, published_at, public_block_reason, client_record_id,
        project_namespace, run_id, tags_json, artifact_uri, artifact_kind,
        artifact_label, artifact_size_bytes, project_target, repo_url,
        hosted_zip_url, zip_sha256, command, metric, failure_class,
        failure_reason, revive_condition, provenance
      )
      SELECT
        id, current_version, hidden, hidden_reason, created_at, updated_at,
        submitter_login, submitter_id, submitter_avatar_url, publish_state,
        public_case_id, published_at, public_block_reason, client_record_id,
        project_namespace, run_id, tags_json, artifact_uri, artifact_kind,
        artifact_label, artifact_size_bytes, project_target, repo_url,
        hosted_zip_url, zip_sha256, command, metric, failure_class,
        failure_reason, revive_condition, provenance
      FROM certs;
      DROP TABLE certs;
      ALTER TABLE certs_new RENAME TO certs;
      COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function serializeCanonical(value) {
  return JSON.stringify(value, null, 2);
}

function serializeStable(value, spaces = 2) {
  return JSON.stringify(stableValue(value), null, spaces);
}

function stableValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function createCert(db, cert, user) {
  if (cert.clientRecordId) {
    const existing = getCertByClientRecordId(db, user.login, cert.clientRecordId, { includeHidden: true });
    if (existing) {
      existing.idempotentReplay = true;
      return existing;
    }
  }

  const createdAt = nowIso();
  const id = crypto.randomUUID();
  const version = 1;
  const submitter = publicUser(user);
  const canonical = canonicalizeCert(cert, {
    certId: id,
    version,
    submitter,
    caseCreatedAt: createdAt,
    versionCreatedAt: createdAt,
    updatedAt: createdAt,
    hidden: false
  });

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO certs (
        id, current_version, created_at, updated_at, submitter_login, submitter_id,
        submitter_avatar_url, client_record_id, project_namespace, run_id, tags_json,
        artifact_uri, artifact_kind, artifact_label, artifact_size_bytes,
        project_target, repo_url, hosted_zip_url, zip_sha256,
        command, metric, failure_class, failure_reason, revive_condition, provenance
      )
      VALUES (
        @id, @version, @createdAt, @createdAt, @login, @githubId,
        @avatarUrl, @clientRecordId, @projectNamespace, @runId, @tagsJson,
        @artifactUri, @artifactKind, @artifactLabel, @artifactSizeBytes,
        @projectTarget, @repoUrl, @hostedZipUrl, @zipSha256,
        @command, @metric, @failureClass, @failureReason, @reviveCondition, @provenance
      )
    `).run({
      id,
      version,
      createdAt,
      login: user.login,
      githubId: user.id || null,
      avatarUrl: user.avatarUrl || null,
      tagsJson: JSON.stringify(cert.tags || []),
      ...cert
    });

    db.prepare(`
      INSERT INTO cert_versions (cert_id, version, canonical_json, created_at, created_by_login)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, version, serializeCanonical(canonical), createdAt, user.login);

    db.prepare(`
      INSERT INTO cert_events (cert_id, event_type, version, actor_login, created_at)
      VALUES (?, 'create', ?, ?, ?)
    `).run(id, version, user.login, createdAt);
  });

  tx();
  return getCert(db, id, { includeHidden: true });
}

function amendCert(db, id, cert, user) {
  const existing = getCert(db, id, { includeHidden: true });
  if (!existing) return null;

  const createdAt = nowIso();
  const version = existing.currentVersion + 1;
  const canonical = canonicalizeCert(cert, {
    certId: id,
    version,
    submitter: publicUser({ login: existing.submitterLogin, id: existing.submitterId, avatarUrl: existing.submitterAvatarUrl }),
    caseCreatedAt: existing.createdAt,
    versionCreatedAt: createdAt,
    updatedAt: createdAt,
    hidden: existing.hidden,
    hiddenReason: existing.hiddenReason
  });

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE certs SET
        current_version = @version,
        updated_at = @createdAt,
        client_record_id = @clientRecordId,
        project_namespace = @projectNamespace,
        run_id = @runId,
        tags_json = @tagsJson,
        artifact_uri = @artifactUri,
        artifact_kind = @artifactKind,
        artifact_label = @artifactLabel,
        artifact_size_bytes = @artifactSizeBytes,
        project_target = @projectTarget,
        repo_url = @repoUrl,
        hosted_zip_url = @hostedZipUrl,
        zip_sha256 = @zipSha256,
        command = @command,
        metric = @metric,
        failure_class = @failureClass,
        failure_reason = @failureReason,
        revive_condition = @reviveCondition,
        provenance = @provenance
      WHERE id = @id
    `).run({ id, version, createdAt, tagsJson: JSON.stringify(cert.tags || []), ...cert });

    db.prepare(`
      INSERT INTO cert_versions (cert_id, version, canonical_json, created_at, created_by_login)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, version, serializeCanonical(canonical), createdAt, user.login);

    db.prepare(`
      INSERT INTO cert_events (cert_id, event_type, version, actor_login, created_at)
      VALUES (?, 'amend', ?, ?, ?)
    `).run(id, version, user.login, createdAt);
  });

  tx();
  return getCert(db, id, { includeHidden: true });
}

function hideCert(db, id, user, reason = "") {
  const existing = getCert(db, id, { includeHidden: true });
  if (!existing) return null;
  const createdAt = nowIso();
  const version = existing.currentVersion + 1;
  const canonical = canonicalizeCert(existing, {
    certId: id,
    version,
    submitter: publicUser({ login: existing.submitterLogin, id: existing.submitterId, avatarUrl: existing.submitterAvatarUrl }),
    caseCreatedAt: existing.createdAt,
    versionCreatedAt: createdAt,
    updatedAt: createdAt,
    hidden: true,
    hiddenReason: reason
  });

  const tx = db.transaction(() => {
    db.prepare("UPDATE certs SET current_version = ?, hidden = 1, hidden_reason = ?, updated_at = ? WHERE id = ?")
      .run(version, reason, createdAt, id);
    db.prepare(`
      INSERT INTO cert_versions (cert_id, version, canonical_json, created_at, created_by_login)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, version, serializeCanonical(canonical), createdAt, user.login);
    db.prepare(`
      INSERT INTO cert_events (cert_id, event_type, version, actor_login, reason, created_at)
      VALUES (?, 'hide', ?, ?, ?, ?)
    `).run(id, version, user.login, reason, createdAt);
  });

  tx();
  return getCert(db, id, { includeHidden: true });
}

function setCertPublishState(db, id, state, user, reason = "") {
  const allowed = new Set(["private", "public_pending", "public_relay", "public_blocked"]);
  if (!allowed.has(state)) throw new Error("invalid publish state");
  const existing = getCert(db, id, { includeHidden: true });
  if (!existing) return null;
  const updatedAt = nowIso();
  const publicCaseId = state === "public_relay"
    ? existing.publicCaseId || makePublicCaseId(existing.id)
    : existing.publicCaseId;
  const publishedAt = state === "public_relay"
    ? existing.publishedAt || updatedAt
    : existing.publishedAt;
  const blockReason = state === "public_blocked" ? String(reason || "").trim() : null;

  db.prepare(`
    UPDATE certs SET
      publish_state = ?,
      public_case_id = ?,
      published_at = ?,
      public_block_reason = ?,
      updated_at = ?
    WHERE id = ?
  `).run(state, publicCaseId, publishedAt, blockReason, updatedAt, id);
  db.prepare(`
    INSERT INTO cert_events (cert_id, event_type, actor_login, reason, created_at)
    VALUES (?, 'publish_state', ?, ?, ?)
  `).run(id, user.login, `${state}${blockReason ? `: ${blockReason}` : ""}`, updatedAt);
  return getCert(db, id, { includeHidden: true });
}

function makePublicCaseId(id) {
  return crypto.createHash("sha256").update(`cold-cases-public:${id}`).digest("hex").slice(0, 32);
}

function acceptHeadChainHead(db, chainId, headInput, user) {
  const duplicate = getHeadByClientHeadId(db, chainId, user.login, headInput.clientHeadId);
  if (duplicate) {
    duplicate.idempotentReplay = true;
    return { head: duplicate, dumpedCases: [], idempotentReplay: true };
  }

  let accepted;
  const tx = db.transaction(() => {
    const chain = getHeadChain(db, chainId);
    if (!chain && headInput.prevHeadHash) {
      return {
        conflict: true,
        statusCode: 409,
        errors: ["prevHeadHash must be omitted for a genesis head"],
        latestHead: null
      };
    }
    if (chain?.latestHash && chain.latestHash !== headInput.prevHeadHash) {
      return {
        conflict: true,
        statusCode: 409,
        errors: ["prevHeadHash does not match the latest accepted head"],
        latestHead: getHeadChainLatest(db, chainId)
      };
    }

    const acceptedAt = nowIso();
    const seq = (chain?.latestSeq || 0) + 1;
    const canonical = {
      schema: "cold_cases.head.v1",
      chainId,
      seq,
      prevHeadHash: headInput.prevHeadHash || null,
      author: publicUser(user),
      clientHeadId: headInput.clientHeadId,
      summary: headInput.summary,
      coldCase: headInput.coldCase,
      acceptedAt
    };
    const canonicalJson = serializeStable(canonical);
    const headHash = crypto.createHash("sha256").update(canonicalJson).digest("hex");

    db.prepare(`
      INSERT INTO headchains (chain_id, latest_seq, latest_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id) DO UPDATE SET
        latest_seq = excluded.latest_seq,
        latest_hash = excluded.latest_hash,
        updated_at = excluded.updated_at
    `).run(chainId, seq, headHash, acceptedAt, acceptedAt);

    db.prepare(`
      INSERT INTO headchain_heads (
        chain_id, seq, head_hash, prev_head_hash, author_login, author_id,
        author_avatar_url, client_head_id, summary, canonical_json, cold_case_json, accepted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chainId,
      seq,
      headHash,
      headInput.prevHeadHash || null,
      user.login,
      user.id || null,
      user.avatarUrl || null,
      headInput.clientHeadId,
      headInput.summary,
      canonicalJson,
      serializeStable(headInput.coldCase),
      acceptedAt
    );

    return { head: getHeadChainHeadByHash(db, chainId, headHash) };
  });

  accepted = tx();
  if (accepted.conflict) return accepted;
  const dumpedCases = dumpEligibleHeadChainBatch(db, chainId);
  return { head: getHeadChainHeadByHash(db, chainId, accepted.head.headHash), dumpedCases };
}

function dumpEligibleHeadChainBatch(db, chainId) {
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT *
      FROM headchain_heads
      WHERE chain_id = ? AND dumped_at IS NULL
      ORDER BY seq ASC
      LIMIT 10
    `).all(chainId);
    if (rows.length < 10) return [];

    const dumpedAt = nowIso();
    const cases = [];
    for (const row of rows) {
      const coldCase = parseJson(row.cold_case_json, {});
      if (!coldCase.clientRecordId) {
        coldCase.clientRecordId = `headchain/${chainId}/${row.head_hash}`;
      }
      const cert = createCert(db, coldCase, {
        login: row.author_login,
        id: row.author_id,
        avatarUrl: row.author_avatar_url
      });
      db.prepare(`
        UPDATE headchain_heads
        SET dumped_at = ?, case_id = ?
        WHERE chain_id = ? AND seq = ? AND dumped_at IS NULL
      `).run(dumpedAt, cert.id, row.chain_id, row.seq);
      cases.push(cert);
    }
    return cases;
  });

  const firstBatch = tx();
  if (firstBatch.length < 10) return firstBatch;
  return firstBatch.concat(dumpEligibleHeadChainBatch(db, chainId));
}

function getHeadChain(db, chainId) {
  const row = db.prepare(`
    SELECT chain_id AS chainId, latest_seq AS latestSeq, latest_hash AS latestHash,
      created_at AS createdAt, updated_at AS updatedAt
    FROM headchains
    WHERE chain_id = ?
  `).get(chainId);
  return row || null;
}

function getHeadChainLatest(db, chainId) {
  const row = db.prepare(`
    SELECT *
    FROM headchain_heads
    WHERE chain_id = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(chainId);
  return row ? mapHeadRow(row) : null;
}

function listHeadChainHeads(db, chainId, options = {}) {
  const afterSeq = clampInt(options.afterSeq, 0, 0, 1_000_000_000);
  const limit = clampInt(options.limit, 50, 1, 200);
  const rows = db.prepare(`
    SELECT *
    FROM headchain_heads
    WHERE chain_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `).all(chainId, afterSeq, limit);
  return {
    heads: rows.map(mapHeadRow),
    page: {
      afterSeq,
      limit,
      nextAfterSeq: rows.length === limit ? rows.at(-1).seq : null
    }
  };
}

function getHeadByClientHeadId(db, chainId, authorLogin, clientHeadId) {
  const row = db.prepare(`
    SELECT *
    FROM headchain_heads
    WHERE chain_id = ? AND author_login = ? AND client_head_id = ?
  `).get(chainId, authorLogin, clientHeadId);
  return row ? mapHeadRow(row) : null;
}

function getHeadChainHeadByHash(db, chainId, headHash) {
  const row = db.prepare(`
    SELECT *
    FROM headchain_heads
    WHERE chain_id = ? AND head_hash = ?
  `).get(chainId, headHash);
  return row ? mapHeadRow(row) : null;
}

function listCerts(db, filters = {}, options = {}) {
  return listCertPage(db, filters, options).cases;
}

function listPublicRelayCandidates(db) {
  return db.prepare(`
    SELECT *
    FROM certs
    WHERE hidden = 0 AND publish_state = 'public_relay'
    ORDER BY datetime(created_at) DESC
  `).all().map(mapCertRow);
}

function listCertPage(db, filters = {}, options = {}) {
  const { clauses, params } = buildCertWhere(filters, options);
  const limit = clampInt(options.limit, 200, 1, 500);
  const offset = clampInt(options.offset, 0, 0, 1_000_000);
  params.limit = limit;
  params.offset = offset;
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS total FROM certs ${where}`).get(params).total;
  const cases = db.prepare(`
    SELECT * FROM certs
    ${where}
    ORDER BY datetime(created_at) DESC
    LIMIT @limit OFFSET @offset
  `).all(params).map(mapCertRow);
  return {
    cases,
    page: {
      total,
      limit,
      offset,
      nextOffset: offset + cases.length < total ? offset + cases.length : null
    }
  };
}

function certFacets(db, filters = {}, options = {}) {
  const { clauses, params } = buildCertWhere(filters, options);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const count = db.prepare(`SELECT COUNT(*) AS total FROM certs ${where}`).get(params).total;
  return {
    total: count,
    failureClasses: facetRows(db, where, params, "failure_class", "failureClass"),
    submitters: facetRows(db, where, params, "submitter_login", "submitterLogin"),
    projectNamespaces: facetRows(db, where, params, "project_namespace", "projectNamespace"),
    runIds: facetRows(db, where, params, "run_id", "runId"),
    artifactKinds: facetRows(db, where, params, "artifact_kind", "artifactKind")
  };
}

function certActivity(db, options = {}) {
  const days = clampInt(options.days, 14, 1, 60);
  const facets = certFacets(db, {}, { includeHidden: false });
  const recentRows = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS count
    FROM certs
    WHERE hidden = 0 AND date(created_at) >= date('now', @offset)
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all({ offset: `-${days - 1} days` });
  const countsByDay = new Map(recentRows.map((row) => [row.day, row.count]));
  const today = new Date();
  const recentDays = [];

  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - index));
    const key = day.toISOString().slice(0, 10);
    recentDays.push({
      day: key,
      count: countsByDay.get(key) || 0
    });
  }

  return {
    total: facets.total,
    recentDays,
    failureClasses: facets.failureClasses,
    submitters: facets.submitters,
    projectNamespaces: facets.projectNamespaces,
    artifactKinds: facets.artifactKinds
  };
}

function facetRows(db, where, params, column, alias) {
  return db.prepare(`
    SELECT ${column} AS value, COUNT(*) AS count
    FROM certs
    ${where}
    GROUP BY ${column}
    HAVING ${column} IS NOT NULL AND ${column} != ''
    ORDER BY count DESC, value ASC
    LIMIT 100
  `).all(params).map((row) => ({ [alias]: row.value, count: row.count }));
}

function buildCertWhere(filters = {}, options = {}) {
  const clauses = [];
  const params = {};
  if (!options.includeHidden) clauses.push("hidden = 0");
  if (filters.q) {
    clauses.push(`(
      project_target LIKE @q ESCAPE '\\' OR failure_reason LIKE @q ESCAPE '\\' OR revive_condition LIKE @q ESCAPE '\\' OR
      command LIKE @q ESCAPE '\\' OR metric LIKE @q ESCAPE '\\' OR repo_url LIKE @q ESCAPE '\\' OR
      hosted_zip_url LIKE @q ESCAPE '\\' OR artifact_uri LIKE @q ESCAPE '\\' OR artifact_kind LIKE @q ESCAPE '\\' OR
      artifact_label LIKE @q ESCAPE '\\' OR project_namespace LIKE @q ESCAPE '\\' OR run_id LIKE @q ESCAPE '\\' OR tags_json LIKE @q ESCAPE '\\'
    )`);
    params.q = `%${escapeLike(filters.q)}%`;
  }
  if (filters.projectTarget) {
    clauses.push("project_target LIKE @projectTarget ESCAPE '\\'");
    params.projectTarget = `%${escapeLike(filters.projectTarget)}%`;
  }
  if (filters.failureClass) {
    clauses.push("failure_class = @failureClass");
    params.failureClass = filters.failureClass;
  }
  if (filters.projectNamespace) {
    clauses.push("project_namespace LIKE @projectNamespace ESCAPE '\\'");
    params.projectNamespace = `%${escapeLike(filters.projectNamespace)}%`;
  }
  if (filters.runId) {
    clauses.push("run_id LIKE @runId ESCAPE '\\'");
    params.runId = `%${escapeLike(filters.runId)}%`;
  }
  if (filters.tag) {
    clauses.push("tags_json LIKE @tag ESCAPE '\\'");
    params.tag = `%"${escapeLike(String(filters.tag).toLowerCase())}"%`;
  }
  if (filters.submitter) {
    clauses.push("submitter_login LIKE @submitter ESCAPE '\\'");
    params.submitter = `%${escapeLike(filters.submitter)}%`;
  }
  if (filters.repo) {
    clauses.push("repo_url LIKE @repo ESCAPE '\\'");
    params.repo = `%${escapeLike(filters.repo)}%`;
  }
  if (filters.artifactKind) {
    clauses.push("artifact_kind = @artifactKind");
    params.artifactKind = filters.artifactKind;
  }
  if (filters.date) {
    clauses.push("date(created_at) = date(@date)");
    params.date = filters.date;
  }

  return { clauses, params };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function getCert(db, id, options = {}) {
  const clauses = ["id = ?"];
  if (!options.includeHidden) clauses.push("hidden = 0");
  const row = db.prepare(`SELECT * FROM certs WHERE ${clauses.join(" AND ")}`).get(id);
  if (!row) return null;
  const cert = mapCertRow(row);
  cert.versions = db.prepare(`
    SELECT id, version, canonical_json AS canonicalJson, created_at AS createdAt, created_by_login AS createdByLogin
    FROM cert_versions
    WHERE cert_id = ?
    ORDER BY version ASC
  `).all(id);
  cert.events = db.prepare(`
    SELECT id, event_type AS eventType, version, actor_login AS actorLogin, reason, created_at AS createdAt
    FROM cert_events
    WHERE cert_id = ?
    ORDER BY id ASC
  `).all(id);
  cert.canonicalJson = cert.versions.at(-1)?.canonicalJson || "{}";
  return cert;
}

function getCertByPublicCaseId(db, publicCaseId) {
  const row = db.prepare(`
    SELECT * FROM certs
    WHERE public_case_id = ? AND hidden = 0 AND publish_state = 'public_relay'
  `).get(publicCaseId);
  return row ? mapCertRow(row) : null;
}

function getCertByClientRecordId(db, submitterLogin, clientRecordId, options = {}) {
  const clauses = ["submitter_login = ?", "client_record_id = ?"];
  if (!options.includeHidden) clauses.push("hidden = 0");
  const row = db.prepare(`SELECT * FROM certs WHERE ${clauses.join(" AND ")}`).get(submitterLogin, clientRecordId);
  if (!row) return null;
  return getCert(db, row.id, options);
}

function mapCertRow(row) {
  return {
    id: row.id,
    currentVersion: row.current_version,
    hidden: Boolean(row.hidden),
    hiddenReason: row.hidden_reason,
    publishState: row.publish_state || "private",
    publicCaseId: row.public_case_id,
    publishedAt: row.published_at,
    publicBlockReason: row.public_block_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submitterLogin: row.submitter_login,
    submitterId: row.submitter_id,
    submitterAvatarUrl: row.submitter_avatar_url,
    clientRecordId: row.client_record_id,
    projectNamespace: row.project_namespace,
    runId: row.run_id,
    tags: parseTags(row.tags_json),
    artifactUri: row.artifact_uri,
    artifactKind: row.artifact_kind,
    artifactLabel: row.artifact_label,
    artifactSizeBytes: row.artifact_size_bytes,
    projectTarget: row.project_target,
    repoUrl: row.repo_url,
    hostedZipUrl: row.hosted_zip_url,
    zipSha256: row.zip_sha256,
    command: row.command,
    metric: row.metric,
    failureClass: row.failure_class,
    failureReason: row.failure_reason,
    reviveCondition: row.revive_condition,
    provenance: row.provenance
  };
}

function mapHeadRow(row) {
  return {
    chainId: row.chain_id,
    seq: row.seq,
    headHash: row.head_hash,
    prevHeadHash: row.prev_head_hash,
    authorLogin: row.author_login,
    authorId: row.author_id,
    authorAvatarUrl: row.author_avatar_url,
    clientHeadId: row.client_head_id,
    summary: row.summary,
    canonicalJson: row.canonical_json,
    coldCase: parseJson(row.cold_case_json, {}),
    acceptedAt: row.accepted_at,
    dumpedAt: row.dumped_at,
    caseId: row.case_id
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicUser(user) {
  return {
    login: user.login,
    id: user.id || null,
    avatarUrl: user.avatarUrl || null
  };
}

function addPeer(db, { baseUrl, label }) {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const normalizedUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const cleanLabel = String(label || "").trim() || normalizedUrl;
  db.prepare(`
    INSERT INTO peers (id, base_url, label, enabled, created_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(base_url) DO UPDATE SET label = excluded.label, enabled = 1
  `).run(id, normalizedUrl, cleanLabel, createdAt);
  return getPeerByUrl(db, normalizedUrl);
}

function listPeers(db) {
  return db.prepare("SELECT * FROM peers ORDER BY created_at ASC").all().map(mapPeerRow);
}

function getPeer(db, id) {
  const row = db.prepare("SELECT * FROM peers WHERE id = ?").get(id);
  return row ? mapPeerRow(row) : null;
}

function getPeerByUrl(db, baseUrl) {
  const row = db.prepare("SELECT * FROM peers WHERE base_url = ?").get(baseUrl);
  return row ? mapPeerRow(row) : null;
}

function removePeer(db, id) {
  const peer = getPeer(db, id);
  if (!peer) return null;
  // peer_cases is removed via ON DELETE CASCADE.
  db.prepare("DELETE FROM peers WHERE id = ?").run(id);
  return peer;
}

function recordPeerPull(db, id, { status, error = null, pulledCount = null }) {
  db.prepare(`
    UPDATE peers SET
      last_pulled_at = ?,
      last_status = ?,
      last_error = ?,
      pulled_count = COALESCE(?, pulled_count)
    WHERE id = ?
  `).run(nowIso(), status, error, pulledCount, id);
  return getPeer(db, id);
}

function upsertPeerCase(db, peerId, remoteCase) {
  db.prepare(`
    INSERT INTO peer_cases (
      peer_id, remote_id, project_target, failure_class, submitter_login,
      repo_url, project_namespace, run_id, tags_json, remote_created_at, remote_json, pulled_at
    )
    VALUES (
      @peerId, @remoteId, @projectTarget, @failureClass, @submitterLogin,
      @repoUrl, @projectNamespace, @runId, @tagsJson, @remoteCreatedAt, @remoteJson, @pulledAt
    )
    ON CONFLICT(peer_id, remote_id) DO UPDATE SET
      project_target = excluded.project_target,
      failure_class = excluded.failure_class,
      submitter_login = excluded.submitter_login,
      repo_url = excluded.repo_url,
      project_namespace = excluded.project_namespace,
      run_id = excluded.run_id,
      tags_json = excluded.tags_json,
      remote_created_at = excluded.remote_created_at,
      remote_json = excluded.remote_json,
      pulled_at = excluded.pulled_at
  `).run({
    peerId,
    remoteId: String(remoteCase.id),
    projectTarget: remoteCase.projectTarget || null,
    failureClass: remoteCase.failureClass || null,
    submitterLogin: remoteCase.submitterLogin || null,
    repoUrl: remoteCase.repoUrl || null,
    projectNamespace: remoteCase.projectNamespace || null,
    runId: remoteCase.runId || null,
    tagsJson: JSON.stringify(Array.isArray(remoteCase.tags) ? remoteCase.tags : []),
    remoteCreatedAt: remoteCase.createdAt || null,
    remoteJson: JSON.stringify(remoteCase),
    pulledAt: nowIso()
  });
}

function listPeerCases(db, peerId, options = {}) {
  const limit = clampInt(options.limit, 200, 1, 500);
  const offset = clampInt(options.offset, 0, 0, 1_000_000);
  const total = db.prepare("SELECT COUNT(*) AS total FROM peer_cases WHERE peer_id = ?").get(peerId).total;
  const cases = db.prepare(`
    SELECT * FROM peer_cases
    WHERE peer_id = ?
    ORDER BY datetime(remote_created_at) DESC
    LIMIT ? OFFSET ?
  `).all(peerId, limit, offset).map(mapPeerCaseRow);
  return {
    cases,
    page: {
      total,
      limit,
      offset,
      nextOffset: offset + cases.length < total ? offset + cases.length : null
    }
  };
}

function countPeerCases(db, peerId) {
  return db.prepare("SELECT COUNT(*) AS total FROM peer_cases WHERE peer_id = ?").get(peerId).total;
}

function mapPeerRow(row) {
  return {
    id: row.id,
    baseUrl: row.base_url,
    label: row.label,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastPulledAt: row.last_pulled_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    pulledCount: row.pulled_count
  };
}

function mapPeerCaseRow(row) {
  return {
    peerId: row.peer_id,
    remoteId: row.remote_id,
    projectTarget: row.project_target,
    failureClass: row.failure_class,
    submitterLogin: row.submitter_login,
    repoUrl: row.repo_url,
    projectNamespace: row.project_namespace,
    runId: row.run_id,
    tags: parseTags(row.tags_json),
    remoteCreatedAt: row.remote_created_at,
    pulledAt: row.pulled_at,
    remote: parseJson(row.remote_json, {})
  };
}

module.exports = {
  acceptHeadChainHead,
  addPeer,
  amendCert,
  certActivity,
  certFacets,
  countPeerCases,
  createCert,
  getCert,
  getCertByPublicCaseId,
  getHeadChain,
  getHeadChainLatest,
  getPeer,
  getPeerByUrl,
  hideCert,
  listHeadChainHeads,
  listCertPage,
  listCerts,
  listPublicRelayCandidates,
  listPeerCases,
  listPeers,
  openDatabase,
  recordPeerPull,
  removePeer,
  setCertPublishState,
  upsertPeerCase
};
