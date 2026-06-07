const FAILURE_CLASSES = [
  "metric_regression",
  "correctness_failure",
  "reproducibility_failure",
  "resource_exhaustion",
  "safety_boundary",
  "stale_loop",
  "abandoned"
];

const REQUIRED_FIELDS = [
  "projectTarget",
  "repoUrl",
  "zipSha256",
  "command",
  "metric",
  "failureClass",
  "failureReason",
  "reviveCondition",
  "provenance"
];

const OPTIONAL_FIELDS = [
  "clientRecordId",
  "projectNamespace",
  "runId",
  "hostedZipUrl",
  "artifactUri",
  "artifactKind",
  "artifactLabel"
];

function schemaDescriptor() {
  return {
    schema: "cold_cases.agent_dump.v1",
    recordSchema: "cold_cases.cold_case.v1",
    headSchema: "cold_cases.head.v1",
    requiredFields: REQUIRED_FIELDS,
    optionalFields: [...OPTIONAL_FIELDS, "artifactSizeBytes", "tags"],
    failureClasses: FAILURE_CLASSES,
    payloadBoundary: [
      "external_links_only",
      "local_or_tailnet_artifact_references_only",
      "submitter_provided_hashes",
      "no_upload",
      "no_mirror",
      "no_download",
      "no_unpack",
      "no_hash_stream",
      "append_only_events"
    ],
    endpoints: {
      listCases: "/api/cases",
      createCase: "/api/cases",
      facets: "/api/facets",
      getCase: "/api/cases/{id}",
      getCanonicalJson: "/api/cases/{id}/canonical",
      amendCase: "/api/cases/{id}/amend",
      setPublishState: "/api/cases/{id}/publish",
      latestHead: "/api/headchains/{chainId}/head",
      listHeads: "/api/headchains/{chainId}/heads",
      submitHead: "/api/headchains/{chainId}/heads",
      listPeers: "/api/peers",
      addPeer: "/api/peers",
      removePeer: "/api/peers/{id}",
      pullPeer: "/api/peers/{id}/pull",
      listPeerCases: "/api/peers/{id}/cases",
      schema: "/api/schema",
      publicRelayIndex: "/cases.json",
      publicRelayFacets: "/facets.json",
      publicRelaySchema: "/schema.json",
      publicRelayCase: "/cases/{publicCaseId}.json",
      legacyListAlias: "/api/certs",
      legacyGetAlias: "/api/certs/{id}"
    },
    federation: {
      model: "self_hosted_per_operator",
      peerPull: "read_only_public_cases_only",
      boundary: "mirrored peer cases are stored separately and never merged into local certs"
    },
    publicRelay: {
      model: "static_read_only_sanitized_projection",
      defaultPublishState: "private",
      publishStates: ["private", "public_pending", "public_relay", "public_blocked"],
      boundary: "public relay records are sanitized derivatives and never expose private canonical JSON or private artifact URIs"
    },
    auth: {
      browser: "GitHub OAuth session",
      agent: "Bearer token from AGENT_SUBMIT_TOKENS, attributed as agent:{profile}"
    },
    query: {
      filters: ["q", "projectTarget", "projectNamespace", "runId", "failureClass", "submitter", "repo", "artifactKind", "tag", "date"],
      pagination: {
        limit: "1-500, default 200",
        offset: "0-based row offset"
      },
      idempotency: "Provide clientRecordId to make repeated agent submissions return the existing record for the same submitter."
    }
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeReference(value) {
  if (!value) return true;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^(javascript|data):/i.test(value)) return false;
  return value.length <= 1000;
}

function validateCertInput(input) {
  const cert = {};
  for (const field of REQUIRED_FIELDS) {
    cert[field] = normalizeString(input[field]);
  }
  for (const field of OPTIONAL_FIELDS) {
    cert[field] = normalizeString(input[field]);
  }
  cert.tags = normalizeTags(input.tags);
  cert.artifactSizeBytes = normalizeOptionalInteger(input.artifactSizeBytes);

  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!cert[field]) {
      errors.push(`${field} is required`);
    }
  }

  if (cert.repoUrl && !isValidUrl(cert.repoUrl)) {
    errors.push("repoUrl must be an http(s) URL");
  }
  if (cert.hostedZipUrl && !isValidUrl(cert.hostedZipUrl)) {
    errors.push("hostedZipUrl must be an http(s) URL");
  }
  if (!cert.hostedZipUrl && !cert.artifactUri) {
    errors.push("hostedZipUrl or artifactUri is required");
  }
  if (cert.artifactUri && !isSafeReference(cert.artifactUri)) {
    errors.push("artifactUri must be a safe reference string of 1000 characters or fewer");
  }
  if (cert.zipSha256 && !/^[a-fA-F0-9]{64}$/.test(cert.zipSha256)) {
    errors.push("zipSha256 must be a 64-character hex SHA256");
  }
  if (cert.failureClass && !FAILURE_CLASSES.includes(cert.failureClass)) {
    errors.push("failureClass is not allowed");
  }
  if (cert.clientRecordId && cert.clientRecordId.length > 200) {
    errors.push("clientRecordId must be 200 characters or fewer");
  }
  if (cert.projectNamespace && cert.projectNamespace.length > 200) {
    errors.push("projectNamespace must be 200 characters or fewer");
  }
  if (cert.runId && cert.runId.length > 200) {
    errors.push("runId must be 200 characters or fewer");
  }
  if (cert.artifactKind && cert.artifactKind.length > 60) {
    errors.push("artifactKind must be 60 characters or fewer");
  }
  if (cert.artifactLabel && cert.artifactLabel.length > 200) {
    errors.push("artifactLabel must be 200 characters or fewer");
  }
  if (cert.artifactSizeBytes !== null && cert.artifactSizeBytes < 0) {
    errors.push("artifactSizeBytes must be a non-negative integer");
  }
  if (cert.tags.length > 20) {
    errors.push("tags must contain 20 entries or fewer");
  }
  if (cert.tags.some((tag) => tag.length > 60)) {
    errors.push("each tag must be 60 characters or fewer");
  }

  cert.zipSha256 = cert.zipSha256.toLowerCase();
  for (const field of OPTIONAL_FIELDS) {
    cert[field] = cert[field] || null;
  }
  return { ok: errors.length === 0, errors, cert };
}

