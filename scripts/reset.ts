/**
 * demo:reset — put everything back to a clean demo state.
 *
 *   npm run demo:reset                 local cleanup only
 *   npm run demo:reset -- --close-prs  also close open PatchPilot PRs on GitHub
 *
 * Deletes .patchpilot/, removes sandbox worktrees, deletes local patchpilot/* branches in
 * PatchPilot's repo and every configured target repo, and puts the shop back on main.
 * Stop the servers first (see README: "stop by port"), or they keep serving old state.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, PROJECT_ROOT, loadConfig } from "../src/config.ts";
import { gitTry } from "../src/pipeline/sandbox.ts";

const closePrs = process.argv.includes("--close-prs");

function say(text: string) {
  console.log(text);
}

function deleteBranches(root: string, label: string) {
  const branches = gitTry(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/patchpilot/"]).out
    .split("\n")
    .filter(Boolean);
  for (const b of branches) {
    const r = gitTry(root, ["branch", "-D", b]);
    say(`  ${label}: ${r.ok ? "deleted" : "could not delete"} branch ${b}${r.ok ? "" : ` (${r.error})`}`);
  }
  if (branches.length === 0) say(`  ${label}: no patchpilot/* branches`);
}

function main() {
  const config = loadConfig();
  const roots = new Map<string, string>([[path.resolve(PROJECT_ROOT), "patchpilot"]]);
  for (const [name, repo] of Object.entries(config.repos)) {
    if (fs.existsSync(path.join(repo.root, ".git"))) roots.set(path.resolve(repo.root), name);
  }

  say("1. removing sandbox worktrees");
  for (const [root, label] of roots) {
    const list = gitTry(root, ["worktree", "list", "--porcelain"]).out;
    for (const line of list.split("\n")) {
      const wt = line.startsWith("worktree ") ? line.slice(9).trim() : "";
      if (wt && path.resolve(wt).toLowerCase().startsWith(path.resolve(DATA_DIR).toLowerCase())) {
        const r = gitTry(root, ["worktree", "remove", "--force", wt]);
        say(`  ${label}: ${r.ok ? "removed" : "could not remove"} ${wt}`);
      }
    }
  }

  say("2. deleting .patchpilot/");
  try {
    // Windows: a file another process still has open fails with EPERM/EBUSY; retry briefly.
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    // Keep going: the branch cleanup and the shop checkout below must still happen.
    process.exitCode = 1;
    say(
      `  could not delete it completely (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). ` +
        "A PatchPilot server or benchmark is probably still running; stop it (see README: stop by port) and run demo:reset again."
    );
  }
  for (const root of roots.keys()) gitTry(root, ["worktree", "prune"]);

  say("3. deleting local patchpilot/* branches");
  for (const [root, label] of roots) deleteBranches(root, label);

  say("4. putting target repos back on their base branch");
  for (const [name, repo] of Object.entries(config.repos)) {
    if (path.resolve(repo.root) === path.resolve(PROJECT_ROOT)) continue;
    if (!fs.existsSync(path.join(repo.root, ".git"))) {
      say(`  ${name}: ${repo.root} not found (skipped)`);
      continue;
    }
    const base = repo.baseRef === "HEAD" ? "main" : repo.baseRef;
    const r = gitTry(repo.root, ["checkout", base]);
    say(`  ${name}: ${r.ok ? `on ${base}` : `could not check out ${base}: ${r.error}`}`);
  }

  if (closePrs) {
    say("5. closing open PatchPilot PRs");
    for (const [name, repo] of Object.entries(config.repos)) {
      if (path.resolve(repo.root) === path.resolve(PROJECT_ROOT) || !fs.existsSync(path.join(repo.root, ".git"))) continue;
      const list = spawnSync("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "100"], {
        cwd: repo.root,
        encoding: "utf8",
        shell: false,
      });
      if (list.status !== 0) {
        say(`  ${name}: gh pr list failed: ${(list.stderr || list.error?.message || "").trim()}`);
        continue;
      }
      const prs = (JSON.parse(list.stdout || "[]") as Array<{ number: number; headRefName: string }>).filter((p) =>
        p.headRefName.startsWith("patchpilot/")
      );
      for (const pr of prs) {
        const c = spawnSync("gh", ["pr", "close", String(pr.number), "--delete-branch"], { cwd: repo.root, encoding: "utf8", shell: false });
        say(`  ${name}: ${c.status === 0 ? "closed" : "could not close"} #${pr.number} (${pr.headRefName})`);
      }
      if (prs.length === 0) say(`  ${name}: no open PatchPilot PRs`);
    }
  }
  say("\ndone. Start fresh with: npm start   (and npm run demo:shop)");
}

main();
