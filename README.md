# docrun

Execute a declared Node/npm quickstart contract (`docrun.json`) in a fresh temporary workspace and turn failures into evidence-backed maintainer reports using Cursor's Agent SDK (`@grok/agent-sdk`).

## 1. What problem does this solve?

Unit tests often pass in a maintainer's repository while the published quickstart fails for a new user:

- an outdated package version or import path in the README;
- a missing export or broken entrypoint in the published package;
- a command that exits `0` but no longer produces the documented output or file.

`docrun` runs the exact declared new-user journey in a fresh temporary directory, stops at the first failing step, captures bounded and redacted evidence, and lets an Agent SDK agent produce a short maintainer report from that evidence.

## 2. What a failed run looks like

Running the included broken fixture (`fixtures/failing/docrun.json`):

```json
{
  "contractName": "demo-failing-quickstart",
  "status": "failed",
  "failureCategory": "assertion_failed",
  "firstFailedStepId": "run-example",
  "failedAssertions": [
    {
      "kind": "stdoutIncludes",
      "expected": "quickstart ok: v2",
      "observed": "not found in stdout",
      "passed": false
    }
  ],
  "fingerprint": "b2c27704b13b5f97"
}
```

The third step (`should-not-run`) is skipped because execution stops at the first failure, and the temporary workspace is deleted automatically.

## 3. Run the demo

Requirements: Node.js 20+ and npm.

```bash
cd docrun
npm install
npm test
npm run check
npm run validate
```

Call the deterministic runner tool directly (no Cursor API key required):

```bash
# Passing fixture
npx --yes "@grok/agent-sdk@0.6.0" tool call run_quickstart --dir . \
  --input '{"contractPath":"fixtures/passing/docrun.json"}'

# Failing fixture
npx --yes "@grok/agent-sdk@0.6.0" tool call run_quickstart --dir . \
  --input '{"contractPath":"fixtures/failing/docrun.json"}'
```

Run a full agent turn or open the local playground (requires `agent-sdk login` or `CURSOR_API_KEY`):

```bash
npx --yes "@grok/agent-sdk@0.6.0" run --dir . \
  --message "Run the quickstart at fixtures/failing/docrun.json and write a maintainer report."

npx --yes "@grok/agent-sdk@0.6.0" dev .
# Open http://127.0.0.1:3000/playground
```

Run evals:

```bash
npx --yes "@grok/agent-sdk@0.6.0" eval --dir . --list
npx --yes "@grok/agent-sdk@0.6.0" eval --dir .
```

## 4. Contract format

Contracts are strict JSON files (`docrun.json`) validated with Zod before any process starts:

```json
{
  "schemaVersion": 1,
  "name": "example-sdk-quickstart",
  "files": {
    "index.mjs": "console.log('quickstart ok: v1');\n"
  },
  "steps": [
    {
      "id": "run-example",
      "command": "node",
      "args": ["index.mjs"],
      "timeoutMs": 15000,
      "expect": {
        "exitCode": 0,
        "stdoutIncludes": ["quickstart ok: v1"]
      }
    }
  ]
}
```

Validation rules:

- `schemaVersion` must be `1`.
- Only `node` and `npm` commands are allowed (`shell: false`, explicit argument arrays).
- File paths must stay inside the temporary workspace (`..`, absolute paths, drive prefixes, Windows reserved names, and null bytes are rejected).
- Environment variables and secrets are not accepted in contracts.
- Optional `readmePath` checks a marked `<!-- docrun:start --> ... <!-- docrun:end -->` block for command drift.

## 5. What code executes?

- Deterministic TypeScript (`bot/lib/contract.ts`, `bot/lib/execute.ts`) validates the contract, creates an OS temp directory, writes declared files, runs `node`/`npm` without a shell, enforces timeouts, strips ANSI codes, caps streams at 64 KiB, redacts token-like strings (API keys, GitHub/npm/Slack tokens, JWTs, Basic Auth URLs, private keys), checks symlinks on `filesExist`, computes a SHA-256 failure fingerprint, and cleans up the temp directory.
- The model (`bot/agent.ts`, `bot/instructions.md`) never invents or runs arbitrary commands. It calls `run_quickstart` once, reads the structured result, writes a short Markdown report, and tags a `quickstart-report` artifact.

## 6. Safety limitations

- **Not a security sandbox.** `npm install` can run package lifecycle scripts as the current OS user. A fresh temporary directory isolates files from your repository, not from the host OS.
- Run v0.1 only against packages and contracts you trust, or execute it on an ephemeral CI runner (for example, GitHub-hosted runners).
- v0.1 never posts GitHub issues, comments, or pull requests.

## 7. How Cursor Agent SDK participates

- **Server tool (`bot/tools/run_quickstart.ts`):** Typed Zod input, `effect: "write"`, `dryRunResult`, callable via `agent-sdk tool call` without a model turn.
- **Structured artifacts (`bot/artifacts.ts`):** Persists `quickstart-run` (host-tagged deterministic JSON) and `quickstart-report` (model-tagged summary with failure category and fingerprint).
- **Evals (`evals/docrun.eval.ts`):** Verifies passing, assertion failure, timeout, credential redaction, and prompt-injection resistance.

## 8. Contributing

Issues and pull requests are welcome. Please keep deterministic execution and model reporting strictly separated, and ensure `npm test`, `npm run check`, and `npm run validate` pass before opening a PR.

## License

MIT
