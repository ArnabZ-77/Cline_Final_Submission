/**
 * Incident fingerprinting.
 *
 * Trap 22: line numbers must NOT contribute to the fingerprint, so an unrelated edit above
 * the crash does not make the same bug look new.
 */
import { createHash } from "node:crypto";
import type { IncidentEvent, StackFrame } from "../types.ts";

export function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/**
 * Lowercase basename. Directories are left out on purpose: they depend on the root the
 * reporter used and on the machine, and the same bug must group the same everywhere.
 */
function baseName(raw: string): string {
  const p = String(raw || "").replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1).toLowerCase();
}

/** UUIDs, long hex runs and digits are noise in a message with no stack. */
export function normaliseMessage(text: string): string {
  return String(text ?? "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b(?:0x)?[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>");
}

export function frameSignature(frame: StackFrame): string {
  const base = baseName(frame.filename || frame.abs_path || "");
  const fn = String(frame.function ?? "<anonymous>");
  const context = String(frame.context_line ?? "").replace(/\s+/g, "");
  return [frame.module ?? "", base, fn, context].join(":");
}

/**
 * Grouping frames: in-app frames closest to the throw site, newest-first, at most 8.
 * The last frame in the array is the one that threw.
 */
export function groupingFrames(frames: StackFrame[]): StackFrame[] {
  const list = Array.isArray(frames) ? frames : [];
  const inApp = list.filter((f) => f.in_app === true);
  const pool = inApp.length > 0 ? inApp : list;
  return pool.slice(-8).reverse();
}

export function defaultFingerprint(ev: IncidentEvent): string {
  const value = ev?.exception?.values?.[ev.exception.values.length - 1];
  const type = value?.type || "Error";
  const message = value?.value || "";
  const frames = value?.stacktrace?.frames ?? [];
  if (frames.length === 0) {
    return md5(normaliseMessage(`${type}: ${message}`));
  }
  const parts = [type, ...groupingFrames(frames).map(frameSignature)];
  return md5(parts.join("|"));
}

/**
 * `ev.fingerprint` overrides grouping; `{{ default }}` is substituted with the computed
 * default fingerprint.
 */
export function computeFingerprint(ev: IncidentEvent): string {
  const override = ev?.fingerprint;
  if (Array.isArray(override) && override.length > 0) {
    const fallback = defaultFingerprint(ev);
    const parts = override.map((part) =>
      String(part).replace(/\{\{\s*default\s*\}\}/g, fallback)
    );
    return md5(parts.join("|"));
  }
  return defaultFingerprint(ev);
}
