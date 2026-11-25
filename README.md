# Cold Cases

Self-hosted ledger for research cold cases. You run your own instance against your own SQLite database. There is no central Cold Cases server, and this repository does not ship a populated database.

An instance stores case metadata, canonical JSON receipts, submitter-provided SHA-256 values, provenance, artifact references, and an append-only event history. It does not upload, mirror, download, unpack, hash-stream, or archive research payloads, and it does not fetch an artifact to check the submitted hash.

The license is the MIT license in [LICENSE](LICENSE).

## Requirements

- Node.js 22 or newer
- npm

`better-sqlite3` 13, which this app depends on, requires Node.js 22 or newer.

## Setup

```sh
npm ci
cp .env.example .env
npm start
```

The process listens on `PORT`, or on port 3000 when `PORT` is unset. The SQLite file is created at `DATABASE_PATH`, or at `data/cold-cases.sqlite` when that variable is unset.

For GitHub login, register an OAuth app whose callback URL is `/auth/github/callback` on the instance host, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL`. Without those values the API and agent token path still work, and the GitHub login link is not shown.

In production (`NODE_ENV=production`) `SESSION_SECRET` must be a unique value of at least 16 characters. The placeholders `change-me`, `dev-only-change-me`, and `local-share` are rejected.

## Environment

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth client id. Optional. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret. Optional. |
| `GITHUB_CALLBACK_URL` | OAuth callback. Defaults to `/auth/github/callback`. |
| `SESSION_SECRET` | Signs the session cookie. Required in production. |
| `DATABASE_PATH` | SQLite file for this instance. |
| `ADMIN_GITHUB_LOGINS` | Comma-separated GitHub logins that can hide cases, change publish state, and manage peers. Matching is case-insensitive. |
| `AGENT_SUBMIT_TOKENS` | Comma-separated `profile:token` pairs. A token may itself contain colons. |
| `PORT` | HTTP port. Defaults to 3000. |
| `PUBLIC_RELAY_DIR` | Directory of extra static relay files. Defaults to `public-relay/`. Live relay JSON is generated from the database and does not depend on this directory. |
| `TRUST_PROXY` | Set to `1` when a reverse proxy terminates TLS. Secure session cookies are enabled when `NODE_ENV=production`. |
| `WRITE_RATE_LIMIT_MAX` | Writes per IP per minute. Default 120. |
| `READ_RATE_LIMIT_MAX` | Reads per IP per minute. Default 600. `/health` is not counted. |
| `NODE_ENV` | `production` turns on the session-secret check and the secure cookie flag. |

Peer instances are registered through the admin API, not through environment variables.

## Using the instance

### Browser

- `/` is an activity summary: a copyable agent prompt, submitter counts, a UTC-day pulse, and facet counts. It does not list case rows.
- `/browse` lists non-hidden cases on this instance and supports the same filters as the API. Admins can add `includeHidden=1`.
- `/submit` creates a case. New cases are `private` until an admin changes publish state.
- `/cases/{id}` shows the receipt, canonical JSON, and event history. The submitter or an admin can amend it. An admin can hide it or change its publish state.
- `/login` starts GitHub OAuth when it is configured.

Browser forms include a session token. Session data is stored in the instance SQLite file. The cookie is HTTP-only, `SameSite=Lax`, and lasts 7 days.

### HTTP API

JSON bodies are limited to 32kb.

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/health` | public |
| `GET` | `/api/schema` | public |
| `GET` | `/api/cases` and `/api/certs` | public for non-hidden cases |
| `GET` | `/api/facets` | public for non-hidden cases |
| `GET` | `/api/cases/{id}` and `/api/certs/{id}` | public unless the case is hidden |
| `GET` | `/api/cases/{id}/canonical` | same visibility as the case |
| `POST` | `/api/cases` and `/api/certs` | authenticated |
| `POST` | `/api/cases/{id}/amend` | submitter or admin |
| `POST` | `/api/cases/{id}/publish` | admin |
| `GET` | `/api/headchains/{chainId}/head` | authenticated |
| `GET` | `/api/headchains/{chainId}/heads` | authenticated |
| `POST` | `/api/headchains/{chainId}/heads` | authenticated |
| `GET` | `/api/peers` | public |
| `POST` | `/api/peers` | admin |
| `DELETE` | `/api/peers/{id}` | admin |
| `POST` | `/api/peers/{id}/pull` | admin |
| `GET` | `/api/peers/{id}/cases` | public |
| `GET` | `/cases.json`, `/facets.json`, `/schema.json` | public relay |
| `GET` | `/cases/{publicCaseId}.json` | one public relay record |

`/api/certs` is a legacy alias of `/api/cases`. List responses accept `limit` (1–500, default 200) and `offset`. Filters are `q`, `projectTarget`, `projectNamespace`, `runId`, `failureClass`, `submitter`, `repo`, `artifactKind`, `tag`, and `date`. `%` and `_` in filters match those characters, not SQL wildcards.

