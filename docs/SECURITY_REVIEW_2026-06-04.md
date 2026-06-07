# Security Review - 2026-06-04

## Current Decision

Do not deploy this app publicly to Vercel in its current architecture.

The app uses local SQLite through `better-sqlite3`. Vercel serverless storage is ephemeral, so writes would not have a single durable database across function instances. A Vercel deployment needs a managed database adapter first.

No public deployment can guarantee zero extra cost under arbitrary public traffic. Vercel Hobby generally stops or limits features when included usage is exceeded; Vercel Pro has metered usage and needs Spend Management with production pausing enabled to bound spend risk.

## Immediate Fixes Applied

- Homepage prompt no longer interpolates the request host, so LAN, Tailscale, localhost, custom domain, or port information is not copied into the agent prompt.
- Request body parsing is capped at 32kb for JSON and URL-encoded submissions.
- Production startup now requires an explicit `SESSION_SECRET`.
- Tests now assert that the homepage prompt does not echo request host information.

## Public Hosting Blockers

1. Persistent storage
   - Replace local SQLite with a serverless-compatible database before Vercel.
   - Keep the same metadata-only schema and canonical JSON behavior.

2. Abuse controls
   - Add rate limiting for public read endpoints and authenticated write endpoints.
   - Keep write authentication required for `/api/cases`, `/api/cases/:id/amend`, and hide routes.
   - Consider making `AGENT_SUBMIT_TOKENS` hashed at rest in env configuration notes, not human-readable examples.

3. Sensitive reference policy
   - The service must not publicly expose private LAN, tailnet, file, or host-specific artifact references unless the submitter intentionally marks the case public-safe.
   - Add a public-safe validation mode before production that rejects artifact references matching private IPs, localhost, `file:`, home paths, tailnet-only hostnames, or internal SMB/NFS paths.

4. Cost controls
   - Avoid image optimization, analytics, speed insights, cron, queues, blob, drains, or AI integrations unless explicitly budgeted.
   - Cache public GET endpoints where possible after moving to a shared DB.
   - On Vercel Pro, configure Spend Management to pause production deployments at the chosen cap.

## Safer Vercel Shape

- Static homepage and CSS served by Vercel.
- Serverless API backed by a managed low-cost database.
- Authenticated writes only.
- Public reads return bounded metadata fields only.
- No artifact fetch, upload, mirror, download, unpack, hash-stream, or verification workers.
- Optional deployment protection for preview deployments.

## Still Needs Review Before Public Launch

- CSRF coverage for browser POST routes.
- Rate limiting implementation and tests.
- Public-safe artifact URI validation.
- Production session store or stateless auth design.
- Database adapter migration plan for Vercel.
- Vercel spend cap and project-level feature audit.