function validateHeadChainId(value) {
  const chainId = normalizeString(value);
  if (!chainId) return { ok: false, errors: ["chainId is required"] };
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(chainId)) {
    return { ok: false, errors: ["chainId must be 1-200 characters using letters, numbers, dot, underscore, colon, or dash"] };
  }
  return { ok: true, chainId };
}

function validateHeadInput(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["head payload must be an object"] };
  }

  const schema = normalizeString(input.schema);
  const clientHeadId = normalizeString(input.clientHeadId);
  const summary = normalizeString(input.summary);
  const prevHeadHash = normalizeString(input.prevHeadHash);

  if (schema !== "cold_cases.head.v1") {
    errors.push("schema must be cold_cases.head.v1");
  }
  if (!clientHeadId) {
    errors.push("clientHeadId is required");
  } else if (clientHeadId.length > 200) {
    errors.push("clientHeadId must be 200 characters or fewer");
  }
  if (!summary) {
    errors.push("summary is required");
  } else if (summary.length > 1000) {
    errors.push("summary must be 1000 characters or fewer");
  }
  if (prevHeadHash && !/^[a-fA-F0-9]{64}$/.test(prevHeadHash)) {
    errors.push("prevHeadHash must be a 64-character hex SHA256 when provided");
  }

  const coldCaseValidation = validateCertInput(input.coldCase || {});
  if (!coldCaseValidation.ok) {
    for (const error of coldCaseValidation.errors) {
      errors.push(`coldCase.${error}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    head: {
      schema,
      clientHeadId,
      summary,
      prevHeadHash: prevHeadHash ? prevHeadHash.toLowerCase() : null,
      coldCase: coldCaseValidation.cert
    }
  };
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(raw
    .map((tag) => normalizeString(tag).toLowerCase())
    .filter(Boolean))];
}

function normalizeOptionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && String(parsed) === String(value).trim() ? parsed : -1;
}

function canonicalizeCert(cert, metadata = {}) {
  const versionCreatedAt = metadata.versionCreatedAt || metadata.createdAt;
  const caseCreatedAt = metadata.caseCreatedAt || versionCreatedAt;

  return {
    schema: "cold_cases.cold_case.v1",
    certId: metadata.certId,
    version: metadata.version,
    projectTarget: cert.projectTarget,
    failureClass: cert.failureClass,
    command: cert.command,
    metric: cert.metric,
    failureReason: cert.failureReason,
    reviveCondition: cert.reviveCondition,
    provenance: cert.provenance,
    externalResearchRepoUrl: cert.repoUrl,
    externalHostedZipUrl: cert.hostedZipUrl || null,
    submittedZipSha256: cert.zipSha256,
    artifact: {
      uri: cert.artifactUri || cert.hostedZipUrl || null,
      kind: cert.artifactKind || "zip",
      label: cert.artifactLabel || null,
      sizeBytes: cert.artifactSizeBytes ?? null,
      verificationStatus: "submitter_reference_unverified",
      hostingBoundary: "not_uploaded_or_mirrored_by_cold_cases"
    },
    pipeline: {
      clientRecordId: cert.clientRecordId || null,
      projectNamespace: cert.projectNamespace || null,
      runId: cert.runId || null,
      tags: cert.tags || []
    },
    submitter: metadata.submitter,
    visibility: {
      hidden: Boolean(metadata.hidden),
      reason: metadata.hiddenReason || null
    },
    caseCreatedAt,
    versionCreatedAt,
    updatedAt: metadata.updatedAt || versionCreatedAt,
    createdAt: versionCreatedAt
  };
}

module.exports = {
  FAILURE_CLASSES,
  OPTIONAL_FIELDS,
  REQUIRED_FIELDS,
  canonicalizeCert,
  schemaDescriptor,
  validateCertInput,
  validateHeadChainId,
  validateHeadInput
};
