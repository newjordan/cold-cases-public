const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const morgan = require("morgan");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
const { createRateLimiter, readPositiveInt } = require("./rateLimit");
const { SESSION_TTL_MS, SqliteSessionStore } = require("./sessionStore");
const {
  acceptHeadChainHead,
  addPeer,
  amendCert,
  certActivity,
  certFacets,
  createCert,
  getCert,
  getCertByPublicCaseId,
  getHeadChain,
  getHeadChainLatest,
  getPeer,
  hideCert,
  listCertPage,
  listHeadChainHeads,
  listPeerCases,
  listPeers,
  removePeer,
  setCertPublishState
} = require("./db");
const { pullPeer, isAllowedPeerUrl, normalizePeerUrl } = require("./peers");
const { buildPublicRelayExport, projectPublicCase, publicSchema } = require("./publicRelay");
const {
  FAILURE_CLASSES,
  validateCertInput,
  validateHeadChainId,
  validateHeadInput,
  schemaDescriptor
} = require("./validation");

const AGENT_PROMPT = "Before starting, query this Cold Cases public relay at /cases.json when available for related project targets, failure classes, commands, metrics, and revive conditions. Submit private cold cases only to the authorized ledger endpoint configured for your environment, usually /api/cases on the operator instance. If this work stalls, fails, or becomes a stale loop, submit a metadata-only cold case with project target, command, metric, failure reason, revive condition, provenance, artifact reference, and submitter-provided SHA256. Do not upload, mirror, download, unpack, or hash-stream artifacts.";
const PUBLISH_STATES = ["private", "public_pending", "public_relay", "public_blocked"];
const WEAK_SECRETS = new Set(["change-me", "dev-only-change-me", "local-share"]);

