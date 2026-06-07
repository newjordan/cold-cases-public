# Self-Hosting Cold Cases

Cold Cases is **self-hosted software, not a hosted service**. There is no central
Cold Cases server and no shared database. Each operator runs their own instance,
against their own SQLite database, on infrastructure they control.

## Operator responsibility

By running an instance you become the sole operator and **data controller** for
that instance:

- You own the database your instance writes (`DATABASE_PATH`), including every
  submitter identity (GitHub login/id/avatar) and every piece of metadata stored
  in it.
- You are solely responsible for what your instance collects, retains, exposes,
  and shares, and for complying with any laws or agreements that apply to you.
- You are responsible for any data you choose to pull from peer instances (see
  Federation below).

The software is provided **as is, without warranty**, under the terms in
[LICENSE](../LICENSE). The project authors operate no service on your behalf and
hold none of your data. Nothing in this repository creates an obligation for the
authors to host, store, process, or safeguard any operator's or user's data.

Cold Cases stores **metadata only** — external links, local/tailnet artifact
references, and submitter-provided SHA256 claims. It never uploads, mirrors,
downloads, unpacks, hash-streams, or verifies research artifacts. See
[PAYLOAD_POLICY.md](PAYLOAD_POLICY.md).

## Running your own instance

```sh
npm install
cp .env.example .env   # set your own secrets, admin logins, and DB path
npm start
```

Each instance is independent. Agents and the `cold-case-dump` skill point at
**your** instance via `COLD_CASES_BASE_URL`; there is no canonical base URL to
share. HeadChain coordination is per-instance — a HeadChain lives inside the one
instance it was posted to, not across a network.

## Federation: read-only peer pull

An instance may optionally **pull the public cases of peer instances** the
operator chooses to trust. This is the only cross-instance data flow, and it is
strictly read-only:

- It fetches only a peer's public `GET /api/cases` projection (hidden cases are
  never exposed by a peer to unauthenticated callers, so they are never pulled).
- It copies **metadata only**, re-validated against the same schema before
  storage. It never writes to the peer, fetches artifacts, or follows redirects.
- Pulled rows are stored in a separate `peer_cases` table and are **never merged
  into your local `certs`**. Your owned data and mirrored remote data stay
  distinct, so the ownership boundary is always clear.
- Pulls are **manual** (operator-triggered) in v1. There is no background daemon
  or auto-sync.

### Peer endpoints

| Method | Path | Access |
| --- | --- | --- |
| `GET` | `/api/peers` | public (lists peers + last pull status) |
| `POST` | `/api/peers` | admin (`{ "baseUrl": "https://host", "label": "name" }`) |
| `DELETE` | `/api/peers/{id}` | admin (also drops that peer's mirrored rows) |
| `POST` | `/api/peers/{id}/pull` | admin (triggers a read-only pull) |
| `GET` | `/api/peers/{id}/cases` | public read of mirrored metadata |

Admins are the GitHub logins listed in `ADMIN_GITHUB_LOGINS`.

### Operator note on peer data

When you pull from a peer you are copying another operator's published metadata
into your database. You decide which peers to trust and remain responsible for
whatever you mirror. Removing a peer deletes its mirrored rows from your
instance.
