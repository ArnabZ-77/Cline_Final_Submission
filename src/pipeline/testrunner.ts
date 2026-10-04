/**
 * Running the target repo's tests inside the sandbox.
 *
 * Trap 2: the caller always passes the sandbox `cwd`.
 * Trap 3/24: the caller re-runs the tests itself; agent claims are never trusted.
 * Trap 11: the command is `["node", "--test"]` plus extra argv — never a directory.
 * Trap 12: both the TAP (`# pass 14`) and the spec (`ℹ pass 14`) reporters are parsed, and
 *          `✖ ✕ ✗ ×` all count as failures.
 */
import { spawn } from "node:child_process";
import type { RepoConfig, TestRunResult } from "../types.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
/** eslint-disable-next-line no-control-regex -- stripping colour codes needs \u001b. */
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return String(text ?? "").replace(ANSI, "");
}

export function formatCommand(argv: string[]): string {
  return argv.map((part) => (/[\s"']/.test(part) ? `"${part}"` : part)).join(" ");
}

const FAIL_MARKER = /^\s*(?:[✖✕✗×]|not ok)\s*\d*\s*-?\s*(.+?)\s*(?:\(\d+(?:\.\d+)?\s*m?s\))?$/;

function failureLines(output: string): string[] {
  const failures: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[✖✕✗×]\s*/, "✖ ");
    if (!/^\s*(?:✖|not ok)/.test(line)) continue;
    const m = FAIL_MARKER.exec(line);
    const text = (m ? m[1] : line).trim();
    if (text.length > 0 && !failures.includes(text)) failures.push(text);
  }
  return failures;
}

/** Failure-related lines only, capped near 3,500 characters. */
export function summarise(output: string, maxChars = 3500): string {
  const interesting = output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) =>
      /^\s*(?:✖|not ok|✕|✗|×)/.test(l) ||
      /AssertionError|Error:|expected|actual:|operator:|at TestContext/.test(l) ||
      /^[#ℹ]\s*(?:tests|pass|fail)\b/.test(l)
    );
  const joined = interesting.join("\n").trim();
  const text = joined.length > 0 ? joined : output.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function parseCounts(output: string): {
  pass?: number;
  fail?: number;
  tests?: number;
  durationMs?: number;
} {
  const pick = (label: string): number | undefined => {
    const m = new RegExp(`^[#ℹ]\\s*${label}\\s+(\\d+)`, "m").exec(output);
    return m ? Number(m[1]) : undefined;
  };
  return {
    tests: pick("tests"),
    pass: pick("pass"),
    fail: pick("fail"),
    durationMs: pick("duration_ms"),
  };
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: NodeJS.ErrnoException;
  timedOut: boolean;
}

/**
 * Async spawn without a shell, killed on timeout. Async so a hanging suite (say, an
 * infinite loop a Fixer introduced) never blocks the server's event loop, SSE or timers.
 */
function spawnCollect(argv: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const MAX = 32 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: Omit<SpawnOutcome, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...outcome });
    };
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < MAX) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX) stderr += d;
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ status: null, error }));
    child.on("close", (status: number | null) => finish({ status }));
  });
}

/**
 * Runs `[...repo.testCommand, ...extraArgs]` in `cwd`.
 * `ok` is true only when the exit code is 0, it did not time out, and nothing was
 * reported failing.
 */
export async function runTests(
  repo: Pick<RepoConfig, "testCommand">,
  cwd: string,
  extraArgs: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<TestRunResult> {
  const argv = [...(repo.testCommand?.length ? repo.testCommand : ["node", "--test"]), ...extraArgs];
  const command = formatCommand(argv);

  const res = await spawnCollect(argv, cwd, timeoutMs);

  if (res.error || res.timedOut) {
    const timedOut = res.timedOut;
    const err = res.error;
    return {
      command,
      passed: 0,
      failed: timedOut ? 0 : 1,
      durationMs: 0,
      summary: timedOut ? `timed out after ${timeoutMs} ms` : `could not run: ${err?.message ?? "unknown error"}`,
      failures: [],
      exitCode: null,
      ok: false,
      timedOut,
    };
  }

  const output = stripAnsi(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  const counts = parseCounts(output);
  const failures = failureLines(output);
  const passed = counts.pass ?? 0;
  const failed = counts.fail ?? failures.length;
  const ok = res.status === 0 && failed === 0;

  let summary: string;
  if (counts.tests === undefined && passed === 0 && failed === 0) {
    summary = summarise(output);
  } else {
    summary = `${passed} passed, ${failed} failed`;
    const detail = summarise(output);
    if (detail.length > 0 && failed > 0) summary += `\n${detail}`;
  }

  return {
    command,
    passed,
    failed: ok ? 0 : Math.max(failed, 1),
    durationMs: counts.durationMs ?? 0,
    summary: summary.slice(0, 3500),
    failures,
    exitCode: res.status,
    ok,
    timedOut: false,
  };
}
