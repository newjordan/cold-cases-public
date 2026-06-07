const path = require("node:path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const morgan = require("morgan");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
const {
  acceptHeadChainHead,
  addPeer,
  amendCert,
  certActivity,
  certFacets,
  createCert,
  getCert,
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
const { projectPublicCase } = require("./publicRelay");
const {
  FAILURE_CLASSES,
  validateCertInput,
  validateHeadChainId,
  validateHeadInput,
  schemaDescriptor
} = require("./validation");

const AGENT_PROMPT = "Before starting, query this Cold Cases public relay at /cases.json when available for related project targets, failure classes, commands, metrics, and revive conditions. Submit private cold cases only to the authorized ledger endpoint configured for your environment, usually /api/cases on the operator instance. If this work stalls, fails, or becomes a stale loop, submit a metadata-only cold case with project target, command, metric, failure reason, revive condition, provenance, artifact reference, and submitter-provided SHA256. Do not upload, mirror, download, unpack, or hash-stream artifacts.";

function createApp({ db, env = process.env } = {}) {
  if (!db) throw new Error("createApp requires a db");
  if (env.NODE_ENV === "production" && !env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required in production");
  }

  const app = express();
  const admins = parseAdmins(env.ADMIN_GITHUB_LOGINS);
  const agentTokens = parseAgentTokens(env.AGENT_SUBMIT_TOKENS);

  app.set("views", path.join(__dirname, "..", "views"));
  app.set("view engine", "ejs");
  app.locals.failureClasses = FAILURE_CLASSES;

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "upgrade-insecure-requests": null,
        "img-src": ["'self'", "https://avatars.githubusercontent.com", "data:"]
      }
    }
  }));
  if (env.NODE_ENV !== "test") {
    app.use(morgan("combined"));
  }
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(env.PUBLIC_RELAY_DIR || path.join(__dirname, "..", "public-relay")));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(session({
    secret: env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production"
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

  app.get("/api/schema", (req, res) => {
    res.json(schemaDescriptor());
  });

  app.get(["/cases/:id", "/certs/:id"], requireVisibleOrAdmin(db, admins), (req, res) => {
    res.render("detail", { cert: req.cert, canAmend: canAmend(req.currentUser, req.cert, admins) });
  });

  app.get("/submit", requireAuth, (req, res) => {
    res.render("submit", { cert: {}, errors: [] });
  });

  app.post("/submit", requireAuth, (req, res) => handleCreate(req, res, false));
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
      return res.status(400).json({ errors: ["baseUrl must be an http(s) URL"] });
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
    if (!canAmend(req.currentUser, req.cert, admins)) return res.status(403).send("Forbidden");
    res.render("amend", { cert: req.cert, errors: [] });
  });

  app.post(["/cases/:id/amend", "/certs/:id/amend"], requireAuth, requireVisibleOrAdmin(db, admins), (req, res) => handleAmend(req, res, false, admins));
  app.post("/api/cases/:id/amend", requireAuth, requireVisibleOrAdmin(db, admins), (req, res) => handleAmend(req, res, true, admins, "case"));
  app.post("/api/certs/:id/amend", requireAuth, requireVisibleOrAdmin(db, admins), (req, res) => handleAmend(req, res, true, admins, "cert"));

  app.post(["/cases/:id/hide", "/certs/:id/hide"], requireAuth, requireExisting(db, true), (req, res) => {
    if (!isAdmin(req.currentUser, admins)) return res.status(403).send("Forbidden");
    hideCert(db, req.cert.id, req.currentUser, String(req.body.reason || "").trim());
    res.redirect(`/cases/${req.cert.id}`);
  });

  app.post("/api/cases/:id/publish", requireAuth, requireAdmin(admins), requireExisting(db, true), (req, res) => {
    const state = String(req.body.state || "").trim();
    if (!["private", "public_pending", "public_relay", "public_blocked"].includes(state)) {
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

  app.get("/login", passport.authenticate("github", { scope: ["read:user"] }));
  app.get("/auth/github/callback",
    passport.authenticate("github", { failureRedirect: "/" }),
    (req, res) => res.redirect("/"));

  app.post("/logout", (req, res) => {
    req.logout?.(() => {});
    req.session.destroy(() => res.redirect("/"));
  });

  app.use((req, res) => res.status(404).render("not-found"));
  return app;

  function handleCreate(req, res, wantsJson, responseKey = "cert") {
    const validation = validateCertInput(req.body);
    if (!validation.ok) {
      if (wantsJson) return res.status(400).json({ errors: validation.errors });
      return res.status(400).render("submit", { cert: req.body, errors: validation.errors });
    }
    const cert = createCert(db, validation.cert, req.currentUser);
    if (wantsJson) return res.status(cert.idempotentReplay ? 200 : 201).json({ [responseKey]: cert });
    return res.redirect(`/cases/${cert.id}`);
  }

  function handleAmend(req, res, wantsJson, adminSet, responseKey = "cert") {
    if (!canAmend(req.currentUser, req.cert, adminSet)) {
      if (wantsJson) return res.status(403).json({ errors: ["Forbidden"] });
      return res.status(403).send("Forbidden");
    }
    const validation = validateCertInput(req.body);
    if (!validation.ok) {
      if (wantsJson) return res.status(400).json({ errors: validation.errors });
      return res.status(400).render("amend", { cert: { ...req.cert, ...req.body }, errors: validation.errors });
    }
    const cert = amendCert(db, req.cert.id, validation.cert, req.currentUser);
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
  return res.status(401).send("Authentication required");
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
    if (!cert) return res.status(404).send("Not found");
    req.cert = cert;
    next();
  };
}

function requireVisibleOrAdmin(db, admins) {
  return (req, res, next) => {
    const cert = getCert(db, req.params.id, { includeHidden: true });
    if (!cert) return res.status(404).send("Not found");
    if (cert.hidden && !isAdmin(req.currentUser, admins)) return res.status(404).send("Not found");
    req.cert = cert;
    next();
  };
}

function canAmend(user, cert, admins) {
  if (!user) return false;
  return cert.submitterLogin === user.login || isAdmin(user, admins);
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
  const profile = agentTokens.get(token);
  if (!profile) return null;
  return {
    login: `agent:${profile}`,
    id: `agent:${profile}`,
    avatarUrl: null
  };
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

module.exports = { createApp };
