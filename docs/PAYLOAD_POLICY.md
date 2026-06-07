# Payload Policy

Cold Cases v1 records public receipts for failed, abandoned, or paused research attempts. It does not host or verify research payloads.

## Operator responsibility

Cold Cases is self-hosted software, not a hosted service. Each operator runs their own instance and is the sole data controller for it — they own and are responsible for their instance's database, for any peer data they choose to pull, and for complying with whatever rules apply to them. The software is provided **as is, without warranty** (see [LICENSE](../LICENSE)); the authors operate no service and hold no operator or user data. See [SELF_HOSTING.md](SELF_HOSTING.md).

## Boundary

The service must not:

- Upload research payloads.
- Mirror external artifacts.
- Download external artifacts.
- Unpack archives.
- Hash-stream external files.
- Archive payload copies.

The service may record:

- External repository URLs.
- External hosted zip URLs.
- Local, SMB, tailnet, or external artifact references supplied by the submitter.
- Submitter-provided zip SHA256 values.
- Provenance statements.
- Canonical JSON snapshots.
- Append-only create, amend, and hide events.
- Read-only mirrors of the public metadata a trusted peer instance already publishes (never artifacts; kept separate from local records).

## GitHub Use

This private repository may be used to coordinate code changes and metadata review. It should not be used as bulk storage for cold-case artifacts. If a contributor needs to reference payloads, they should provide artifact references and hashes only.

## Review Checklist

- No payload files are added.
- No hidden local state is committed.
- The submitted hash is described as submitter-provided.
- Local or tailnet artifact references are labeled as references, not hosted payloads.
- The cold case stays inspectable through metadata, provenance, event history, and canonical JSON.
