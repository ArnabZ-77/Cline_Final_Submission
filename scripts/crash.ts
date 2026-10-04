/**
 * demo:crash — trigger a bug for PatchPilot.
 *
 *   npm run demo:crash -- 01           crash bug: hits the shop, whose middleware reports it
 *   npm run demo:crash -- 11           manual bug: files the plain-English report
 *   npm run demo:crash -- all          every bug
 *
 * Env: DEMO_URL (shop, default http://localhost:5050), PATCHPILOT_URL (default
 * http://localhost:4747), DEMO_REPO (repo name for manual reports, default "demo-app").
 */
import { BUGS, selectBugs } from "../benchmark/golden/bugs.js";
import { DEMO_URL, PATCHPILOT_URL, explainFetchError, send } from "./http.ts";

const DEMO_REPO = process.env.DEMO_REPO || "demo-app";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(`usage: npm run demo:crash -- <bug id | all>   (ids: ${BUGS.map((b) => b.id).join(", ")})`);
    process.exit(1);
  }
  const bugs = arg === "all" ? BUGS : selectBugs(arg);
  if (bugs.length === 0) {
    console.error(`no bug matches "${arg}"`);
    process.exit(1);
  }

  for (const bug of bugs) {
    if (bug.source === "crash") {
      try {
        const res = await send(DEMO_URL, bug.request!);
        console.log(`${bug.id} ${bug.name}: shop answered ${res.status} ${res.text.slice(0, 140)}`);
        console.log(res.status >= 500 ? "   → the shop's middleware reported the crash to PatchPilot" : "   → no crash (already fixed?)");
      } catch (err) {
        console.error(`${bug.id} ${bug.name}: ${explainFetchError(err, DEMO_URL, "npm run demo:shop")}`);
        process.exitCode = 1;
      }
      continue;
    }
    const description = String(bug.description ?? "");
    const title = description.split(/(?<=[.!?])\s/)[0].slice(0, 100);
    try {
      const res = await send(PATCHPILOT_URL, {
        method: "POST",
        path: "/api/incidents/manual",
        body: { repo: DEMO_REPO, title, description, suspectFile: bug.file },
      });
      console.log(`${bug.id} ${bug.name}: report filed for repo "${DEMO_REPO}" → ${res.status} ${res.text}`);
    } catch (err) {
      console.error(`${bug.id} ${bug.name}: ${explainFetchError(err, PATCHPILOT_URL, "npm start")}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nwatch it on the dashboard: ${PATCHPILOT_URL}/`);
}

main();
