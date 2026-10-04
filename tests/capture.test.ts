import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildEvent, parseStack } from "../sdk/patchpilot-express.js";
import { appFrames, createIncident, manualEvent, recordOccurrence } from "../src/capture/incident.ts";
import { IncidentStore } from "../src/store.ts";
import { redact, sandboxPath } from "../src/pipeline/sandbox.ts";
import { isAccountProblem, isTransient } from "../src/pipeline/model.ts";
import { resolveInCwd } from "../src/pipeline/tools.ts";
import { loadConfig } from "../src/config.ts";
import type { IncidentEvent } from "../src/types.ts";

const APP = path.resolve("/srv/shop");
const appFile = (rel: string) => path.join(APP, rel).replace(/\\/g, "/");

describe("capture middleware: parseStack / buildEvent", () => {
  const stack = [
    "TypeError: Cannot read properties of null (reading 'price')",
    `    at computeTotal (file:///${appFile("src/lib/total.js").replace(/^\//, "")}:4:24)`,
    `    at handler (${appFile("server.js")}:45:20)`,
    "    at Layer.handle (D:/x/node_modules/express/lib/router/layer.js:95:5)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  ].join("\n");

  it("orders frames oldest first (the last frame threw) and marks in_app", () => {
    const frames = parseStack(stack, APP);
    expect(frames.at(-1)).toMatchObject({ function: "computeTotal", filename: "src/lib/total.js", lineno: 4, in_app: true });
    expect(frames.find((f: any) => f.filename.includes("node_modules"))?.in_app).toBe(false);
    expect(frames.find((f: any) => f.filename.startsWith("node:"))?.in_app).toBe(false);
  });

  it("follows err.cause oldest first, strips secret headers, and sets the transaction", () => {
    const root = new RangeError("db said no");
    const err = new Error("checkout failed", { cause: root });
    const ev = buildEvent(
      err,
      {
        method: "POST",
        route: { path: "/api/orders/total" },
        headers: { authorization: "Bearer s3cret", cookie: "a=b", "x-api-key": "k", "set-cookie": "c", "proxy-authorization": "p", accept: "json" },
      },
      { root: APP, repo: "demo-shop" }
    ) as any;
    expect(ev.exception.values.map((v: any) => v.type)).toEqual(["RangeError", "Error"]);
    expect(ev.exception.values[0].mechanism.type).toBe("chained");
    expect(Object.keys(ev.request.headers)).toEqual(["accept"]);
    expect(ev.transaction).toBe("POST /api/orders/total");
    expect(ev.tags.repo).toBe("demo-shop");
  });

  it("adds source context but skips files over 512 KB", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ctx-"));
    try {
      fs.writeFileSync(path.join(dir, "small.js"), "a\nb\nTHROW\nd\n");
      fs.writeFileSync(path.join(dir, "big.js"), "x\n".repeat(300_000));
      const s = `Error: x\n    at f (${path.join(dir, "small.js")}:3:1)\n    at g (${path.join(dir, "big.js")}:2:1)`;
      const [big, small] = parseStack(s, dir) as any[];
      expect(small).toMatchObject({ context_line: "THROW", pre_context: ["a", "b"], post_context: ["d", ""] });
      expect(big.context_line).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws, even on garbage", () => {
    expect(() => buildEvent(undefined, undefined)).not.toThrow();
    expect(() => buildEvent("a string", {} as any)).not.toThrow();
    expect(parseStack(undefined as any, APP)).toEqual([]);
  });
});

describe("incidents", () => {
  const frame = (fn: string, file: string) => ({ filename: file, abs_path: appFile(file), function: fn, lineno: 1, colno: 1, in_app: true });
  const ev: IncidentEvent = {
    event_id: "e",
    timestamp: "t",
    platform: "node",
    exception: {
      values: [
        { type: "RangeError", value: "cause", stacktrace: { frames: [frame("dbCall", "src/lib/db.js")] } },
        { type: "Error", value: "outer", stacktrace: { frames: [frame("handler", "server.js"), frame("computeTotal", "src/lib/total.js")] } },
      ],
    },
  };

  it("uses only the thrown exception's frames, so the last frame is the throw site", () => {
    const frames = appFrames(ev, APP);
    expect(frames.map((f) => f.function)).toEqual(["handler", "computeTotal"]);
  });

  it("drops frames outside the app folder and re-relativises the rest", () => {
    const outside = { filename: "x.js", abs_path: path.resolve("/other/x.js"), function: "harness", in_app: true };
    const withHarness: IncidentEvent = { ...ev, exception: { values: [{ type: "E", value: "v", stacktrace: { frames: [outside, frame("f", "src/lib/a.js")] } }] } };
    expect(appFrames(withHarness, APP).map((f) => f.filename)).toEqual(["src/lib/a.js"]);
  });

  it("gives every incident a unique id and caps stored events", () => {
    const a = createIncident(ev, "demo-app", APP);
    const b = createIncident(ev, "demo-app", APP);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.id).not.toBe(b.id);
    for (let i = 0; i < 30; i += 1) recordOccurrence(a, ev);
    expect(a.occurrences).toBe(31);
    expect(a.events.length).toBe(20);
  });

  it("builds a manual report with one synthetic frame", () => {
    const m = manualEvent({ title: "Signup accepts garbage", description: "empty email", suspectFile: "src/lib/signup.js" });
    expect(m.exception.values[0]).toMatchObject({ type: "ReportedBug", mechanism: { type: "manual" } });
    expect(m.exception.values[0].stacktrace?.frames).toHaveLength(1);
  });
});