function createApp({ db, env = process.env } = {}) {
  if (!db) throw new Error("createApp requires a db");
  assertProductionSecret(env);

  const app = express();
  const admins = parseAdmins(env.ADMIN_GITHUB_LOGINS);
  const agentTokens = parseAgentTokens(env.AGENT_SUBMIT_TOKENS);
  const oauthConfigured = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  if (env.TRUST_PROXY === "1") app.set("trust proxy", 1);

  app.set("views", path.join(__dirname, "..", "views"));
  app.set("view engine", "ejs");
  app.locals.failureClasses = FAILURE_CLASSES;

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "upgrade-insecure-requests": null,
        "style-src": ["'self'"],
        "img-src": ["'self'", "https://avatars.githubusercontent.com", "data:"]
      }
    }
  }));
  if (env.NODE_ENV !== "test") {
    app.use(morgan("combined"));
  }
  app.use(createRateLimiter({
    writeMax: readPositiveInt(env.WRITE_RATE_LIMIT_MAX, 120),
    readMax: readPositiveInt(env.READ_RATE_LIMIT_MAX, 600)
  }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (req, res) => {
    try {
      db.prepare("SELECT 1 AS ok").get();
      res.set("Cache-Control", "no-store");
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false });
    }
  });

  app.get("/schema.json", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(publicSchema());
  });

  app.get(["/cases.json", "/facets.json"], (req, res) => {
    const relay = buildPublicRelayExport(db);
    if (!relay.ok) {
      return res.status(409).json({
        errors: ["Public relay is blocked until every public_relay record passes the sanitizer."]
      });
    }
    res.set("Cache-Control", "no-store");
    if (req.path === "/facets.json") return res.json(relay.files["facets.json"]);
    return res.json(relay.files["cases.json"]);
  });

  app.get("/cases/:publicCaseId", (req, res, next) => {
    const match = /^([a-f0-9]{32})\.json$/.exec(req.params.publicCaseId);
    if (!match) return next();
    const cert = getCertByPublicCaseId(db, match[1]);
    if (!cert) return res.status(404).json({ errors: ["Not found"] });
    const projection = projectPublicCase(cert);
    if (!projection.ok) return res.status(404).json({ errors: ["Not found"] });
    res.set("Cache-Control", "no-store");
    return res.json(projection.case);
  });

  app.use(express.static(env.PUBLIC_RELAY_DIR || path.join(__dirname, "..", "public-relay")));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(session({
    store: new SqliteSessionStore(db),
    secret: env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS
    }
  }));

  configurePassport(app, env);

  app.use((req, res, next) => {
    const user = req.user || req.session.user || null;
    const agentUser = authenticateAgent(req, agentTokens);
    req.currentUser = user ? normalizeUser(user) : agentUser;
    res.locals.user = req.currentUser;
    res.locals.isAdmin = isAdmin(req.currentUser, admins);
    res.locals.admins = admins;
    res.locals.oauthConfigured = oauthConfigured;
    if (!(agentUser && !user)) {
      if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    }
    res.locals.csrfToken = req.session.csrfToken || "";
    next();
  });

  if (env.NODE_ENV === "test") {
    app.post("/__test/login", (req, res) => {
      req.session.user = normalizeUser(req.body);
      res.json({ ok: true, user: req.session.user });
    });
  }

  app.get("/", (req, res) => {
    res.render("index", {
      activity: certActivity(db),
      agentPrompt: AGENT_PROMPT
    });
  });

  app.get("/browse", (req, res) => {
    const filters = pickFilters(req.query);
    const includeHidden = res.locals.isAdmin && req.query.includeHidden === "1";
    const page = listCertPage(db, filters, {
      includeHidden,
      limit: req.query.limit || 50,
      offset: req.query.offset
    });
    const hrefFor = (offset) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value) params.set(key, value);
      }
      if (includeHidden) params.set("includeHidden", "1");
      params.set("limit", String(page.page.limit));
      params.set("offset", String(offset));
      return `/browse?${params.toString()}`;
    };
    res.render("browse", {
      filters,
      cases: page.cases,
      pageInfo: page.page,
      includeHidden,
      prevHref: page.page.offset > 0 ? hrefFor(Math.max(0, page.page.offset - page.page.limit)) : null,
      nextHref: page.page.nextOffset === null ? null : hrefFor(page.page.nextOffset)
    });
  });

  app.get("/api/schema", (req, res) => {
    res.json(schemaDescriptor());
  });

  app.get(["/cases/:id", "/certs/:id"], requireVisibleOrAdmin(db, admins), (req, res) => {
    res.render("detail", {
      cert: req.cert,
      canAmend: canAmend(req.currentUser, req.cert, admins),
      publishErrors: []
    });
  });

  app.get("/submit", requireAuth, (req, res) => {
    res.render("submit", { cert: {}, errors: [] });
  });

  app.post("/submit", requireAuth, requireFormCsrf, (req, res) => handleCreate(req, res, false));
  app.post("/api/cases", requireAuth, (req, res) => handleCreate(req, res, true, "case"));
  app.post("/api/certs", requireAuth, (req, res) => handleCreate(req, res, true, "cert"));

  app.post("/api/headchains/:chainId/heads", requireAuth, (req, res) => handleHeadCreate(req, res));
  app.get("/api/headchains/:chainId/head", requireAuth, (req, res) => handleHeadLatest(req, res));
  app.get("/api/headchains/:chainId/heads", requireAuth, (req, res) => handleHeadList(req, res));

  // Read-only peer federation. Listing peers and browsing mirrored cases is public
  // (it only ever exposes metadata a peer already publishes); registering, removing,
  // and triggering a pull are admin-only operator actions.
  app.get("/api/peers", (req, res) => {
    res.json({ peers: listPeers(db) });
  });

  app.post("/api/peers", requireAuth, requireAdmin(admins), (req, res) => {
    const baseUrl = normalizePeerUrl(req.body.baseUrl);
    if (!baseUrl || !isAllowedPeerUrl(baseUrl)) {
      return res.status(400).json({ errors: ["baseUrl must be an http(s) origin that is not loopback, link-local, or a metadata host"] });
    }
    const peer = addPeer(db, { baseUrl, label: req.body.label });
    res.status(201).json({ peer });
  });

  app.delete("/api/peers/:id", requireAuth, requireAdmin(admins), (req, res) => {
    const peer = removePeer(db, req.params.id);
    if (!peer) return res.status(404).json({ errors: ["peer not found"] });
    res.json({ peer });
  });

  app.post("/api/peers/:id/pull", requireAuth, requireAdmin(admins), async (req, res) => {
    const peer = getPeer(db, req.params.id);
    if (!peer) return res.status(404).json({ errors: ["peer not found"] });
    const result = await pullPeer(db, peer.id);
    if (!result.ok) return res.status(502).json({ errors: [result.error], result });
    res.json({ peer: getPeer(db, peer.id), result });
  });

  app.get("/api/peers/:id/cases", (req, res) => {
    const peer = getPeer(db, req.params.id);
    if (!peer) return res.status(404).json({ errors: ["peer not found"] });
    const page = listPeerCases(db, peer.id, { limit: req.query.limit, offset: req.query.offset });
    res.json({ peer, cases: page.cases, page: page.page });
  });

  app.get(["/cases/:id/amend", "/certs/:id/amend"], requireAuth, requireVisibleOrAdmin(db, admins), (req, res) => {
    if (!canAmend(req.currentUser, req.cert, admins)) return res.status(403).render("message", forbiddenMessage());
    res.render("amend", { cert: req.cert, errors: [] });
  });

  app.post(["/cases/:id/amend", "/certs/:id/amend"], requireAuth, requireFormCsrf, requireVisibleOrAdmin(db, admins), (req, res) => handleAmend(req, res, false, admins));
  app.post("/api/cases/:id/amend", requireAuth, requireVisibleOrAdmin(db, admins), (req, res) => handleAmend(req, res, true, admins, "case"));
  app.post("/api/certs/:id/amend", requireAuth, requireVisibleOrAdmin(db, admins), (req, res) => handleAmend(req, res, true, admins, "cert"));

  app.post(["/cases/:id/hide", "/certs/:id/hide"], requireAuth, requireFormCsrf, requireExisting(db, true), (req, res) => {
    if (!isAdmin(req.currentUser, admins)) return res.status(403).render("message", forbiddenMessage());
    hideCert(db, req.cert.id, req.currentUser, String(req.body.reason || "").trim());
    res.redirect(`/cases/${req.cert.id}`);
  });

  app.post("/cases/:id/publish", requireAuth, requireFormCsrf, requireExisting(db, true), (req, res) => {
    if (!isAdmin(req.currentUser, admins)) return res.status(403).render("message", forbiddenMessage());
    const state = String(req.body.state || "").trim();
    const view = {
      cert: req.cert,
      canAmend: canAmend(req.currentUser, req.cert, admins)
    };
    if (!PUBLISH_STATES.includes(state)) {
      return res.status(400).render("detail", { ...view, publishErrors: ["state must be private, public_pending, public_relay, or public_blocked"] });
    }
    if (state === "public_relay") {
      const projection = projectPublicCase(req.cert);
      if (!projection.ok) return res.status(400).render("detail", { ...view, publishErrors: projection.errors });
    }
    setCertPublishState(db, req.cert.id, state, req.currentUser, req.body.reason);
    res.redirect(`/cases/${req.cert.id}`);
  });

  app.post("/api/cases/:id/publish", requireAuth, requireAdmin(admins), requireExisting(db, true), (req, res) => {
    const state = String(req.body.state || "").trim();
    if (!PUBLISH_STATES.includes(state)) {
      return res.status(400).json({ errors: ["state must be private, public_pending, public_relay, or public_blocked"] });
    }
    if (state === "public_relay") {
      const projection = projectPublicCase(req.cert);
      if (!projection.ok) return res.status(400).json({ errors: projection.errors });
    }
    const cert = setCertPublishState(db, req.cert.id, state, req.currentUser, req.body.reason);
    const projection = state === "public_relay" ? projectPublicCase(cert) : null;
    res.json({ case: cert, publicCase: projection?.ok ? projection.case : null });
  });

  app.get("/api/certs", (req, res) => {
    const filters = pickFilters(req.query);
    const includeHidden = isAdmin(req.currentUser, admins) && req.query.includeHidden === "1";
    const page = listCertPage(db, filters, { includeHidden, limit: req.query.limit, offset: req.query.offset });
    res.json({ certs: page.cases, page: page.page, filters });
  });

  app.get("/api/cases", (req, res) => {
    const filters = pickFilters(req.query);
    const includeHidden = isAdmin(req.currentUser, admins) && req.query.includeHidden === "1";
    const page = listCertPage(db, filters, { includeHidden, limit: req.query.limit, offset: req.query.offset });
    res.json({ cases: page.cases, page: page.page, filters });
  });

  app.get("/api/facets", (req, res) => {
    const filters = pickFilters(req.query);
    const includeHidden = isAdmin(req.currentUser, admins) && req.query.includeHidden === "1";
    res.json({ facets: certFacets(db, filters, { includeHidden }), filters });
  });

  app.get("/api/certs/:id", requireVisibleOrAdmin(db, admins), (req, res) => {
    res.json({ cert: req.cert });
  });

  app.get("/api/cases/:id", requireVisibleOrAdmin(db, admins), (req, res) => {
    res.json({ case: req.cert });
  });

  app.get("/api/certs/:id/canonical", requireVisibleOrAdmin(db, admins), (req, res) => {
    res.type("application/json").send(req.cert.canonicalJson);
  });

  app.get("/api/cases/:id/canonical", requireVisibleOrAdmin(db, admins), (req, res) => {
    res.type("application/json").send(req.cert.canonicalJson);
  });

  app.get("/login", (req, res, next) => {
    if (!oauthConfigured) {
      return res.status(503).render("message", {
        title: "Login unavailable",
        heading: "GitHub login is not configured",
        message: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or call the API with an agent token."
      });
    }
    return passport.authenticate("github", { scope: ["read:user"] })(req, res, next);
  });
  app.get("/auth/github/callback",
    (req, res, next) => {
      if (!oauthConfigured) {
        return res.status(503).render("message", {
          title: "Login unavailable",
          heading: "GitHub login is not configured",
          message: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET before using the GitHub callback."
        });
      }
      return passport.authenticate("github", { failureRedirect: "/" })(req, res, next);
    },
    (req, res) => res.redirect("/"));

  app.post("/logout", requireFormCsrf, (req, res) => {
    const finish = () => res.redirect("/");
    if (typeof req.logout === "function") {
      req.logout(() => req.session.destroy(finish));
      return;
    }
    req.session.destroy(finish);
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path.endsWith(".json")) {
      return res.status(404).json({ errors: ["Not found"] });
    }
    return res.status(404).render("not-found");
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const constraint = isConstraint(error);
    const status = constraint ? 409 : (Number.isInteger(error.status) && error.status >= 400 ? error.status : 500);
    const message = constraint
      ? "Record conflicts with an existing case"
      : (status >= 500 ? "Internal error" : (error.message || "Request failed"));
    if (status >= 500) console.error(error);
    if (req.path.startsWith("/api/") || req.path.endsWith(".json")) {
      return res.status(status).json({ errors: [message] });
    }
    return res.status(status).render("message", {
      title: "Request failed",
      heading: "Request failed",
      message
    });
  });

  return app;

  function requireFormCsrf(req, res, next) {
    const sent = Buffer.from(String(req.body?._csrf || ""));
    const expected = Buffer.from(String(req.session?.csrfToken || ""));
    const valid = sent.length > 0 && sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
    if (valid) return next();
    return res.status(403).render("message", {
      title: "Invalid session",
      heading: "Invalid session token",
      message: "Reload the page and submit the form again."
    });
  }

  function handleCreate(req, res, wantsJson, responseKey = "cert") {
    const validation = validateCertInput(req.body);
    if (!validation.ok) {
      if (wantsJson) return res.status(400).json({ errors: validation.errors });
      return res.status(400).render("submit", { cert: req.body, errors: validation.errors });
    }
    let cert;
    try {
      cert = createCert(db, validation.cert, req.currentUser);
    } catch (error) {
      if (!isConstraint(error)) throw error;
      const message = "Record conflicts with an existing case";
      if (wantsJson) return res.status(409).json({ errors: [message] });
      return res.status(409).render("submit", { cert: req.body, errors: [message] });
    }
    if (wantsJson) return res.status(cert.idempotentReplay ? 200 : 201).json({ [responseKey]: cert });
    return res.redirect(`/cases/${cert.id}`);
  }

  function handleAmend(req, res, wantsJson, adminSet, responseKey = "cert") {
    if (!canAmend(req.currentUser, req.cert, adminSet)) {
      if (wantsJson) return res.status(403).json({ errors: ["Forbidden"] });
      return res.status(403).render("message", forbiddenMessage());
    }
    const validation = validateCertInput(req.body);
    if (!validation.ok) {
      if (wantsJson) return res.status(400).json({ errors: validation.errors });
      return res.status(400).render("amend", { cert: { ...req.cert, ...req.body }, errors: validation.errors });
    }
    let cert;
    try {
      cert = amendCert(db, req.cert.id, validation.cert, req.currentUser);
    } catch (error) {
      if (!isConstraint(error)) throw error;
      const message = "Record conflicts with an existing case";
      if (wantsJson) return res.status(409).json({ errors: [message] });
      return res.status(409).render("amend", { cert: { ...req.cert, ...req.body }, errors: [message] });
    }
    if (wantsJson) return res.json({ [responseKey]: cert });
    return res.redirect(`/cases/${cert.id}`);
  }

  function handleHeadCreate(req, res) {
    const chainValidation = validateHeadChainId(req.params.chainId);
    if (!chainValidation.ok) return res.status(400).json({ errors: chainValidation.errors });

    const validation = validateHeadInput(req.body);
    if (!validation.ok) return res.status(400).json({ errors: validation.errors });

    const result = acceptHeadChainHead(db, chainValidation.chainId, validation.head, req.currentUser);
    if (result.conflict) {
      return res.status(result.statusCode || 409).json({
        errors: result.errors,
        latestHead: result.latestHead
      });
    }
    return res.status(result.idempotentReplay ? 200 : 201).json({
      head: result.head,
      dumpedCases: result.dumpedCases
    });
  }

  function handleHeadLatest(req, res) {
    const chainValidation = validateHeadChainId(req.params.chainId);
    if (!chainValidation.ok) return res.status(400).json({ errors: chainValidation.errors });
    const chain = getHeadChain(db, chainValidation.chainId) || {
      chainId: chainValidation.chainId,
      latestSeq: 0,
      latestHash: null,
      createdAt: null,
      updatedAt: null
    };
    return res.json({ chain, head: getHeadChainLatest(db, chainValidation.chainId) });
  }

  function handleHeadList(req, res) {
    const chainValidation = validateHeadChainId(req.params.chainId);
    if (!chainValidation.ok) return res.status(400).json({ errors: chainValidation.errors });
    const page = listHeadChainHeads(db, chainValidation.chainId, {
      afterSeq: req.query.afterSeq,
      limit: req.query.limit
    });
    return res.json({ heads: page.heads, page: page.page });
  }
}

