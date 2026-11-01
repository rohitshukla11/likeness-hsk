/**
 * Licence bundles: a brand asks once (one brief, one duration, N images and M videos) and gets one
 * licence per media type on chain, issued in sequence: images at the creator's price, videos at
 * VIDEO_MULTIPLIER times it. The contracts are unchanged; the bundle exists only in this app's
 * database. If the second licence fails, the bundle is partially issued and can be retried. Licences
 * taken before bundles existed are shown as one-type bundles ("L<id>").
 */
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { usdValue } from "../hsp/cart.js";
import type { AdKind, Bundle } from "./accounts.js";
import { ADVERTISING, listLicences, VIDEO_MULTIPLIER, type Runtime } from "./runtime.js";

export const KINDS: AdKind[] = ["image", "video"];
export const newBundleId = () => `B${randomBytes(6).toString("hex")}`;

/** Issues the bundle's missing licences in order; stops at the first failure (the bundle stays partial). */
export async function issueBundle(rt: Runtime, b: Bundle): Promise<{ bundle: Bundle; error?: string }> {
  for (const kind of KINDS) {
    const count = kind === "video" ? b.videos : b.images;
    if (!count || (kind === "video" ? b.videoLicence : b.imageLicence)) continue;
    try {
      const conn = await rt.connectTo(b.creator as Address);
      const id = await rt.brand.license(conn, {
        category: ADVERTISING,
        regions: 1,
        durationSeconds: BigInt(b.duration),
        renderCap: count,
        purpose: `${kind} ad: ${b.brief}`,
        priceMultiplier: kind === "video" ? VIDEO_MULTIPLIER : 1n,
      });
      rt.accounts.setBundleLicence(b.id, kind, id.toString());
      rt.accounts.recordLicence(id.toString(), b.uid, b.creator);
      rt.accounts.setLicenceMeta(id.toString(), kind, b.brief);
    } catch (e) {
      return { bundle: rt.accounts.bundle(b.id)!, error: `the ${kind} licence wasn't issued: ${(e as Error).message.split("\n")[0]}` };
    }
  }
  return { bundle: rt.accounts.bundle(b.id)! };
}

type Slot = { licenceId: string; status: string; used: number; cap: number; price: string; pricePerRender: string; end: number } | null;

async function slot(rt: Runtime, licenceId: string | null): Promise<Slot> {
  if (!licenceId) return null;
  const [l, status] = await Promise.all([rt.chain.licence(BigInt(licenceId)), rt.chain.status(BigInt(licenceId))]);
  return { licenceId, status, used: l.renderCount, cap: l.renderCap, price: usdValue(l.pricePerRender), pricePerRender: l.pricePerRender.toString(), end: Number(l.end) };
}

/** A bundle as the dashboards show it: both licences with their on-chain counters and status. */
export async function bundleView(rt: Runtime, b: Bundle) {
  const [image, video] = await Promise.all([slot(rt, b.imageLicence), slot(rt, b.videoLicence)]);
  const live = [image, video].filter(Boolean) as NonNullable<Slot>[];
  return {
    id: b.id,
    legacy: b.id.startsWith("L"),
    creator: b.creator,
    creatorName: rt.accounts.creatorByAddress(b.creator)?.name ?? null,
    brand: rt.accounts.account(b.uid)?.name ?? null,
    brief: b.brief,
    wanted: { images: b.images, videos: b.videos },
    image,
    video,
    partial: (b.images > 0 && !image) || (b.videos > 0 && !video),
    status: live.some((s) => s.status === "Revoked") ? "Revoked" : live.some((s) => s.status === "Active") ? "Active" : (live[0]?.status ?? "Pending"),
    createdAt: b.createdAt,
  };
}

/** A licence taken before bundles, as a one-type bundle. */
function legacy(rt: Runtime, l: { id: string; creator: string }): Bundle {
  const meta = rt.accounts.licenceMeta(l.id);
  const kind = meta?.kind ?? "image";
  return {
    id: `L${l.id}`,
    uid: rt.accounts.licenceOwner(l.id) ?? "operator",
    creator: l.creator,
    brief: meta?.brief ?? "",
    images: kind === "image" ? 1 : 0,
    videos: kind === "video" ? 1 : 0,
    duration: 0,
    imageLicence: kind === "image" ? l.id : null,
    videoLicence: kind === "video" ? l.id : null,
    createdAt: 0,
  };
}

/**
 * Bundles for a dashboard: a brand account's own (or, for the operator, every bundle and every licence of
 * the shared agent wallet); a creator's (their likeness, bundles and older licences).
 */
export async function listBundles(rt: Runtime, by: { uid?: string; creator?: Address; operator?: boolean }) {
  const bundles = by.uid ? rt.accounts.bundles({ uid: by.uid }) : by.creator ? rt.accounts.bundles({ creator: by.creator }) : rt.accounts.bundles();
  const inBundles = new Set(rt.accounts.bundles().flatMap((b) => [b.imageLicence, b.videoLicence].filter(Boolean) as string[]));
  const older = by.creator ? await listLicences(rt, { creator: by.creator }) : by.operator ? await listLicences(rt, { licensee: rt.brandAddress }) : [];
  const owned = by.uid ? rt.accounts.licencesOf(by.uid) : undefined;
  const legacies = older.filter((l) => !inBundles.has(l.id) && (!owned || owned.has(l.id))).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).map((l) => legacy(rt, l));
  if (by.uid) {
    // A signed-in brand's own older single licences (taken before bundles), from the app's records.
    const mine = (await listLicences(rt, { licensee: rt.brandAddress })).filter((l) => owned!.has(l.id) && !inBundles.has(l.id));
    legacies.push(...mine.map((l) => legacy(rt, l)));
  }
  return Promise.all([...bundles, ...legacies].map((b) => bundleView(rt, b)));
}

/** A bundle by id, including older licences addressed as "L<id>". */
export async function findBundle(rt: Runtime, id: string): Promise<Bundle | undefined> {
  if (!id.startsWith("L")) return rt.accounts.bundle(id);
  const licenceId = id.slice(1);
  if (!/^\d+$/.test(licenceId)) return undefined;
  const l = await rt.chain.licence(BigInt(licenceId));
  if (/^0x0{40}$/i.test(l.creator)) return undefined;
  return legacy(rt, { id: licenceId, creator: l.creator });
}

/** Revokes every active licence of the bundle, one transaction each, signed as the creator. */
export async function revokeBundle(rt: Runtime, b: Bundle, revoke: (licenceId: bigint) => Promise<Hex>) {
  const txs: { kind: AdKind; licenceId: string; tx: Hex }[] = [];
  for (const kind of KINDS) {
    const id = kind === "video" ? b.videoLicence : b.imageLicence;
    if (!id || (await rt.chain.status(BigInt(id))) !== "Active") continue;
    txs.push({ kind, licenceId: id, tx: await revoke(BigInt(id)) });
  }
  return txs;
}
