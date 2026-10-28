import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";

/** Rendered files on local disk (gitignored `renders/`), keyed by their sha256. */
export class RenderStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private paths(hash: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("bad hash");
    const base = join(this.dir, hash.toLowerCase());
    return { file: `${base}.bin`, meta: `${base}.json` };
  }

  save(hash: Hex, bytes: Uint8Array, meta: { mime: string; licenceId: string; renderIndex: number }) {
    const p = this.paths(hash);
    writeFileSync(p.file, bytes);
    writeFileSync(p.meta, JSON.stringify(meta));
  }

  read(hash: Hex): { bytes: Buffer; mime: string } | undefined {
    const p = this.paths(hash);
    if (!existsSync(p.file)) return undefined;
    const meta = JSON.parse(readFileSync(p.meta, "utf8")) as { mime: string };
    return { bytes: readFileSync(p.file), mime: meta.mime };
  }
}
