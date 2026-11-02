/**
 * Accounts on this server (Google sign-in through Firebase Auth): the role each chose, the creators'
 * YouTube channel, photo and custodial testnet wallet, which brand account took which licence, and paid
 * renders per brand account per UTC day. SQLite on the server's own disk (node:sqlite); nothing billable.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "brand" | "creator";

export interface Account {
  uid: string;
  email: string;
  name: string;
  picture: string | null;
  role: Role | null;
}

export interface CreatorRow {
  uid: string;
  address: string;
  name: string;
  youtubeChannelId: string | null;
  youtubeTitle: string | null;
  youtubeThumbnail: string | null;
  youtubeVerifiedAt: number | null;
  photoFile: string | null;
  photoMime: string | null;
  photoSha256: string | null;
  consentAt: number | null;
  payout: string | null;
  registeredTx: string | null;
  agentTx: string | null;
  /** "local test" for creators registered from a developer's machine; null on the public server. */
  label: string | null;
}

const SCHEMA = `
create table if not exists accounts (
  uid text primary key, email text not null, name text not null, picture text, role text, created_at integer not null
);
create table if not exists creators (
  uid text primary key references accounts(uid), address text not null unique, name text not null,
  youtube_channel_id text unique, youtube_title text, youtube_thumbnail text, youtube_verified_at integer,
  photo_file text, photo_mime text, photo_sha256 text, consent_at integer,
  payout text, registered_tx text, agent_tx text, label text, created_at integer not null
);
create table if not exists licences (licence_id text primary key, uid text not null, creator text not null, created_at integer not null);
create table if not exists brand_paid (uid text not null, day text not null, paid integer not null, primary key (uid, day));
create table if not exists licence_meta (licence_id text primary key, kind text not null, brief text not null);
create table if not exists ai_usage (day text not null, uid text not null, kind text not null, n integer not null, primary key (day, uid, kind));
create table if not exists bundles (
  id text primary key, uid text not null, creator text not null, brief text not null, images integer not null, videos integer not null,
  duration integer not null, image_licence text, video_licence text, created_at integer not null
);
create table if not exists meta (key text primary key, value text not null);
create table if not exists renders (
  asset_hash text primary key, licence_id text not null, render_index integer not null, kind text not null, mime text not null,
  size integer not null, prompt text, prompt_sha256 text, model text, note text, uid text not null, creator text not null,
  bundle_id text, hsp_tx text, anchor_tx text, created_at integer not null
);
`;

/** A delivered render: the file (on disk, keyed by its sha256) and what made it, including the exact prompt. */
export interface RenderRecord {
  assetHash: string;
  licenceId: string;
  renderIndex: number;
  kind: AdKind;
  mime: string;
  size: number;
  prompt: string | null;
  promptSha256: string | null;
  model: string | null;
  note: string | null;
  uid: string;
  creator: string;
  bundleId: string | null;
  hspTx: string | null;
  anchorTx: string | null;
  createdAt: number;
}

const RENDER_COLS: Record<keyof RenderRecord, string> = {
  assetHash: "asset_hash",
  licenceId: "licence_id",
  renderIndex: "render_index",
  kind: "kind",
  mime: "mime",
  size: "size",
  prompt: "prompt",
  promptSha256: "prompt_sha256",
  model: "model",
  note: "note",
  uid: "uid",
  creator: "creator",
  bundleId: "bundle_id",
  hspTx: "hsp_tx",
  anchorTx: "anchor_tx",
  createdAt: "created_at",
};

/**
 * A licence bundle: what a brand asked for in one request (one brief, one duration, a number of images and
 * of videos). On chain it is one licence per media type: images at the creator's price, videos at
 * VIDEO_MULTIPLIER times it; a count of 0 means no licence of that type.
 */
export interface Bundle {
  id: string;
  uid: string;
  creator: string;
  brief: string;
  images: number;
  videos: number;
  duration: number;
  imageLicence: string | null;
  videoLicence: string | null;
  createdAt: number;
}

export type AdKind = "image" | "video";
/** The uid under which ai_usage counts every brand account together (the server-wide caps). */
export const SITE = "*";

const COLS: Record<keyof CreatorRow, string> = {
  uid: "uid",
  address: "address",
  name: "name",
  youtubeChannelId: "youtube_channel_id",
  youtubeTitle: "youtube_title",
  youtubeThumbnail: "youtube_thumbnail",
  youtubeVerifiedAt: "youtube_verified_at",
  photoFile: "photo_file",
  photoMime: "photo_mime",
  photoSha256: "photo_sha256",
  consentAt: "consent_at",
  payout: "payout",
  registeredTx: "registered_tx",
  agentTx: "agent_tx",
  label: "label",
};

const today = () => new Date().toISOString().slice(0, 10);

export class Accounts {
  private readonly db: DatabaseSync;

