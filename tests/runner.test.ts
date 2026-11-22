import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  checkReadmeDrift,
  isSafeRelativePath,
  loadContractFile,
  validateContract,
  type QuickstartContract,
} from "../bot/lib/contract.js";
import {
  boundOutput,
  computeFailureFingerprint,
  redactSecrets,
  resolveToolchain,
  runQuickstartContract,
} from "../bot/lib/execute.js";

const REPO_ROOT = process.cwd();

describe("contract validation", () => {
  it("accepts a valid contract", () => {
    const res = validateContract({
      schemaVersion: 1,
      name: "valid-sdk",
      files: {
        "index.mjs": "console.log('ok');",
      },
      steps: [
        {
          id: "run",
          command: "node",
          args: ["index.mjs"],
          timeoutMs: 10_000,
          expect: { exitCode: 0, stdoutIncludes: ["ok"] },
        },
      ],
    });
    assert.equal(res.ok, true);
  });

  it("rejects unsupported schema versions", () => {
    const res = validateContract({
      schemaVersion: 2,
      name: "bad-version",
      steps: [
        {
          id: "run",
          command: "node",
          args: ["-v"],
          timeoutMs: 5000,
          expect: { exitCode: 0 },
        },
      ],
    });
    assert.equal(res.ok, false);
  });

  it("rejects duplicate step IDs", () => {
    const res = validateContract({
      schemaVersion: 1,
      name: "dup-steps",
      steps: [
        { id: "step-a", command: "node", args: ["-v"], timeoutMs: 5000, expect: { exitCode: 0 } },
        { id: "step-a", command: "node", args: ["-v"], timeoutMs: 5000, expect: { exitCode: 0 } },
      ],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.errors.join("\n"), /Duplicate step id/);
    }
  });

  it("rejects absolute, traversal, drive-prefixed, reserved Windows, and null-byte file paths", () => {
    assert.equal(isSafeRelativePath("src/index.mjs"), true);
    assert.equal(isSafeRelativePath("../escape.mjs"), false);
    assert.equal(isSafeRelativePath("a/../../escape.mjs"), false);
    assert.equal(isSafeRelativePath("/etc/passwd"), false);
    assert.equal(isSafeRelativePath("C:\\Windows\\win.ini"), false);
    assert.equal(isSafeRelativePath("foo\0bar.mjs"), false);
    assert.equal(isSafeRelativePath("CON"), false);
    assert.equal(isSafeRelativePath("sub/NUL.txt"), false);
    assert.equal(isSafeRelativePath("trailing-dot."), false);

    const res = validateContract({
      schemaVersion: 1,
      name: "unsafe-path",
      files: { "../escape.mjs": "bad" },
      steps: [{ id: "run", command: "node", args: ["-v"], timeoutMs: 5000, expect: { exitCode: 0 } }],
    });
    assert.equal(res.ok, false);
  });

  it("rejects unsupported commands and disallowed env fields", () => {
    const badCmd = validateContract({
      schemaVersion: 1,
      name: "bad-cmd",
      steps: [{ id: "run", command: "bash", args: ["-c", "echo hi"], timeoutMs: 5000, expect: { exitCode: 0 } }],
    });
    assert.equal(badCmd.ok, false);

    const withEnv = validateContract({
      schemaVersion: 1,
      name: "with-env",
      env: { SECRET: "123" },
      steps: [{ id: "run", command: "node", args: ["-v"], timeoutMs: 5000, expect: { exitCode: 0 } }],
    });
    assert.equal(withEnv.ok, false);
  });

  it("rejects oversized contract files before parsing", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-size-test-"));
    try {
      await fs.writeFile(path.join(tmpBase, "huge.json"), " ".repeat(600_000), "utf8");
      const res = await loadContractFile(tmpBase, "huge.json");
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.match(res.errors[0], /exceeds/);
      }
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("deterministic runner", () => {
  it("passes the passing fixture and cleans up the temporary workspace", async () => {
    const loaded = await loadContractFile(REPO_ROOT, "fixtures/passing/docrun.json");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const result = await runQuickstartContract(loaded.contract);
    assert.equal(result.status, "passed");
    assert.equal(result.failureCategory, null);
    assert.equal(result.firstFailedStepId, null);
    assert.equal(result.steps.length, 2);
    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.succeeded, true);
    assert.equal(result.workspacePreserved, false);
    assert.equal(result.fingerprint, null);
  });

  it("captures the first failing step, classifies assertion_failed, and stops remaining steps", async () => {
    const loaded = await loadContractFile(REPO_ROOT, "fixtures/failing/docrun.json");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const result = await runQuickstartContract(loaded.contract);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "assertion_failed");
    assert.equal(result.firstFailedStepId, "run-example");
    assert.equal(result.steps.length, 2); // third step ("should-not-run") must not execute
    assert.equal(result.failedAssertions.length, 1);
    assert.equal(result.failedAssertions[0].kind, "stdoutIncludes");
    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.succeeded, true);
    assert.ok(result.fingerprint && result.fingerprint.length === 16);
  });

  it("distinguishes runtime command failure from assertion failure", async () => {
    const contract: QuickstartContract = {
      schemaVersion: 1,
      name: "runtime-crash",
      files: { "crash.mjs": "console.error('boom'); process.exit(2);\n" },
      steps: [
        {
          id: "crash",
          command: "node",
          args: ["crash.mjs"],
          timeoutMs: 10_000,
          expect: { exitCode: 0 },
        },
      ],
    };
    const result = await runQuickstartContract(contract);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "runtime_failed");
    assert.equal(result.steps[0].exitCode, 2);
  });

  it("executes npm without a shell cleanly on this platform", async () => {
    const contract: QuickstartContract = {
      schemaVersion: 1,
      name: "npm-version-check",
      files: {},
      steps: [
        {
          id: "check-npm",
          command: "npm",
          args: ["--version"],
          timeoutMs: 15_000,
          expect: { exitCode: 0 },
        },
      ],
    };
    const result = await runQuickstartContract(contract);
    assert.equal(result.status, "passed");
    assert.match(result.steps[0].stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("enforces per-step timeout and cleans up workspace", async () => {
    const loaded = await loadContractFile(REPO_ROOT, "fixtures/timeout/docrun.json");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const result = await runQuickstartContract(loaded.contract);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "timed_out");
    assert.equal(result.firstFailedStepId, "hang-step");
    assert.equal(result.steps[0].timedOut, true);
    assert.equal(result.cleanup.attempted, true);
    assert.equal(result.cleanup.succeeded, true);
  });

  it("redacts token-like values in captured output", async () => {
    const loaded = await loadContractFile(REPO_ROOT, "fixtures/redaction/docrun.json");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const result = await runQuickstartContract(loaded.contract);
    assert.equal(result.status, "failed");
    const stderr = result.steps[0].stderr;
    assert.doesNotMatch(stderr, /supersecrettoken1234567890/);
    assert.doesNotMatch(stderr, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/);
    assert.doesNotMatch(stderr, /sk-ant-1234567890abcdef123456/);
    assert.match(stderr, /\[REDACTED/);

    const direct = redactSecrets(
      "api_key=my_very_secret_key_999 https://alice:superpass@example.com/repo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789",
    );
    assert.doesNotMatch(direct, /my_very_secret_key_999/);
    assert.doesNotMatch(direct, /superpass/);
    assert.doesNotMatch(direct, /eyJhbGciOiJIUzI1NiJ9/);
    assert.match(direct, /https:\/\/alice:\[REDACTED\]@example\.com\/repo/);
    assert.match(direct, /\[REDACTED_JWT\]/);
  });

  it("truncates large output while preserving head, tail, and valid UTF-8 boundaries", () => {
    const big = "HEAD_ğüşıöç_" + "🚀".repeat(1200) + "_ğüşıöç_TAIL";
    const bounded = boundOutput(big, 512);
    assert.equal(bounded.truncated, true);
    assert.match(bounded.text, /HEAD_ğüşıöç_/);
    assert.match(bounded.text, /_ğüşıöç_TAIL/);
    assert.match(bounded.text, /truncated \d+ bytes/);
    assert.equal(bounded.text.includes("\uFFFD"), false);
  });

  it("preserves temporary workspace only when preserveWorkspace is true", async () => {
    const loaded = await loadContractFile(REPO_ROOT, "fixtures/passing/docrun.json");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const result = await runQuickstartContract(loaded.contract, { preserveWorkspace: true });
    assert.equal(result.workspacePreserved, true);
    assert.ok(result.preservedWorkspaceDir);
    assert.equal(result.cleanup.attempted, false);

    try {
      const stat = await fs.stat(path.join(result.preservedWorkspaceDir, "hello.txt"));
      assert.equal(stat.isFile(), true);
    } finally {
      await fs.rm(result.preservedWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("computes stable fingerprints for identical failures and distinct ones for different failures", () => {
    const a1 = computeFailureFingerprint({
      contractName: "demo",
      firstFailedStepId: "run",
      failureCategory: "assertion_failed",
      exitCode: 0,
      failedAssertions: [{ kind: "stdoutIncludes", expected: "v2", observed: "not found", passed: false }],
    });
    const a2 = computeFailureFingerprint({
      contractName: "demo",
      firstFailedStepId: "run",
      failureCategory: "assertion_failed",
      exitCode: 0,
      failedAssertions: [{ kind: "stdoutIncludes", expected: "v2", observed: "not found", passed: false }],
    });
    const b = computeFailureFingerprint({
      contractName: "demo",
      firstFailedStepId: "install",
      failureCategory: "install_failed",
      exitCode: 1,
      failedAssertions: [{ kind: "exitCode", expected: "0", observed: "1", passed: false }],
    });
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
  });

  it("detects README quickstart command drift", () => {
    const contract: QuickstartContract = {
      schemaVersion: 1,
      name: "readme-check",
      files: {},
      steps: [
        { id: "install", command: "npm", args: ["install", "example-sdk@1.2.3"], timeoutMs: 10_000, expect: { exitCode: 0 } },
        { id: "run", command: "node", args: ["index.mjs"], timeoutMs: 10_000, expect: { exitCode: 0 } },
      ],
    };

    const matchingReadme = [
      "# Example",
      "<!-- docrun:start -->",
      "```bash",
      "npm install example-sdk@1.2.3",
      "node index.mjs",
      "```",
      "<!-- docrun:end -->",
    ].join("\n");

    const driftedReadme = [
      "# Example",
      "<!-- docrun:start -->",
      "```bash",
      "npm install example-sdk@1.0.0",
      "node index.mjs",
      "```",
      "<!-- docrun:end -->",
    ].join("\n");

    assert.equal(checkReadmeDrift(matchingReadme, contract).ok, true);
    assert.equal(checkReadmeDrift(driftedReadme, contract).ok, false);
  });
});

describe("toolchain resolution", () => {
  const NODE_FILE = process.platform === "win32" ? "node.exe" : "node";

  async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    try {
      delete process.env.Path;
      process.env.PATH = value;
      return await fn();
    } finally {
      delete process.env.PATH;
      delete process.env.Path;
      if (saved.Path !== undefined) process.env.Path = saved.Path;
      if (saved.PATH !== undefined) process.env.PATH = saved.PATH;
    }
  }

  async function samePath(a: string, b: string): Promise<boolean> {
    const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  }

  it("host mode uses the Node.js running docrun", async () => {
    const toolchain = await resolveToolchain("host");
    assert.equal(toolchain.nodePath, process.execPath);
    assert.equal(toolchain.nodeVersion, process.version);
  });

  it("path mode uses the node found on PATH and reports its version", async () => {
    const nodeDir = path.dirname(process.execPath);
    const toolchain = await withPath(nodeDir, () => resolveToolchain("path"));
    assert.equal(toolchain.nodePath, path.join(nodeDir, NODE_FILE));
    assert.equal(toolchain.nodeVersion, process.version);
  });

  it("path mode falls back to the host when PATH has no node", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-toolchain-"));
    try {
      const toolchain = await withPath(emptyDir, () => resolveToolchain("path"));
      assert.equal(toolchain.nodePath, process.execPath);
      assert.equal(toolchain.nodeVersion, process.version);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("path mode falls back to the host when the PATH node is unusable", async () => {
    const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-toolchain-"));
    try {
      const fakeNode = path.join(fakeDir, NODE_FILE);
      await fs.writeFile(fakeNode, "#!/bin/sh\necho not-a-version\n", { mode: 0o755 });
      const toolchain = await withPath(fakeDir, () => resolveToolchain("path"));
      assert.equal(toolchain.nodePath, process.execPath);
      assert.equal(toolchain.nodeVersion, process.version);
    } finally {
      await fs.rm(fakeDir, { recursive: true, force: true });
    }
  });

  it("path mode ignores relative PATH entries", async () => {
    const localDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-toolchain-"));
    try {
      await fs.copyFile(process.execPath, path.join(localDir, NODE_FILE));
      await fs.chmod(path.join(localDir, NODE_FILE), 0o755);
      const relative = path.relative(process.cwd(), localDir);
      assert.equal(path.isAbsolute(relative), false);

      const toolchain = await withPath(relative, () => resolveToolchain("path"));
      assert.equal(await samePath(toolchain.nodePath, process.execPath), true);
    } finally {
      await fs.rm(localDir, { recursive: true, force: true });
    }
  });

  it("runs steps with the selected toolchain and reports its version", async () => {
    const contract: QuickstartContract = {
      schemaVersion: 1,
      name: "toolchain-check",
      files: {},
      steps: [
        {
          id: "node-version",
          command: "node",
          args: ["--version"],
          timeoutMs: 20_000,
          expect: { exitCode: 0, stdoutIncludes: [process.version] },
        },
        {
          id: "npm-version",
          command: "npm",
          args: ["--version"],
          timeoutMs: 60_000,
          expect: { exitCode: 0 },
        },
      ],
    };
    const result = await runQuickstartContract(contract, { toolchain: "path" });
    assert.equal(result.status, "passed");
    assert.equal(result.nodeVersion, process.version);
  });
});

describe("python runtime support", () => {
  it("allows python, pip, and uv commands while rejecting disallowed commands", () => {
    for (const command of ["python", "pip", "uv"] as const) {
      const ok = validateContract({
        schemaVersion: 1,
        name: `valid-${command}`,
        steps: [
          {
            id: "check",
            command,
            args: ["--version"],
            timeoutMs: 10_000,
            expect: { exitCode: 0 },
          },
        ],
      });
      assert.equal(ok.ok, true, `Expected ${command} to be allowed`);
    }

    const bad = validateContract({
      schemaVersion: 1,
      name: "invalid-python3",
      steps: [
        {
          id: "check",
          command: "python3",
          args: ["--version"],
          timeoutMs: 10_000,
          expect: { exitCode: 0 },
        },
      ],
    });
    assert.equal(bad.ok, false);
  });

  it("runs python and pip inside an isolated workspace venv and reports pythonVersion", async () => {
    const loaded = await loadContractFile(REPO_ROOT, "fixtures/action-python/docrun.json");
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const result = await runQuickstartContract(loaded.contract, { toolchain: "path" });
    assert.equal(result.status, "passed");
    assert.match(result.pythonVersion ?? "", /^\d+\.\d+\.\d+/);
    assert.equal(result.steps.length, 3);
    assert.ok(result.steps.every((s) => s.status === "passed"));
  });

  it("classifies failing pip install as install_failed", async () => {
    const contract: QuickstartContract = {
      schemaVersion: 1,
      name: "pip-install-fail",
      files: {},
      steps: [
        {
          id: "install",
          command: "pip",
          args: ["install", "--no-index", "--find-links", "missing-wheelhouse", "nonexistent-pkg"],
          timeoutMs: 30_000,
          expect: { exitCode: 0 },
        },
      ],
    };

    const result = await runQuickstartContract(contract, { toolchain: "path" });
    assert.equal(result.status, "failed");
    assert.equal(result.failureCategory, "install_failed");
    assert.equal(result.firstFailedStepId, "install");
  });

  it("reports environment_failed cleanly when python is missing from PATH", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "docrun-nopy-"));
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    try {
      delete process.env.Path;
      process.env.PATH = emptyDir;

      const contract: QuickstartContract = {
        schemaVersion: 1,
        name: "missing-python",
        files: {},
        steps: [
          {
            id: "check",
            command: "python",
            args: ["--version"],
            timeoutMs: 10_000,
            expect: { exitCode: 0 },
          },
        ],
      };

      const result = await runQuickstartContract(contract, { toolchain: "path" });
      assert.equal(result.status, "failed");
      assert.equal(result.failureCategory, "environment_failed");
      assert.match(result.steps[0]?.stderr ?? "", /Python executable was not found on PATH/i);
    } finally {
      delete process.env.PATH;
      delete process.env.Path;
      if (saved.Path !== undefined) process.env.Path = saved.Path;
      if (saved.PATH !== undefined) process.env.PATH = saved.PATH;
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