function configurePassport(app, env) {
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
      clientID: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      callbackURL: env.GITHUB_CALLBACK_URL || "/auth/github/callback"
    }, (accessToken, refreshToken, profile, done) => {
      done(null, normalizeUser({
        login: profile.username,
        id: profile.id,
        avatarUrl: profile.photos?.[0]?.value || null
      }));
    }));
  } else {
    passport.use("github", new NoopStrategy());
  }

  app.use(passport.initialize());
  app.use(passport.session());
}

class NoopStrategy extends passport.Strategy {
  constructor() {
    super();
    this.name = "github";
  }

  authenticate() {
    this.fail("GitHub OAuth is not configured", 503);
  }
}

function requireAuth(req, res, next) {
  if (req.currentUser) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ errors: ["Authentication required"] });
  const hint = res.locals.oauthConfigured
    ? "Sign in with GitHub to continue."
    : "GitHub login is not configured on this instance. API clients can send an agent token.";
  return res.status(401).render("message", {
    title: "Authentication required",
    heading: "Authentication required",
    message: hint
  });
}

function requireAdmin(admins) {
  return (req, res, next) => {
    if (isAdmin(req.currentUser, admins)) return next();
    return res.status(403).json({ errors: ["Admin privileges required"] });
  };
}

function requireExisting(db, includeHidden) {
  return (req, res, next) => {
    const cert = getCert(db, req.params.id, { includeHidden });
    if (!cert) return respondNotFound(req, res);
    req.cert = cert;
    next();
  };
}

