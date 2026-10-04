/**
 * Hard checks on the Fixer's diff. PatchPilot runs them itself after every attempt; the
 * agent's word is never taken for anything (trap 24).
 *
 * The diff is `git add -A` + `git diff --cached --relative` (trap 4), so brand-new files are
 * included and paths are relative to the app folder, the same frame the path rules use.
 * Pattern checks scan ADDED lines only: removing a `.skip(` is fine, adding one is not.
 */
import fs from "node:fs";
import path from "node:path";
import { isProtectedPath, isTestPath } from "./guardrails.ts";
import type { HardCheckResult, RepoConfig } from "../types.ts";

export type HardCheckRepo = Pick<RepoConfig, "testPaths" | "protectedPaths" | "maxDiffLines" | "maxDiffFiles">;

const SKIP_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /\.skip\s*\(/, label: ".skip(" },
  { re: /\.only\s*\(/, label: ".only(" },
  { re: /\bxit\s*\(/, label: "xit(" },
  { re: /\bxdescribe\s*\(/, label: "xdescribe(" },
  { re: /\btest\.todo\s*\(/, label: "test.todo(" },
];

const MODULE_MOCKS: Array<{ re: RegExp; label: string }> = [
  { re: /\bjest\.mock\s*\(/, label: "jest.mock(" },
  { re: /\bvi\.mock\s*\(/, label: "vi.mock(" },
];

const EQUALITY_OVERRIDES: Array<{ re: RegExp; label: string }> = [
  { re: /\bvalueOf\s*\(/, label: "valueOf(" },
  { re: /\btoJSON\s*\(/, label: "toJSON(" },
  { re: /Symbol\.toPrimitive/, label: "Symbol.toPrimitive" },
];

/** Added lines of a unified diff, with the file each belongs to. */
export function addedLines(diff: string): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  let file = "";
  for (const raw of String(diff ?? "").split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("+")) out.push({ file, line: raw.slice(1) });
  }
  return out;
}

/** Changed lines (added + removed), the measure the line cap applies to. */
export function changedLineCount(diff: string): number {
  let n = 0;
  for (const raw of String(diff ?? "").split(/\r?\n/)) {
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) n += 1;
  }
  return n;
}

function scan(diff: string, patterns: Array<{ re: RegExp; label: string }>): string[] {
  const hits: string[] = [];
  for (const { file, line } of addedLines(diff)) {
    for (const { re, label } of patterns) {
      if (re.test(line)) hits.push(`${label} in ${file || "?"}: ${line.trim().slice(0, 120)}`);
    }
  }
  return hits;
}

const result = (name: string, ok: boolean, detail?: string): HardCheckResult =>
  detail ? { name, ok, detail } : { name, ok };

export function runHardChecks(diff: string, files: string[], repo: HardCheckRepo): HardCheckResult[] {
  const changed = files.filter(Boolean);
  const testEdits = changed.filter((f) => isTestPath(f, repo));
  const protectedEdits = changed.filter((f) => isProtectedPath(f, repo));
  const lines = changedLineCount(diff);
  const skips = scan(diff, SKIP_MARKERS);
  const mocks = scan(diff, MODULE_MOCKS);
  const overrides = scan(diff, EQUALITY_OVERRIDES);

  return [
    result("no-test-file-edits", testEdits.length === 0, testEdits.length ? `test files changed: ${testEdits.join(", ")}` : undefined),
    result(
      "no-protected-path-edits",
      protectedEdits.length === 0,
      protectedEdits.length ? `protected paths changed: ${protectedEdits.join(", ")}` : undefined
    ),
    result(
      "diff-size-within-cap",
      changed.length <= repo.maxDiffFiles,
      `${changed.length} file(s) changed, cap ${repo.maxDiffFiles}`
    ),
    result("diff-lines-within-cap", lines <= repo.maxDiffLines, `${lines} changed line(s), cap ${repo.maxDiffLines}`),
    result("no-skip-or-only-markers", skips.length === 0, skips.length ? skips.join("; ") : undefined),
    result("no-new-module-mocks", mocks.length === 0, mocks.length ? mocks.join("; ") : undefined),
    result("no-equality-overrides", overrides.length === 0, overrides.length ? overrides.join("; ") : undefined),
    result("diff-not-empty", changed.length > 0 && diff.trim().length > 0, changed.length ? undefined : "no changes"),
  ];
}

// --- brace balance -------------------------------------------------------------------------

const PAIRS: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "yield", "await"]);

/**
 * Bracket balance of JS/TS source, skipping strings, template literals, comments and
 * regex literals. Returns undefined when balanced, else a short description.
 */
export function braceImbalance(source: string): string | undefined {
  const stack: Array<{ ch: string; line: number }> = [];
  let line = 1;
  let prevSignificant = "";
  let lastWord = "";
  const s = source;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\n") {
      line += 1;
      continue;
    }
    if (/\s/.test(ch)) continue;
    // Comments
    if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i += 1;
      i -= 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") line += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    // Strings and template literals (template `${}` bodies are balanced by construction)
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < s.length && s[i] !== ch) {
        if (s[i] === "\\") i += 1;
        else if (s[i] === "\n") {
          line += 1;
          if (ch !== "`") break; // unterminated plain string: stop at end of line
        }
        i += 1;
      }
      prevSignificant = "a";
      continue;
    }
    // Regex literal: a `/` where an expression may start (after an operator, an opening
    // bracket, or a keyword such as `return`).
    if (
      ch === "/" &&
      (prevSignificant === "" ||
        /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSignificant) ||
        (prevSignificant === "a" && REGEX_KEYWORDS.has(lastWord)))
    ) {
      i += 1;
      let inClass = false;
      while (i < s.length && s[i] !== "\n") {
        if (s[i] === "\\") i += 1;
        else if (s[i] === "[") inClass = true;
        else if (s[i] === "]") inClass = false;
        else if (s[i] === "/" && !inClass) break;
        i += 1;
      }
      prevSignificant = "a";
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") stack.push({ ch, line });
    else if (ch === "}" || ch === ")" || ch === "]") {
      const top = stack.pop();
      if (!top) return `unexpected '${ch}' on line ${line}`;
      if (top.ch !== PAIRS[ch]) return `'${top.ch}' from line ${top.line} closed by '${ch}' on line ${line}`;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j += 1;
      lastWord = s.slice(i, j);
      i = j - 1;
      prevSignificant = "a";
    } else {
      lastWord = "";
      prevSignificant = ch;
    }
  }
  const open = stack.pop();
  return open ? `'${open.ch}' from line ${open.line} is never closed` : undefined;
}

const CODE_FILE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;

/** Checks every changed JS/TS file that still exists. Deleted files are skipped. */
export function braceBalanceOk(cwd: string, files: string[]): HardCheckResult {
  const problems: string[] = [];
  for (const f of files) {
    if (!CODE_FILE.test(f)) continue;
    const abs = path.join(cwd, f);
    if (!fs.existsSync(abs)) continue;
    const issue = braceImbalance(fs.readFileSync(abs, "utf8"));
    if (issue) problems.push(`${f}: ${issue}`);
  }
  return problems.length ? { name: "brace-balance", ok: false, detail: problems.join("; ") } : { name: "brace-balance", ok: true };
}
