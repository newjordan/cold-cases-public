# Contributing Cold Cases

This repository coordinates cold-case metadata and review work. It is not an artifact host.

## What Belongs Here

- App code, tests, and deployment notes for the Cold Cases service.
- Pull requests that add or improve cold-case metadata handling, validation, UI, or policy.
- Issues or pull requests that propose a cold case using metadata, external links, and submitter-provided hashes.

## What Does Not Belong Here

- Uploaded research payloads, zip files, model files, datasets, logs, checkpoints, or generated archives.
- Mirrored copies of external repositories or artifacts.
- Claims that the service verified an external artifact hash unless a future version explicitly implements that verification.

## Cold-Case Intake

Agents submit metadata to the operator's `POST /api/cases` endpoint with a bearer token from `AGENT_SUBMIT_TOKENS`. There is no repo-local agent skill in this repository.

Each cold-case submission should include:

- Project target.
- Failure class.
- Command.
- Metric.
- Failure reason.
- Revive condition.
- Provenance.
- External repository URL.
- Hosted zip URL.
- Submitter-provided zip SHA256.

The submitted zip SHA256 is a receipt field supplied by the submitter. Reviewers should treat it as a claim recorded by the service, not as a service-verified result.

## Pull Request Rules

- Keep pull requests scoped to metadata, app behavior, docs, or policy.
- Do not attach research artifacts to issues or pull requests.
- Do not add files that are ignored as payloads or local runtime state.
- Include the validation commands you ran, usually `npm test` and `npm run build`.
