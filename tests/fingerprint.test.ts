import { describe, expect, it } from "vitest";
import { computeFingerprint } from "../src/capture/fingerprint.ts";
import type { IncidentEvent, StackFrame } from "../src/types.ts";

function frame(over: Partial<StackFrame> = {}): StackFrame {
  return {
    filename: "src/lib/total.js",
    function: "computeTotal",
    lineno: 4,
    colno: 24,
    in_app: true,
    context_line: "    total += item.price * item.quantity;",
    ...over,
  };
}

function event(opts: { type?: string; value?: string; frames?: StackFrame[]; fingerprint?: string[] } = {}): IncidentEvent {
  return {
    event_id: "e1",
    timestamp: "2026-10-04T00:00:00.000Z",
    platform: "node",
    fingerprint: opts.fingerprint,
    exception: {
      values: [
        {
          type: opts.type ?? "TypeError",
          value: opts.value ?? "Cannot read properties of null (reading 'price')",
          stacktrace: opts.frames === undefined ? { frames: [frame()] } : { frames: opts.frames },
        },
      ],
    },
  };
}

describe("computeFingerprint", () => {
  it("gives the same bug at different line numbers the same fingerprint", () => {
    const a = event({ frames: [frame({ function: "handler", lineno: 10, context_line: "computeTotal(x)" }), frame()] });
    const b = event({
      frames: [frame({ function: "handler", lineno: 40, colno: 3, context_line: "computeTotal(x)" }), frame({ lineno: 90, colno: 1 })],
    });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it("ignores whitespace changes in the context line", () => {
    const b = event({ frames: [frame({ context_line: "total+=item.price*item.quantity;" })] });
    expect(computeFingerprint(event())).toBe(computeFingerprint(b));
  });

  it("does not depend on the directory the reporter used", () => {
    const b = event({ frames: [frame({ filename: "demo-app/src/lib/Total.js" })] });
    expect(computeFingerprint(event())).toBe(computeFingerprint(b));
  });

  it("differs when the exception type differs", () => {
    expect(computeFingerprint(event({ type: "RangeError" }))).not.toBe(computeFingerprint(event()));
  });

  it("differs when the function differs", () => {
    const b = event({ frames: [frame({ function: "computeSubtotal" })] });
    expect(computeFingerprint(event())).not.toBe(computeFingerprint(b));
  });

  it("uses only in-app frames when there are any", () => {
    const lib = frame({ filename: "node_modules/express/lib/router.js", function: "next", in_app: false });
    const b = event({ frames: [lib, frame()] });
    expect(computeFingerprint(event())).toBe(computeFingerprint(b));
  });

  it("honours an explicit fingerprint override", () => {
    const a = event({ fingerprint: ["checkout-flow"] });
    const b = event({ type: "RangeError", fingerprint: ["checkout-flow"] });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(event()));
  });

  it("substitutes {{ default }} in an override", () => {
    const a = event({ fingerprint: ["{{ default }}", "tenant-a"] });
    const b = event({ fingerprint: ["{{default}}", "tenant-a"] });
    const c = event({ type: "RangeError", fingerprint: ["{{ default }}", "tenant-a"] });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(c));
  });

  it("normalises numbers, hex and UUIDs in the message when there are no frames", () => {
    const a = event({ frames: [], value: "order 1234 failed for 3f2a9c1e-0b7d-4e21-9a55-1c2d3e4f5a6b at 0xdeadbeefdeadbeef00" });
    const b = event({ frames: [], value: "order 98 failed for 00000000-1111-2222-3333-444444444444 at 0x0123456789abcdef01" });
    const c = event({ frames: [], value: "payment declined" });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(c));
  });
});
