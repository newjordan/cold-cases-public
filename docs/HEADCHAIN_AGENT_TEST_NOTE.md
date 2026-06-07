# HeadChain Agent Test Note

Use this to test the private Cold Cases HeadChain/Worm v1 bridge.

## Boundary

- Private API only.
- Use existing `AGENT_SUBMIT_TOKENS`; requests are attributed as `agent:{profile}`.
- Every head must embed a valid Cold Case payload.
- Artifact references and SHA256 values are submitter-provided metadata only.
- Do not upload, mirror, download, unpack, hash-stream, or verify artifacts.
- No daemon or RobustMQ/mq9 change in v1.

## Start Local Instance

```sh
cd /path/to/cold-cases
mkdir -p data
DATABASE_PATH=./data/headchain-test.sqlite \
SESSION_SECRET=dev-secret \
AGENT_SUBMIT_TOKENS=atlas:replace-with-agent-token \
PORT=3000 \
npm start
```

## Agent Env

```sh
export COLD_CASES_BASE_URL=http://localhost:3000
export COLD_CASES_AGENT_TOKEN=replace-with-agent-token
export CHAIN_ID=agent-smoke
```

## Poll Latest Head

```sh
curl -sS "$COLD_CASES_BASE_URL/api/headchains/$CHAIN_ID/head" \
  -H "Authorization: Bearer $COLD_CASES_AGENT_TOKEN" | jq
```

Empty chain should return `latestSeq: 0`, `latestHash: null`, and `head: null`.

## Submit A Genesis Head

```sh
cat > /tmp/head-001.json <<'JSON'
{
  "schema": "cold_cases.head.v1",
  "clientHeadId": "agent-smoke/head-001",
  "summary": "HeadChain smoke head with metadata-only artifact reference.",
  "coldCase": {
    "projectTarget": "agent-smoke headchain test",
    "repoUrl": "https://github.com/example/research",
    "artifactUri": "local://replace-with-real-reference",
    "zipSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "command": "replace with exact command",
    "metric": "replace with observed metric",
    "failureClass": "abandoned",
    "failureReason": "Smoke record for testing HeadChain dump behavior.",
    "reviveCondition": "Replace with concrete condition before treating as research evidence.",
    "provenance": "Metadata-only HeadChain smoke test; payload not uploaded or verified."
  }
}
JSON

curl -sS "$COLD_CASES_BASE_URL/api/headchains/$CHAIN_ID/heads" \
  -H "Authorization: Bearer $COLD_CASES_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/head-001.json | jq
```

Save the returned `head.headHash`. Use it as `prevHeadHash` for the next head.

## Catch Up

```sh
curl -sS "$COLD_CASES_BASE_URL/api/headchains/$CHAIN_ID/heads?afterSeq=0&limit=50" \
  -H "Authorization: Bearer $COLD_CASES_AGENT_TOKEN" | jq
```

## Expected Behavior

- Genesis omits `prevHeadHash`.
- Non-genesis must include the latest accepted `headHash` as `prevHeadHash`.
- Wrong `prevHeadHash` returns `409` and stores nothing.
- Reposting the same `chainId + agent + clientHeadId` returns the existing head.
- Heads 1-9 create no Cold Case records.
- Head 10 creates exactly 10 Cold Case records and marks all 10 heads with `dumpedAt` and `caseId`.

## Full Verification

```sh
npm test
npm run build
git diff --check
```
