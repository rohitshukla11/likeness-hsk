/**
 * HashKey's live tool schemas against the emulator's (which follow the guide): for each tool, which of our
 * names are the same, which map to a clearly equivalent live name (the client adapts), and which are
 * missing, extra-required, ambiguous or of another type (the client stops; a person decides).
 */
import { EQUIVALENT, type ToolInfo } from "./client.js";

type Schema = ToolInfo["inputSchema"];
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const typeOf = (s: Schema | undefined) => (s ? [s.type ?? "any"].flat().join("|") : "absent");

export interface ToolDiff {
  tool: string;
  same: string[];
  adapted: { ours: string; live: string }[];
  stop: string[];
  notes: string[];
}

export function diffSchemas(live: ToolInfo[], emulator: ToolInfo[]): ToolDiff[] {
  const byName = new Map(live.map((t) => [t.name, t]));
  return emulator.map((e) => {
    const d: ToolDiff = { tool: e.name, same: [], adapted: [], stop: [], notes: [] };
    const l = byName.get(e.name);
    if (!l) {
      d.stop.push("tool missing from the live server");
      return d;
    }
    const ours = e.inputSchema.properties ?? {};
    const theirs = l.inputSchema.properties ?? {};
    const used = new Set<string>();
    for (const name of Object.keys(ours)) {
      const found = [...new Set([name, camel(name), ...(EQUIVALENT[name] ?? []), ...(EQUIVALENT[name] ?? []).map(camel)])].filter((c) => c in theirs);
      if (found.length > 1) d.stop.push(`"${name}" is ambiguous: ${found.join(", ")}`);
      else if (!found.length) d.stop.push(`"${name}" has no live counterpart`);
      else {
        const live = found[0]!;
        used.add(live);
        if (live === name) d.same.push(name);
        else d.adapted.push({ ours: name, live });
        const [a, b] = [typeOf(ours[name]), typeOf(theirs[live])];
        if (a !== b && a !== "any" && b !== "any") d.notes.push(`"${live}": type ${b} live, ${a} in the emulator (objects and JSON strings are converted; anything else stops)`);
      }
    }
    for (const r of l.inputSchema.required ?? []) if (!used.has(r)) d.stop.push(`the live schema requires "${r}", which the flow doesn't know`);
    for (const k of Object.keys(theirs)) if (!used.has(k) && !(l.inputSchema.required ?? []).includes(k)) d.notes.push(`optional live property "${k}" not used`);
    return d;
  });
}

export function diffReport(diffs: ToolDiff[]): string {
  const lines = diffs.map((d) => {
    const parts = [`${d.tool}: ${d.stop.length ? "STOP" : d.adapted.length ? "adapts" : "same"}`];
    if (d.adapted.length) parts.push(`  adapted: ${d.adapted.map((a) => `${a.ours} → ${a.live}`).join(", ")}`);
    for (const s of d.stop) parts.push(`  stop: ${s}`);
    for (const n of d.notes) parts.push(`  note: ${n}`);
    return parts.join("\n");
  });
  const stops = diffs.filter((d) => d.stop.length).length;
  return `${lines.join("\n")}\n\n${stops ? `${stops} tool(s) need a decision before anything else is called.` : "No stops: the flow can call every tool as the live schemas describe."}`;
}
