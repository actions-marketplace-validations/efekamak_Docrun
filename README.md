# docrun

Execute declared Node/npm quickstart contracts (`docrun.json`) in a fresh temporary workspace, publish live verification checks, and turn failures into evidence-backed maintainer reports using Cursor's Agent SDK (`@grok/agent-sdk`).

**Live quickstart checks:** [efekamak.github.io/Docrun](https://efekamak.github.io/Docrun/)

## 1. What problem does this solve?

Unit tests often pass in a maintainer's repository while the published quickstart fails for a new user:

- an outdated package version or import path in the README;
- a missing export or broken entrypoint in the published package;
- a command that exits `0` but no longer produces the documented output or file.

`docrun` runs a small declared install path from a fresh temporary workspace, stops at the first failing step, captures bounded and redacted evidence, and lets an Agent SDK agent produce a short maintainer report from that evidence.

## 2. Live quickstart catalog

`catalog/targets.json` declares 5 real AI/TypeScript SDK install paths tested daily on an ephemeral GitHub-hosted runner with no repository secrets:

- **Cursor Agent SDK** (`@grok/agent-sdk`): install + validate a minimal local agent
- **Anthropic TypeScript SDK** (`@anthropic-ai/sdk`): install + import + client instantiation
- **OpenAI JavaScript SDK** (`openai`): install + import + client instantiation
- **MCP TypeScript SDK** (`@modelcontextprotocol/sdk`): install + import + `McpServer` registration
- **Vercel AI SDK** (`ai`): install + import + core API exports

Each row on the status page reports only what its declared contract ran, not full SDK health or paid API calls.

## 3. Run locally

Requirements: Node.js 20+ and npm.

```bash
npm ci
npm run check
npm test
npm run validate
npm run catalog:validate
```

Run the live catalog and build the static status site locally:

```bash
npm run catalog:run
npm run site:build
# Output written to dist-site/
```

Call the deterministic runner tool directly (no Cursor API key required):

```bash
# Passing fixture
npx --yes "@grok/agent-sdk@0.7.2" tool call run_quickstart --dir . \
  --input '{"contractPath":"fixtures/passing/docrun.json"}'

# Failing fixture
npx --yes "@grok/agent-sdk@0.7.2" tool call run_quickstart --dir . \
  --input '{"contractPath":"fixtures/failing/docrun.json"}'
```

Run a full agent turn or open the local playground (requires `agent-sdk login` or `CURSOR_API_KEY`):

```bash
npx --yes "@grok/agent-sdk@0.7.2" run --dir . \
  --message "Run the quickstart at fixtures/failing/docrun.json and write a maintainer report."

npx --yes "@grok/agent-sdk@0.7.2" dev .
# Open http://127.0.0.1:3000/playground
```

Run evals:

```bash
npx --yes "@grok/agent-sdk@0.7.2" eval --dir . --list
npx --yes "@grok/agent-sdk@0.7.2" eval --dir .
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
- Catalog contracts additionally restrict `npm` subcommands to `install`, `list`, and `exec`.
- File paths must stay inside the temporary workspace (`..`, absolute paths, drive prefixes, Windows reserved names, and null bytes are rejected).
- Environment variables and secrets are not accepted in contracts.
- Optional `readmePath` checks a marked `<!-- docrun:start --> ... <!-- docrun:end -->` block for command drift.

## 5. Safety limitations

- **Not a security sandbox.** `npm install` can run package lifecycle scripts as the current OS user. A fresh temporary directory isolates files and `npm_config_cache` from your repository, not from the host OS.
- Scheduled status checks run on ephemeral GitHub-hosted runners with `contents: read` and zero repository secrets; pull-request CI never executes third-party catalog contracts.
- Output is bounded, stripped of ANSI codes, scrubbed of local temp/user paths, and redacted for common token patterns before publishing or passing to the model.

## 6. How Cursor Agent SDK participates

- **Server tool (`bot/tools/run_quickstart.ts`):** Typed Zod input, `effect: "write"`, `dryRunResult`, callable via `agent-sdk tool call` without a model turn.
- **Structured artifacts (`bot/artifacts.ts`):** Persists `quickstart-run` (host-tagged deterministic JSON) and `quickstart-report` (model-tagged summary with failure category and fingerprint).
- **Evals (`evals/docrun.eval.ts`):** Verifies passing, assertion failure, timeout, credential redaction, and prompt-injection resistance.

## License

MIT
