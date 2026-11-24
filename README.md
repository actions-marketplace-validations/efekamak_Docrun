# docrun

[![docrun live status](https://img.shields.io/endpoint?url=https%3A%2F%2Fefekamak.github.io%2FDocrun%2Fbadges%2Foverall.json)](https://efekamak.github.io/Docrun/)

Execute declared Node/npm and Python/pip/uv quickstart contracts (`docrun.json`) in fresh temporary workspaces on Ubuntu and Windows, publish live cross-platform verification results, and turn failures into evidence-backed maintainer reports using Cursor's Agent SDK (`@grok/agent-sdk`).

**Live quickstart checks:** [efekamak.github.io/Docrun](https://efekamak.github.io/Docrun/)

## Use in your repository

Run your own `docrun.json` quickstart contract in GitHub Actions without any extra install step, model key, or setup action:

```yaml
name: Quickstart check

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  quickstart:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: efekamak/Docrun@v0.4.3
        with:
          contract: docrun.json
```

Pin to an exact release tag (`@v0.4.3`) or a full commit SHA for stricter supply-chain control. Do not pin to `@main`.

### Action inputs

| Input | Default | Description |
| --- | --- | --- |
| `contract` | `docrun.json` | Relative path to the contract inside `working-directory`. |
| `working-directory` | `.` | Relative directory inside `GITHUB_WORKSPACE` (useful for monorepos). |

### Action outputs

| Output | Description |
| --- | --- |
| `status` | `passed`, `failed`, `invalid`, or `error`. |
| `failure-category` | Failure category on non-passing runs; empty when passed. |
| `first-failed-step` | ID of the first failed step; empty if none. |
| `fingerprint` | Stable failure fingerprint; empty when passed. |
| `duration-ms` | Total run duration in milliseconds. |
| `result-path` | Path under `RUNNER_TEMP` to the sanitized JSON run result. |

Contract steps support allowlisted `node`, `npm`, `python`, `pip`, and `uv` commands. Steps run with the binaries on the runner `PATH` (add `actions/setup-node` or `actions/setup-python` before this action to pick a specific version). Contracts that use `python` or `pip` automatically run inside an isolated temporary `.venv` created per run so packages never pollute the runner or hit PEP 668 externally-managed-environment errors.

On `failed` or `invalid` runs, the action writes the sanitized JSON result file, sets all outputs, and posts a bounded HTML summary to the GitHub Step Summary before failing the step. Downstream steps with `if: always()` can still read the outputs and `result-path`.

The action wrapper itself makes no network requests, strips runner secrets (`GITHUB_TOKEN`, OIDC, and API keys) from child processes, and runs only allowlisted `node`/`npm`/`python`/`pip`/`uv` commands with `shell: false`. Contracts that run `npm install` or `pip install` still talk to package registries and can run package install/lifecycle scripts as the GitHub runner user (not a security sandbox).

## 1. What problem does this solve?

Unit tests often pass in a maintainer's repository while the published quickstart fails for a new user on Linux or Windows:

- an outdated package version or import path in the README;
- a missing export, CLI spawn failure, or broken entrypoint in the published package;
- a command that exits `0` but no longer produces the documented output or file.

`docrun` runs a small declared install path from a fresh temporary workspace, stops at the first failing step, captures bounded and redacted evidence, and lets an Agent SDK agent produce a short maintainer report from that evidence.

## 2. Live quickstart catalog

`catalog/targets.json` declares 20 real JS/TS and Python SDK install paths tested daily on ephemeral Ubuntu and Windows GitHub-hosted runners (Node.js 24, Python 3.12) with no repository secrets:

- **Cursor Agent SDK** (`@grok/agent-sdk`): install + scaffold a local agent + validate
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): install + import + `createSdkMcpServer` tool registration
- **OpenAI Agents SDK** (`@openai/agents`): install + import + `Agent` and tool construction
- **OpenAI Codex SDK** (`@openai/codex-sdk`): install + import + `Codex` thread initialization
- **Google ADK (TypeScript)** (`@google/adk`): install + import + `LlmAgent` construction
- **LangGraph JS** (`@langchain/langgraph`): install + compile and invoke local `StateGraph`
- **Mastra** (`@mastra/core`): install + import + `Mastra` and `Agent` registration
- **Anthropic TypeScript SDK** (`@anthropic-ai/sdk`): install + import + client instantiation
- **OpenAI JavaScript SDK** (`openai`): install + import + client instantiation
- **MCP TypeScript SDK** (`@modelcontextprotocol/sdk`): install + import + `McpServer` registration
- **Vercel AI SDK** (`ai`): install + import + core API exports
- **Google Gen AI SDK** (`@google/genai`): install + import + local client construction
- **LangChain JS** (`langchain`): install + import + local `HumanMessage` primitive
- **Supabase JS** (`@supabase/supabase-js`): install + import + local client with background auth disabled
- **Stripe Node SDK** (`stripe`): install + import + local client construction
- **Resend Node SDK** (`resend`): install + import + local client construction
- **Claude Agent SDK (Python)** (`claude-agent-sdk`): pip install + import + `ClaudeAgentOptions` construction
- **OpenAI Agents SDK (Python)** (`openai-agents`): pip install + import + `Agent` construction
- **OpenAI Python SDK** (`openai`): pip install + import + local client construction
- **Anthropic Python SDK** (`anthropic`): pip install + import + local client construction

Each row on the status page reports only what its declared contract ran on the recorded Ubuntu and Windows runners, not full SDK health, paid API calls, or uptime/SLA.

Published static data on GitHub Pages:

- `status.json`: schema v2 aggregate document with per-platform results, exact installed versions, OS/Node/npm metadata, version drift flags, and redacted step evidence.
- `history.json`: best-effort 7-day UTC snapshot history (compact statuses and resolved versions only, no stdout/stderr).
- `badges/overall.json` and `badges/<target-id>-<ubuntu|windows>.json`: Shields endpoint JSON files.

## 3. Run locally

Requirements: Node.js 22.13+ (Node.js 24 used in CI and live checks) and npm.

```bash
npm ci
npm run check
node --check site/app.js
npm test
npm run validate
npm run catalog:validate
```

Run the live catalog for the current OS, aggregate results, and build the static status site locally:

```bash
# Runs the 20 contracts on the current host OS (writes generated/platform-<os>.json)
npm run catalog:run

# Combine platform partial artifacts into generated/status.json, history.json, and badges/
npm run status:aggregate -- --windows=generated/platform-windows.json --no-history-fetch

# Validate schema v2 output and build dist-site/
npm run site:build
```

Call the deterministic runner tool directly (no Cursor API key required):

```bash
# Passing fixture
npx --no-install agent-sdk tool call run_quickstart --dir . \
  --input '{"contractPath":"fixtures/passing/docrun.json"}'

# Failing fixture
npx --no-install agent-sdk tool call run_quickstart --dir . \
  --input '{"contractPath":"fixtures/failing/docrun.json"}'
```

Run a full agent turn or open the local playground (requires `agent-sdk login` or `CURSOR_API_KEY`):

```bash
npx --no-install agent-sdk run --dir . \
  --message "Run the quickstart at fixtures/failing/docrun.json and write a maintainer report."

npx --no-install agent-sdk dev .
# Open http://127.0.0.1:3000/playground
```

Run evals:

```bash
npx --no-install agent-sdk eval --dir . --list
npx --no-install agent-sdk eval --dir .
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
- Only `node`, `npm`, `python`, `pip`, and `uv` commands are allowed (`shell: false`, explicit argument arrays).
- Catalog contracts additionally restrict subcommands (`npm`: `install`/`list`/`exec`; `pip`: `install`/`list`/`show`; `uv`: `pip`/`venv`/`run`/`sync`/`add`/`--version`).
- File paths must stay inside the temporary workspace (`..`, absolute paths, drive prefixes, Windows reserved names, and null bytes are rejected).
- Environment variables and secrets are not accepted in contracts.
- Optional `readmePath` checks a marked `<!-- docrun:start --> ... <!-- docrun:end -->` block for command drift.

## 5. Safety limitations

- **Not a security sandbox.** `npm install` can run package lifecycle scripts as the current OS user. A fresh temporary directory isolates files, `npm_config_cache`, and `npm_config_userconfig` from your repository, not from the host OS.
- Scheduled status checks run on ephemeral GitHub-hosted Ubuntu and Windows runners with `contents: read`, `persist-credentials: false`, SHA-pinned actions, and zero repository secrets. Pull-request CI validates schemas and runs local fixtures only; it never executes third-party catalog contracts.
- Output is bounded, stripped of ANSI codes, scrubbed of local temp/user paths, and redacted for common token patterns before publishing or passing to the model.

## 6. How Cursor Agent SDK participates

- **Server tool (`bot/tools/run_quickstart.ts`):** Typed Zod input, `effect: "write"`, `dryRunResult`, callable via `agent-sdk tool call` without a model turn.
- **Structured artifacts (`bot/artifacts.ts`):** Persists `quickstart-run` (host-tagged deterministic JSON) and `quickstart-report` (model-tagged summary with failure category and fingerprint).
- **Evals (`evals/docrun.eval.ts`):** Verifies passing, assertion failure, timeout, credential redaction, and prompt-injection resistance.

## License

MIT
