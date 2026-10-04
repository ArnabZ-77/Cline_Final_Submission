/**
 * demo:try — send each bug's request to the shop and say whether it behaves correctly.
 *
 *   npm run demo:try            every bug
 *   npm run demo:try -- 01      one bug
 *
 * Expected: 0/10 ✅ on the buggy shop, 10/10 ✅ with all fixes applied. A crashing request
 * is also reported to PatchPilot by the shop's capture middleware.
 */
import { BUGS, selectBugs } from "../benchmark/golden/bugs.js";
import { DEMO_URL, explainFetchError, send } from "./http.ts";

async function main() {
  const bugs = selectBugs(process.argv[2]).filter((b) => b.request && b.check);
  if (bugs.length === 0) {
    console.error(`no bug with a request matches "${process.argv[2]}" (ids: ${BUGS.map((b) => b.id).join(", ")})`);
    process.exit(1);
  }
  console.log(`checking ${DEMO_URL}\n`);
  let ok = 0;
  for (const bug of bugs) {
    try {
      const vars: Record<string, string> = {};
      if (bug.setup) {
        const setup = await send(DEMO_URL, bug.setup);
        const id = (setup.body as { id?: unknown })?.id;
        if (id === undefined) throw new Error(`setup did not return an id: ${setup.status} ${setup.text}`);
        vars.id = String(id);
      }
      const res = await send(DEMO_URL, bug.request!, vars);
      const verdict = bug.check!(res.status, res.body);
      if (verdict.ok) ok += 1;
      const got = `${res.status} ${typeof res.body === "string" ? res.body : JSON.stringify(res.body)}`;
      console.log(`${verdict.ok ? "✅" : "❌"} ${bug.id} ${bug.name.padEnd(12)} got: ${got}`);
      if (!verdict.ok) console.log(`   ${"".padEnd(15)} expected: ${verdict.want}`);
    } catch (err) {
      console.error(`❌ ${bug.id} ${bug.name.padEnd(12)} ${explainFetchError(err, DEMO_URL, "npm run demo:shop")}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${ok}/${bugs.length} behave correctly`);
}

main();
