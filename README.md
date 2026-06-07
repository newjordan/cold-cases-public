# Cold Cases

Self-hostable service for direct-published research cold cases. **You run your own instance against your own database and own your own data** — there is no central Cold Cases server. Each instance stores case metadata, canonical JSON receipts, submitter-provided hashes, provenance, non-hosted artifact references, and append-only event history. It does not upload, mirror, download, unpack, hash-stream, or archive research payloads.

Submitted zip SHA256 values are receipt fields supplied by the submitter. An instance records those claims, external links, and local or tailnet artifact references; it does not fetch or verify the referenced artifacts in v1.

Instances are independent. An operator may optionally pull the **public** cases of peer instances they trust, read-only; see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

> **Operator responsibility.** Running an instance makes you its sole operator and data controller. You own and are responsible for your instance's database and for any peer data you choose to pull. The software is provided **as is, without warranty** ([LICENSE](LICENSE)); the authors run no service and hold no operator or user data. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Run your own instance

```sh
npm install
cp .env.example .env
npm start
```

Required environment:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`
- `DATABASE_PATH`
- `ADMIN_GITHUB_LOGINS`
- `AGENT_SUBMIT_TOKENS` for agent profiles, formatted as `profile:token,other-profile:other-token`

For GitHub OAuth, set the callback URL to `/auth/github/callback` on your instance's host. Each operator sets their own secrets, admin logins, and `DATABASE_PATH`; nothing is shared between instances.

## Local share site

To start a shareable local site from the real `quantum_ec` cold-case evidence on
this machine:

```sh
npm install
DATABASE_PATH=./data/cold-cases-share.sqlite PORT=3001 \
  SESSION_SECRET=local-share AGENT_SUBMIT_TOKENS=quantum:replace-with-agent-token npm start

COLD_CASES_BASE_URL=http://127.0.0.1:3001 COLD_CASES_AGENT_TOKEN=replace-with-agent-token \
  QUANTUM_EC_ATTEMPTS_LOG=/path/to/creative_attempts_log.md \
  QUANTUM_EC_CLIFF_DOC=/path/to/CLIFF.md \
  QUANTUM_EC_OPS_BIN=/path/to/ops.bin \
  npm run seed:quantum

DATABASE_PATH=./data/cold-cases-share.sqlite \
  PUBLIC_RELAY_NAMESPACE=ecdsafail/point-add npm run publish:public-relay

DATABASE_PATH=./data/cold-cases-share.sqlite npm run export:public-relay
```

Open `http://127.0.0.1:3001/` or the machine's Tailscale URL. The public relay
JSON is served at
`/cases.json`, `/facets.json`, `/schema.json`, and `/cases/{publicCaseId}.json`.

## Test and build

```sh
npm test
npm run build
docker build -t cold-cases .
```

## Contributions

This private repository can coordinate cold-case intake and pull requests, but it is not an artifact host. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/PAYLOAD_POLICY.md](docs/PAYLOAD_POLICY.md) before opening issues or pull requests.

For the optional ECDSF research-group fork/mod architecture, see [docs/ECDSF_COLD_CASES_MOD.md](docs/ECDSF_COLD_CASES_MOD.md). That mod is an add-on distribution for group-specific manifests, validation, and submission helpers; it is not an upstream PR path and not a payload host.

Agents can attach the repo-local skill at [.codex/skills/cold-case-dump/SKILL.md](.codex/skills/cold-case-dump/SKILL.md). Token-authenticated API submissions are attributed as `agent:{profile}` from `AGENT_SUBMIT_TOKENS`.

For volume, agents should provide `clientRecordId`, `projectNamespace`, `runId`, and `tags`. `clientRecordId` makes repeated submissions idempotent per agent profile; `/api/cases` returns pagination metadata, and `/api/facets` returns group counts for efficient discovery.

The same token path supports per-instance HeadChain coordination at `/api/headchains/{chainId}/head` and `/api/headchains/{chainId}/heads`. HeadChain heads embed valid Cold Case payloads, enforce linear `prevHeadHash` sync, and dump every 10 accepted heads into 10 Cold Case records. A HeadChain lives inside the single instance it is posted to, not across a network. See [.codex/skills/cold-case-dump/references/headchain.md](.codex/skills/cold-case-dump/references/headchain.md).

## Federation (read-only peer pull)

An instance can pull the **public** cases of peer instances its operator trusts. Pulls are read-only, metadata-only, and manual; mirrored rows live in `peer_cases` and are never merged into local `certs`. Manage peers via `GET/POST /api/peers`, `DELETE /api/peers/{id}`, `POST /api/peers/{id}/pull`, and `GET /api/peers/{id}/cases`. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Data model

- `certs` is the current public/indexable projection for cold cases this instance owns.
- `cert_versions` stores immutable canonical JSON snapshots for create, amend, and hide actions.
- `cert_events` stores create, amend, and hide events.
- `headchains` stores per-instance latest-head projections for compact agent sync.
- `headchain_heads` stores the accepted-head worm, embedded Cold Case payloads, dump status, and linked case IDs.
- `peers` stores trusted peer instances and last-pull status; `peer_cases` stores read-only mirrored metadata pulled from those peers, kept separate from `certs`.

Hidden cold cases are removed from public index and public detail responses. Admins listed in `ADMIN_GITHUB_LOGINS` can still view their detail pages and audit history.
