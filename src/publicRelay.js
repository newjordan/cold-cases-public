const crypto = require("node:crypto");

const PUBLIC_SCHEMA = "cold_cases.public_case.v1";

function projectPublicCase(cert) {
  const errors = [];
  for (const [field, value] of Object.entries(publicTextFields(cert))) {
    const issue = suspiciousReason(value);
    if (issue) errors.push(`${field}: ${issue}`);
  }
  if (errors.length) {
    return { ok: false, errors };
  }

  const artifact = projectArtifact(cert);
  return {
    ok: true,
    case: {
      schema: PUBLIC_SCHEMA,
      publicCaseId: cert.publicCaseId || makePublicCaseId(cert.id),
      projectTarget: cert.projectTarget,
      failureClass: cert.failureClass,
      command: cert.command,
      metric: cert.metric,
      failureReason: cert.failureReason,
      reviveCondition: cert.reviveCondition,
      provenance: cert.provenance,
      artifact,
      artifactAccess: artifact.accessMode === "private_reference_redacted"
        ? {
            mode: "contact_submitter",
            policy: "Access is handled outside Cold Cases by the submitter or project owner."
          }
        : null,
      pipeline: {
        projectNamespace: safeOptional(cert.projectNamespace),
        runId: safeOptional(cert.runId),
        tags: Array.isArray(cert.tags) ? cert.tags.filter((tag) => !suspiciousReason(tag)) : []
      },
      submitter: {
        login: cert.submitterLogin
      },
      publishedAt: cert.publishedAt || cert.updatedAt || cert.createdAt
    }
  };
}

function buildPublicRelayExport(db) {
  const { listPublicRelayCandidates } = require("./db");
  const cases = [];
  const rejected = [];
  for (const cert of listPublicRelayCandidates(db)) {
    const projection = projectPublicCase(cert);
    if (projection.ok) {
      cases.push(projection.case);
    } else {
      rejected.push({ id: cert.id, publicCaseId: cert.publicCaseId, errors: projection.errors });
    }
  }
  if (rejected.length) {
    return { ok: false, rejected };
  }
  return {
    ok: true,
    files: {
      "schema.json": publicSchema(),
      "cases.json": {
        schema: "cold_cases.public_relay_index.v1",
        generatedAt: new Date().toISOString(),
        count: cases.length,
        cases
      },
      "facets.json": buildFacets(cases)
    },
    cases
  };
}

function publicSchema() {
  return {
    schema: PUBLIC_SCHEMA,
    delivery: "static_read_only_public_relay",
    boundary: [
      "sanitized_derivative_not_private_canonical_json",
      "no_private_artifact_uris",
      "no_local_hostnames_or_private_paths",
      "submitter_provided_hashes_not_verified_by_cold_cases",
      "no_public_write_path"
    ],
    fields: [
      "publicCaseId",
      "projectTarget",
      "failureClass",
      "command",
      "metric",
      "failureReason",
      "reviveCondition",
      "provenance",
      "artifact",
      "pipeline",
      "submitter",
      "publishedAt"
    ]
  };
}

function buildFacets(cases) {
  return {
    schema: "cold_cases.public_relay_facets.v1",
    generatedAt: new Date().toISOString(),
    total: cases.length,
    failureClasses: countBy(cases, (item) => item.failureClass, "failureClass"),
    projectNamespaces: countBy(cases, (item) => item.pipeline.projectNamespace, "projectNamespace"),
    artifactKinds: countBy(cases, (item) => item.artifact.kind, "artifactKind"),
    submitters: countBy(cases, (item) => item.submitter.login, "submitterLogin"),
    tags: countBy(cases.flatMap((item) => item.pipeline.tags || []), (item) => item, "tag")
  };
}

function countBy(items, getValue, key) {
  const counts = new Map();
  for (const item of items) {
    const value = getValue(item);
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [key]: value, count }))
    .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));
}

function projectArtifact(cert) {
  const publicUrl = cert.hostedZipUrl && isPublicHttpUrl(cert.hostedZipUrl) ? cert.hostedZipUrl : null;
  if (publicUrl) {
    return {
      kind: cert.artifactKind || "zip",
      label: safeOptional(cert.artifactLabel),
      sizeBytes: cert.artifactSizeBytes ?? null,
      submittedSha256: cert.zipSha256,
      accessMode: "public_url",
      publicUri: publicUrl,
      redactionReason: null
    };
  }

  const reason = cert.artifactUri ? redactionReasonForArtifact(cert.artifactUri) : "no_public_artifact";
  return {
    kind: cert.artifactKind || "zip",
    label: safeOptional(cert.artifactLabel),
    sizeBytes: cert.artifactSizeBytes ?? null,
    submittedSha256: cert.zipSha256,
    accessMode: cert.artifactUri ? "private_reference_redacted" : "contact_submitter",
    publicUri: null,
    redactionReason: reason
  };
}

function publicTextFields(cert) {
  return {
    projectTarget: cert.projectTarget,
    command: cert.command,
    metric: cert.metric,
    failureReason: cert.failureReason,
    reviveCondition: cert.reviveCondition,
    provenance: cert.provenance,
    repoUrl: cert.repoUrl,
    projectNamespace: cert.projectNamespace,
    runId: cert.runId,
    artifactLabel: cert.artifactLabel
  };
}

function suspiciousReason(value) {
  if (!value) return null;
  const text = String(value);
  if (/[\u0000-\u001f\u007f]/.test(text)) return "control characters";
  if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(text)) return "local host reference";
  if (/\b(?:10|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b/.test(text)) return "private ip reference";
  if (/\b169\.254\.\d{1,3}\.\d{1,3}\b/.test(text)) return "link-local ip reference";
  if (/\b[a-z0-9-]+\.ts\.net\b/i.test(text)) return "tailnet hostname";
  if (/\b(?:file|smb|nfs|ssh|rsync):\/\//i.test(text)) return "private artifact protocol";
  if (/(?:^|\s)[A-Za-z]:\\/.test(text) || /\\\\[A-Za-z0-9_.-]+\\/.test(text)) return "private path";
  if (/(?:^|\s)~\/|\/home\/[A-Za-z0-9_.-]+|\/Users\/[A-Za-z0-9_.-]+/.test(text)) return "home path";
  if (/\b(?:bearer|token|api[_-]?key|secret)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}/i.test(text)) return "secret-looking material";
  return null;
}

function redactionReasonForArtifact(value) {
  const text = String(value || "");
  if (/\b[a-z0-9-]+\.ts\.net\b/i.test(text)) return "private_tailnet_reference";
  if (/^smb:\/\//i.test(text)) return "private_smb_reference";
  if (/^nfs:\/\//i.test(text)) return "private_nfs_reference";
  if (/^file:\/\//i.test(text) || /(?:^|\s)~\/|\/home\/[A-Za-z0-9_.-]+|\/Users\/[A-Za-z0-9_.-]+/.test(text)) return "private_path";
  if (/\b(?:10|172\.(?:1[6-9]|2\d|3[0-1])|192\.168)\.\d{1,3}\.\d{1,3}\b/.test(text)) return "private_ip_reference";
  return "private_reference";
}

function isPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !suspiciousReason(`${url.hostname} ${url.pathname}`);
}

function safeOptional(value) {
  if (!value || suspiciousReason(value)) return null;
  return value;
}

function makePublicCaseId(id) {
  return crypto.createHash("sha256").update(`cold-cases-public:${id}`).digest("hex").slice(0, 32);
}

module.exports = {
  PUBLIC_SCHEMA,
  buildPublicRelayExport,
  projectPublicCase,
  publicSchema,
  suspiciousReason
};