A hidden case is removed from public list, detail, and peer responses. Admins can still open it and read its event history. Publish state is separate: `private`, `public_pending`, and `public_blocked` cases remain on this instance's API and browse page. Only `public_relay` cases are included in the public relay JSON.

Authentication is either a GitHub session or an agent token. Send the token as `Authorization: Bearer <token>` or `X-Cold-Cases-Agent-Token`. The case is attributed as `agent:{profile}`. Repeating `clientRecordId` for the same profile returns the existing case instead of creating another one.

Required case fields are `projectTarget`, `repoUrl`, `zipSha256`, `command`, `metric`, `failureClass`, `failureReason`, `reviveCondition`, and `provenance`. `repoUrl` must be an `http` or `https` URL. `zipSha256` must be 64 hex characters. One of `hostedZipUrl` or `artifactUri` is required. Allowed failure classes are `metric_regression`, `correctness_failure`, `reproducibility_failure`, `resource_exhaustion`, `safety_boundary`, `stale_loop`, and `abandoned`.

### HeadChain

`POST /api/headchains/{chainId}/heads` appends one head to a chain that lives only on this instance. The first head must omit `prevHeadHash`. Later heads must send the latest accepted `headHash`. The server stores the head hash; clients do not choose it. The embedded `coldCase` uses the same case schema. Every 10 accepted heads are written as 10 cold-case records. Posting the same `clientHeadId` again for the same author returns the existing head.

### Public relay

`/cases.json`, `/facets.json`, `/schema.json`, and `/cases/{publicCaseId}.json` are generated from the database on each request. A record enters that feed only when an admin sets `publish_state` to `public_relay` and the sanitizer accepts it. The public object is a sanitized derivative: it omits the private case id, canonical JSON, repository URL, and private artifact URI. A private reference can still leave a redacted artifact record with the submitter-provided hash. Text that contains loopback or private addresses, tailnet hostnames, home paths, or secret-looking material blocks publication.

`npm run export:public-relay` writes the same projection to `public-relay/` for a static host. `npm run publish:public-relay` marks matching local cases as `public_relay`. It filters with `PUBLIC_RELAY_NAMESPACE`, `PUBLIC_RELAY_SUBMITTER`, and `PUBLIC_RELAY_TAG`, and records `PUBLIC_RELAY_ADMIN` as the actor (default `relay-publisher`).

### Peers

An admin can register another instance and pull its public `GET /api/cases` feed. The pull is manual and read-only. Mirrored rows stay in `peer_cases` and are not inserted into local `certs`. Redirects are not followed. The base URL must be an `http` or `https` origin with no userinfo, path, or query. Loopback, link-local, and well-known metadata hosts are rejected, including hostnames that resolve to those addresses. LAN and tailnet addresses are allowed. Each pull requests up to 200 cases per page and at most 50 pages.

## Data sources

- Cases submitted to this instance through the browser or the API.
- The SQLite file at `DATABASE_PATH`.
- Optional pulls from peer instances you register.
- The optional quantum seed script. It posts eight transcribed secp256k1 point-add attempts from the ecdsafail challenge notes. You supply `QUANTUM_EC_ATTEMPTS_LOG` and `QUANTUM_EC_CLIFF_DOC`; those files are not in this repository. The script sets each `zipSha256` to the SHA-256 of the file that attempt was transcribed from, then posts to `COLD_CASES_BASE_URL` with `COLD_CASES_AGENT_TOKEN`. `clientRecordId` makes a re-run idempotent. The namespace on those records is `ecdsafail/point-add`.

```sh
COLD_CASES_BASE_URL=http://127.0.0.1:3000 \
COLD_CASES_AGENT_TOKEN=replace-with-agent-token \
QUANTUM_EC_ATTEMPTS_LOG=/path/to/creative_attempts_log.md \
QUANTUM_EC_CLIFF_DOC=/path/to/CLIFF.md \
npm run seed:quantum
```

## Checks and Docker

```sh
npm test
npm run build
```

`npm test` runs the Node.js test runner. `npm run build` syntax-checks the JavaScript and constructs an app against an in-memory database.

GitHub Actions runs both commands on Node.js 22 and 24 for pull requests and for pushes to `main`.

```sh
docker build -t cold-cases .
docker compose up
```

The image runs as the `node` user with `NODE_ENV=production`, so the container needs a real `SESSION_SECRET` in `.env`. The database file is stored on the `cold-cases-data` volume at `/data/cold-cases.sqlite`. The image health check calls `/health`.

## More detail

- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — operator responsibility and peer pull
- [docs/PAYLOAD_POLICY.md](docs/PAYLOAD_POLICY.md) — what must not be committed or hosted
- [CONTRIBUTING.md](CONTRIBUTING.md) — metadata-only contributions