function requireVisibleOrAdmin(db, admins) {
  return (req, res, next) => {
    const cert = getCert(db, req.params.id, { includeHidden: true });
    if (!cert) return respondNotFound(req, res);
    if (cert.hidden && !isAdmin(req.currentUser, admins)) return respondNotFound(req, res);
    req.cert = cert;
    next();
  };
}

function respondNotFound(req, res) {
  if (req.path.startsWith("/api/")) return res.status(404).json({ errors: ["Not found"] });
  return res.status(404).render("not-found");
}

function forbiddenMessage() {
  return {
    title: "Forbidden",
    heading: "Forbidden",
    message: "You can amend a cold case only when you submitted it or your login is an admin."
  };
}

function canAmend(user, cert, admins) {
  if (!user) return false;
  return sameLogin(cert.submitterLogin, user.login) || isAdmin(user, admins);
}

function sameLogin(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function isAdmin(user, admins) {
  return Boolean(user && admins.has(String(user.login).toLowerCase()));
}

function parseAdmins(value = "") {
  return new Set(String(value).split(",").map((login) => login.trim().toLowerCase()).filter(Boolean));
}

function parseAgentTokens(value = "") {
  const tokens = new Map();
  for (const pair of String(value).split(",")) {
    const [profile, ...tokenParts] = pair.split(":");
    const token = tokenParts.join(":").trim();
    const cleanProfile = String(profile || "").trim();
    if (cleanProfile && token) tokens.set(token, cleanProfile);
  }
  return tokens;
}

function authenticateAgent(req, agentTokens) {
  if (!agentTokens.size || !req.path.startsWith("/api/")) return null;
  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = bearer || String(req.get("x-cold-cases-agent-token") || "").trim();
  if (!token) return null;
  const profile = matchAgentToken(token, agentTokens);
  if (!profile) return null;
  return {
    login: `agent:${profile}`,
    id: `agent:${profile}`,
    avatarUrl: null
  };
}

function matchAgentToken(token, agentTokens) {
  const presented = Buffer.from(token);
  let profile = null;
  for (const [known, knownProfile] of agentTokens) {
    const candidate = Buffer.from(known);
    if (candidate.length !== presented.length) continue;
    if (crypto.timingSafeEqual(candidate, presented)) profile = knownProfile;
  }
  return profile;
}

function pickFilters(source) {
  return {
    q: source.q || "",
    projectTarget: source.projectTarget || "",
    projectNamespace: source.projectNamespace || "",
    runId: source.runId || "",
    failureClass: source.failureClass || "",
    submitter: source.submitter || "",
    repo: source.repo || "",
    artifactKind: source.artifactKind || "",
    tag: source.tag || "",
    date: source.date || ""
  };
}

function normalizeUser(user) {
  return {
    login: String(user.login || "").trim(),
    id: user.id ? String(user.id) : null,
    avatarUrl: user.avatarUrl || user.avatar_url || null
  };
}

function isConstraint(error) {
  return typeof error?.code === "string" && error.code.startsWith("SQLITE_CONSTRAINT");
}

function assertProductionSecret(env) {
  if (env.NODE_ENV !== "production") return;
  const secret = String(env.SESSION_SECRET || "");
  if (secret.length < 16 || WEAK_SECRETS.has(secret)) {
    throw new Error("SESSION_SECRET must be a unique value of at least 16 characters in production");
  }
}

module.exports = { createApp };