describe("IncidentStore", () => {
  it("marks unfinished incidents failed on load and survives partial files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-store-"));
    try {
      fs.writeFileSync(path.join(dir, "inc_a.json"), JSON.stringify({ id: "inc_a", stage: "fix", lastSeen: "2026-01-01" }));
      fs.writeFileSync(path.join(dir, "inc_b.json"), "{ truncated");
      const store = new IncidentStore(dir);
      store.load();
      const a = store.get("inc_a")!;
      expect(a.stage).toBe("failed");
      expect(a.error).toMatch(/restarted/);
      expect(a.timeline.at(-1)?.type).toBe("error");
      expect(store.list()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically, caps the timeline at 2000 and emits `event`", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-store-"));
    try {
      const store = new IncidentStore(dir);
      const inc = createIncident(manualEvent({ title: "t", description: "d" }), "demo-app", APP);
      store.add(inc);
      let events = 0;
      store.on("event", () => (events += 1));
      for (let i = 0; i < 2005; i += 1) store.log(inc, "info", `n${i}`);
      expect(inc.timeline).toHaveLength(2000);
      expect(inc.timeline[0].text).toBe("n5");
      expect(events).toBe(2005);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${inc.id}.json`), "utf8")).timeline).toHaveLength(2000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hardening from review", () => {
  it("sandbox ids are validated before becoming paths", () => {
    expect(() => sandboxPath("../../evil", "/tmp/sb")).toThrow(/invalid sandbox id/);
    expect(() => sandboxPath("..", "/tmp/sb")).toThrow(/invalid sandbox id/);
    expect(() => sandboxPath("a/b", "/tmp/sb")).toThrow(/invalid sandbox id/);
    expect(sandboxPath("inc_abc123", "/tmp/sb")).toBe(path.resolve("/tmp/sb/inc_abc123"));
  });

  it("redact masks tokens, keys and credentials", () => {
    // Assembled from parts so this file does not itself match a secret scanner. These are
    // deliberately fake values that only have the right *shape*.
    const fakeGoogle = ["AI", "zaSyA1234567890abcdefghijk"].join("");
    const fakeAnthropic = ["sk-", "ant-api03-abcdefghijklmnopqrst"].join("");
    const out = redact(
      `https://user:pw@github.com/x ghp_abcdefghijklmnop ${fakeAnthropic} ` +
        `Authorization: Bearer xyz password=hunter2 ${fakeGoogle}`
    );
    for (const secret of [
      "pw@",
      "ghp_abc",
      "sk-ant",
      "Bearer xyz",
      "hunter2",
      fakeGoogle.slice(0, 8),
    ]) {
      expect(out).not.toContain(secret);
    }
    // The non-secret parts of the line survive, so we know redaction is targeted.
    expect(out).toContain("https://***@github.com/x");
  });

  it("account problems fail fast; per-minute quota / rate limits are retried", () => {
    expect(isAccountProblem("You exceeded your current quota, please check your plan and billing details")).toBe(true);
    expect(isAccountProblem("401 Unauthorized: invalid x-api-key")).toBe(true);
    expect(isAccountProblem("Request failed with status code 403")).toBe(true);
    expect(isTransient("429 Rate limit: quota exceeded for requests per minute, try again")).toBe(true);
    expect(isAccountProblem("429 Rate limit: quota exceeded for requests per minute")).toBe(false);
    expect(isTransient("This model is currently experiencing high demand")).toBe(true);
    expect(isTransient("request req_401abc failed: overloaded")).toBe(true);
  });

  it("refuses a new file under a symlinked folder that points outside the app", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "pp-link-"));
    try {
      const app = path.join(base, "app");
      const outside = path.join(base, "outside");
      fs.mkdirSync(app);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(app, "link"), "junction");
      expect(() => resolveInCwd(app, "link/new-file.js")).toThrow(/escapes/);
      expect(() => resolveInCwd(app, "src/new-file.js")).not.toThrow();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("loadConfig fails loudly on a bad config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-cfg-"));
    try {
      const write = (o: unknown) => fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify(o));
      write({ repos: {} });
      expect(() => loadConfig(path.join(dir, "c.json"), dir)).toThrow(/repos.*empty/);
      write({ defaultRepo: "typo", repos: { real: { root: "." } } });
      expect(() => loadConfig(path.join(dir, "c.json"), dir)).toThrow(/not in repos/);
      write({ repos: { real: { root: "." } } });
      expect(loadConfig(path.join(dir, "c.json"), dir).defaultRepo).toBe("real");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
