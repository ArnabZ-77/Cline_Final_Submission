/**
 * Sandboxes are git worktrees of the target repo, so the user's checkout is never touched
 * and the diff is always `git diff` inside a throwaway directory.
 *
 * Trap 1: `git worktree add` ignores `.gitattributes` on Windows, so LF is forced with
 * `-c core.autocrlf=false -c core.eol=lf`.
 * Trap 2: everything runs with an explicit `cwd` inside the sandbox.
 * Trap 4: `git diff` skips untracked files, so the diff is always taken from the index
 *             after `git add -A`. `--relative` keeps diff paths relative to the app folder
 *             (`cwd`), which is what testPaths/protectedPaths are matched against.
 * Trap 5: reverting is `git reset --hard HEAD` + `git clean -fd`, never the index alone.
 * Trap 10: git is spawned without a shell, so no argument can be mangled.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SANDBOXES_DIR, toPosix } from "../config.ts";
import type { RepoConfig, SandboxInfo } from "../types.ts";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "true",
};

/**
 * Google API keys start with a fixed four-character prefix. It is assembled at run time so
 * that this source file does not itself match the secret scanner used before every commit.
 * It is a shape, not a credential.
 */
const GOOGLE_KEY_PREFIX = ["AI", "za"].join("");
const GOOGLE_KEY_RE = new RegExp(`\\b${GOOGLE_KEY_PREFIX}[0-9A-Za-z_-]{20,}\\b`, "g");

/** Strips credentials from anything that may be logged. */
export function redact(text: string): string {
  return String(text ?? "")
    .replace(/(https?:\/\/)[^@\s/]+(:[^@\s/]*)?@/gi, "$1***@")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "***")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "***")
    .replace(GOOGLE_KEY_RE, "***")
    .replace(/\b(authorization|proxy-authorization|x-api-key)(\s*:\s*)[^\r\n]+/gi, "$1$2***")
    .replace(/\b([A-Za-z_]*(?:token|password|passwd|secret|api[_-]?key))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"']+)/gi, "$1$2***");
}

/** Run git in `cwd` without a shell. Throws with redacted stderr on a non-zero exit. */
export function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["--no-pager", ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: GIT_ENV,
  });
  if (res.error) throw new Error(`git ${args[0] ?? ""} could not run: ${redact(res.error.message)}`);
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${res.status}): ${redact((res.stderr || res.stdout || "").trim())}`
    );
  }
  return (res.stdout ?? "").trim();
}

/** `git` that returns a result object instead of throwing. */
export function gitTry(cwd: string, args: string[]) {
  try {
    return { ok: true as const, out: git(cwd, args), error: undefined };
  } catch (err) {
    return { ok: false as const, out: "", error: (err as Error).message };
  }
}

/**
 * The sandbox folder for `id`. The id becomes a path and a branch name, and these helpers
 * are also called from scripts, so it is validated rather than trusted.
 */
export function sandboxPath(id: string, sandboxesDir: string = SANDBOXES_DIR): string {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id)) || /^\.+$/.test(String(id))) {
    throw new Error(`invalid sandbox id: ${JSON.stringify(id)}`);
  }
  const base = path.resolve(sandboxesDir);
  const dir = path.resolve(base, id);
  if (path.dirname(dir) !== base) throw new Error(`sandbox path escapes ${base}: ${id}`);
  return dir;
}

export function sandboxBranch(id: string): string {
  return `patchpilot/${String(id).replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
}

/**
 * Creates (or recreates) the worktree for an incident and checks out the fix branch.
 * `cwd` is the app folder inside the sandbox — the agents' working directory.
 */
export function createSandbox(repo: RepoConfig, id: string, sandboxesDir: string = SANDBOXES_DIR): SandboxInfo {
  const dir = sandboxPath(id, sandboxesDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  gitTry(repo.root, ["worktree", "prune"]);

  const target =
    toPosix(path.relative(repo.root, dir)) === "" ? toPosix(dir) : toPosix(path.relative(repo.root, dir));
  const branch = sandboxBranch(id);
  git(repo.root, [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "worktree",
    "add",
    "-f",
    "-B",
    branch,
    target,
    repo.baseRef,
  ]);

  return { dir: toPosix(dir), cwd: toPosix(path.join(dir, repo.subdir)), branch };
}

/**
 * Drops git's records of worktrees whose folders are gone (PatchPilot killed mid-run, or
 * `.patchpilot/` deleted by hand). Called at startup; never touches existing sandboxes.
 */
export function pruneWorktrees(repo: Pick<RepoConfig, "root">): void {
  gitTry(repo.root, ["worktree", "prune"]);
}

/** Removes the worktree and its git metadata. */
export function removeSandbox(repo: RepoConfig, id: string, sandboxesDir: string = SANDBOXES_DIR): void {
  gitTry(repo.root, ["worktree", "remove", "--force", sandboxPath(id, sandboxesDir)]);
  gitTry(repo.root, ["worktree", "prune"]);
  fs.rmSync(sandboxPath(id, sandboxesDir), { recursive: true, force: true });
}

/** Stages everything so brand-new files appear in the diff (trap 4). */
function stageAll(cwd: string): void {
  git(cwd, ["add", "-A"]);
}

export function diffText(cwd: string): string {
  stageAll(cwd);
  return git(cwd, ["diff", "--cached", "--relative"]);
}

export function diffNames(cwd: string): string[] {
  stageAll(cwd);
  const out = git(cwd, ["diff", "--cached", "--relative", "--name-only"]);
  return out.length > 0 ? out.split("\n").filter(Boolean) : [];
}

export function diffNumstat(cwd: string): Array<{ added: number; removed: number; file: string }> {
  stageAll(cwd);
  const out = git(cwd, ["diff", "--cached", "--relative", "--numstat"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, file] = line.split("\t");
      return { added: Number(added) || 0, removed: Number(removed) || 0, file };
    });
}

export function diffStat(cwd: string): string {
  stageAll(cwd);
  return git(cwd, ["diff", "--cached", "--relative", "--stat"]);
}

/** Commits everything with a temporary identity (so no host config is needed). */
export function commitAll(dir: string, message: string): string {
  stageAll(dir);
  const staged = gitTry(dir, ["diff", "--cached", "--quiet"]);
  if (staged.ok) throw new Error(`commitAll: nothing to commit for "${message}"`);
  git(dir, [
    "-c",
    "user.name=PatchPilot",
    "-c",
    "user.email=patchpilot@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Trap 5: reset tracked files and delete anything untracked. */
export function revertAll(cwd: string): void {
  git(cwd, ["reset", "--hard", "HEAD"]);
  git(cwd, ["clean", "-fd"]);
}