  /** file: a path on disk, or ":memory:" (the local devnet starts a fresh chain each run). */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
  }

  /** The account for a verified Google sign-in, created on first sign-in; name and photo kept current. */
  upsert(u: { uid: string; email: string; name: string; picture: string | null }): Account {
    this.db
      .prepare("insert into accounts (uid, email, name, picture, created_at) values (?, ?, ?, ?, ?) on conflict(uid) do update set email = excluded.email, name = excluded.name, picture = excluded.picture")
      .run(u.uid, u.email, u.name, u.picture, Date.now());
    return this.account(u.uid)!;
  }

  account(uid: string): Account | undefined {
    const r = this.db.prepare("select uid, email, name, picture, role from accounts where uid = ?").get(uid) as Account | undefined;
    return r ? { ...r } : undefined;
  }

  /** A role is chosen once; an account is a brand or a creator, not both. */
  setRole(uid: string, role: Role): Account {
    const a = this.account(uid);
    if (!a) throw new Error("no such account");
    if (a.role && a.role !== role) throw new Error(`this account is already a ${a.role}`);
    this.db.prepare("update accounts set role = ? where uid = ?").run(role, uid);
    return { ...a, role };
  }

  // ---------------------------------------------------------------- creators

  createCreator(uid: string, address: string, name: string, label: string | null) {
    this.db.prepare("insert into creators (uid, address, name, label, created_at) values (?, ?, ?, ?, ?)").run(uid, address, name, label, Date.now());
    return this.creator(uid)!;
  }

  updateCreator(uid: string, patch: Partial<Omit<CreatorRow, "uid" | "address">>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return this.creator(uid)!;
    this.db.prepare(`update creators set ${keys.map((k) => `${COLS[k]} = ?`).join(", ")} where uid = ?`).run(...keys.map((k) => patch[k] ?? null), uid);
    return this.creator(uid)!;
  }

  creator(uid: string): CreatorRow | undefined {
    return this.row(this.db.prepare("select * from creators where uid = ?").get(uid));
  }

  creatorByAddress(address: string): CreatorRow | undefined {
    return this.row(this.db.prepare("select * from creators where lower(address) = lower(?)").get(address));
  }

  creatorByChannel(channelId: string): CreatorRow | undefined {
    return this.row(this.db.prepare("select * from creators where youtube_channel_id = ?").get(channelId));
  }

  /** Creators registered on chain, newest first. */
  registeredCreators(): CreatorRow[] {
    return (this.db.prepare("select * from creators where registered_tx is not null order by created_at desc").all() as Record<string, unknown>[]).map((r) => this.row(r)!);
  }

  private row(r: unknown): CreatorRow | undefined {
    if (!r) return undefined;
    const o = r as Record<string, unknown>;
    return Object.fromEntries(Object.entries(COLS).map(([k, c]) => [k, o[c] ?? null])) as unknown as CreatorRow;
  }

  // ---------------------------------------------------------------- brand accounts

  recordLicence(licenceId: string, uid: string, creator: string) {
    this.db.prepare("insert or ignore into licences (licence_id, uid, creator, created_at) values (?, ?, ?, ?)").run(licenceId, uid, creator, Date.now());
  }

  /** The brand account that took a licence (they share the demo agent wallet on chain). */
  licenceOwner(licenceId: string): string | undefined {
    return (this.db.prepare("select uid from licences where licence_id = ?").get(licenceId) as { uid: string } | undefined)?.uid;
  }

  licencesOf(uid: string): Set<string> {
    return new Set((this.db.prepare("select licence_id from licences where uid = ?").all(uid) as { licence_id: string }[]).map((r) => r.licence_id));
  }

  paidToday(uid: string): number {
    return (this.db.prepare("select paid from brand_paid where uid = ? and day = ?").get(uid, today()) as { paid: number } | undefined)?.paid ?? 0;
  }

  addPaid(uid: string) {
    this.db.prepare("insert into brand_paid (uid, day, paid) values (?, ?, 1) on conflict(uid, day) do update set paid = paid + 1").run(uid, today());
  }

  /** What a licence was taken for: image or video ads, and the brand's brief. */
  setLicenceMeta(licenceId: string, kind: AdKind, brief: string) {
    this.db.prepare("insert into licence_meta (licence_id, kind, brief) values (?, ?, ?) on conflict(licence_id) do update set kind = excluded.kind, brief = excluded.brief").run(licenceId, kind, brief);
  }

  licenceMeta(licenceId: string): { kind: AdKind; brief: string } | undefined {
    const r = this.db.prepare("select kind, brief from licence_meta where licence_id = ?").get(licenceId) as { kind: AdKind; brief: string } | undefined;
    return r ? { ...r } : undefined;
  }

  /** AI ads handed to HSP today (UTC), for one brand account or SITE. */
  aiUsed(uid: string, kind: AdKind): number {
    return (this.db.prepare("select n from ai_usage where day = ? and uid = ? and kind = ?").get(today(), uid, kind) as { n: number } | undefined)?.n ?? 0;
  }

  addAiUse(uid: string, kind: AdKind) {
    const add = this.db.prepare("insert into ai_usage (day, uid, kind, n) values (?, ?, ?, 1) on conflict(day, uid, kind) do update set n = n + 1");
    add.run(today(), uid, kind);
    if (uid !== SITE) add.run(today(), SITE, kind);
  }

  createBundle(b: Omit<Bundle, "imageLicence" | "videoLicence" | "createdAt">): Bundle {
    this.db.prepare("insert into bundles (id, uid, creator, brief, images, videos, duration, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)").run(b.id, b.uid, b.creator, b.brief, b.images, b.videos, b.duration, Date.now());
    return this.bundle(b.id)!;
  }

  setBundleLicence(id: string, kind: AdKind, licenceId: string) {
    this.db.prepare(`update bundles set ${kind === "video" ? "video_licence" : "image_licence"} = ? where id = ?`).run(licenceId, id);
  }

  bundle(id: string): Bundle | undefined {
    return this.bundleRow(this.db.prepare("select * from bundles where id = ?").get(id));
  }

  bundleOfLicence(licenceId: string): Bundle | undefined {
    return this.bundleRow(this.db.prepare("select * from bundles where image_licence = ? or video_licence = ?").get(licenceId, licenceId));
  }

  /** Newest first: one brand account's bundles, one creator's, or all. */
  bundles(by: { uid?: string; creator?: string } = {}): Bundle[] {
    const rows = by.uid
      ? this.db.prepare("select * from bundles where uid = ? order by created_at desc").all(by.uid)
      : by.creator
        ? this.db.prepare("select * from bundles where lower(creator) = lower(?) order by created_at desc").all(by.creator)
        : this.db.prepare("select * from bundles order by created_at desc").all();
    return rows.map((r) => this.bundleRow(r)!);
  }

  private bundleRow(r: unknown): Bundle | undefined {
    if (!r) return undefined;
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id),
      uid: String(o.uid),
      creator: String(o.creator),
      brief: String(o.brief),
      images: Number(o.images),
      videos: Number(o.videos),
      duration: Number(o.duration),
      imageLicence: (o.image_licence as string | null) ?? null,
      videoLicence: (o.video_licence as string | null) ?? null,
      createdAt: Number(o.created_at),
    };
  }

  saveRender(r: RenderRecord) {
    const keys = Object.keys(RENDER_COLS) as (keyof RenderRecord)[];
    this.db
      .prepare(`insert or replace into renders (${keys.map((k) => RENDER_COLS[k]).join(", ")}) values (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => (r[k] ?? null) as string | number | null));
  }

  render(assetHash: string): RenderRecord | undefined {
    const r = this.db.prepare("select * from renders where lower(asset_hash) = lower(?)").get(assetHash);
    if (r || !this.hasTable("archived_renders")) return this.renderRow(r);
    // A render made under a previous deployment: its record (prompt, model) stays readable for Verify.
    return this.renderRow(this.db.prepare("select * from archived_renders where lower(asset_hash) = lower(?)").get(assetHash));
  }

  private hasTable(name: string): boolean {
    return !!this.db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
  }

  /**
   * The app's records are tied to one LicenseRegistry (licence ids start again on a new one). When the
   * deployment changes, its licences, bundles and render records move to archived_* tables, tagged with
   * the registry they belonged to; accounts, creators and today's caps stay. Switching back to an earlier
   * registry (a rollback) brings its archived records back. Returns the rows moved out.
   */
  ensureDeployment(licences: string): number {
    const cur = (this.db.prepare("select value from meta where key = 'licences'").get() as { value: string } | undefined)?.value;
    if (cur?.toLowerCase() === licences.toLowerCase()) return 0;
    let moved = 0;
    this.db.exec("begin");
    try {
      for (const t of ["licences", "licence_meta", "bundles", "renders"]) {
        if (cur) {
          this.db.exec(`create table if not exists archived_${t} as select '' as deployment, * from ${t} where 0`);
          moved += Number(this.db.prepare(`insert into archived_${t} select ?, * from ${t}`).run(cur).changes);
          this.db.exec(`delete from ${t}`);
        }
        if (this.db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(`archived_${t}`)) {
          const cols = (this.db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
          this.db.prepare(`insert into ${t} (${cols}) select ${cols} from archived_${t} where lower(deployment) = lower(?)`).run(licences);
          this.db.prepare(`delete from archived_${t} where lower(deployment) = lower(?)`).run(licences);
        }
      }
      this.db.prepare("insert into meta (key, value) values ('licences', ?) on conflict(key) do update set value = excluded.value").run(licences);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    return moved;
  }

  /** Newest first: a brand account's renders, a creator's (their likeness), or all. */
  renders(by: { uid?: string; creator?: string } = {}): RenderRecord[] {
    const rows = by.uid
      ? this.db.prepare("select * from renders where uid = ? order by created_at desc").all(by.uid)
      : by.creator
        ? this.db.prepare("select * from renders where lower(creator) = lower(?) order by created_at desc").all(by.creator)
        : this.db.prepare("select * from renders order by created_at desc").all();
    return rows.map((r) => this.renderRow(r)!);
  }

  private renderRow(r: unknown): RenderRecord | undefined {
    if (!r) return undefined;
    const o = r as Record<string, unknown>;
    return Object.fromEntries(Object.entries(RENDER_COLS).map(([k, c]) => [k, o[c] ?? null])) as unknown as RenderRecord;
  }

  close() {
    this.db.close();
  }
}
