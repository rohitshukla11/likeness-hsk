/**
 * Creator onboarding for signed-in accounts: the YouTube channel (checked by this server with the
 * account's own youtube.readonly token, which is never stored), the photo shown publicly (only with the
 * creator's explicit consent), and a custodial TESTNET wallet that registers the creator's terms on
 * CreatorRegistry with this platform's attestation and names the shared creator agent in HspSettlement.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, keccak256, nonceManager, parseEther, stringToHex, toBytes, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { creatorRegistryAbi, hspSettlementAbi, licenseRegistryAbi, type Likeness } from "../chain/contracts.js";
import { decryptKeystore, encryptKeystore } from "../keys.js";
import type { MessageLog } from "../log.js";
import type { Accounts, CreatorRow } from "./accounts.js";

export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
/**
 * Test HSK a new creator wallet gets: registering uses about 0.00027 and naming the agent about 0.00005
 * (at 1 gwei), so 0.001 leaves room for several revokes.
 */
export const CREATOR_GAS = parseEther(process.env.LIKENESS_CREATOR_GAS ?? "0.001"); // LIKENESS_CREATOR_GAS: more where gas can spike (Sepolia)

export class OnboardingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Channel {
  id: string;
  title: string;
  thumbnail: string | null;
}

/**
 * The signed-in account's own YouTube channel: the access token must belong to the same Google account
 * (tokeninfo's email), then channels.list mine=true. Only the channel id, title and thumbnail are kept.
 */
export async function youtubeChannel(accessToken: string, email: string, fetchFn: typeof fetch = fetch): Promise<Channel> {
  const info = (await (await fetchFn(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`)).json()) as { email?: string; scope?: string; error_description?: string };
  if (!info.email) throw new OnboardingError(401, `Google didn't accept the YouTube token${info.error_description ? `: ${info.error_description}` : ""}`);
  if (info.email.toLowerCase() !== email.toLowerCase()) throw new OnboardingError(403, "connect the YouTube channel of the Google account you signed in with");
  if (!info.scope?.split(" ").includes("https://www.googleapis.com/auth/youtube.readonly")) throw new OnboardingError(403, "YouTube read access wasn't granted");
  const res = await fetchFn("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { authorization: `Bearer ${accessToken}` } });
  const body = (await res.json()) as { items?: { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> } }[]; error?: { message?: string } };
  if (!res.ok) throw new OnboardingError(502, `YouTube: ${body.error?.message ?? `HTTP ${res.status}`}`);
  const ch = body.items?.[0];
  if (!ch) throw new OnboardingError(404, "this Google account has no YouTube channel");
  const t = ch.snippet?.thumbnails ?? {};
  return { id: ch.id, title: ch.snippet?.title ?? ch.id, thumbnail: t.high?.url ?? t.medium?.url ?? t.default?.url ?? null };
}

/** JPEG, PNG or WebP by their magic bytes; anything else is refused. */
export function photoType(b: Buffer): { mime: string; ext: string } | undefined {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return undefined;
}

/** Drops a JPEG's APP1 (EXIF/XMP, which can hold GPS and the camera) and comment segments. */
export function stripJpegMetadata(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = b.readUInt16BE(i + 2);
    if (marker !== 0xe1 && marker !== 0xfe) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  out.push(b.subarray(i));
  return Buffer.concat(out);
}

export interface TermsInput {
  priceUnits: bigint; // token base units (6 decimals)
  categories: number; // CreatorRegistry category bits
  maxRenders: number;
  payout?: Address;
}

export interface OnboardingConfig {
  accounts: Accounts;
  chain: Likeness;
  log: MessageLog;
  /** Signs creator attestations (CreatorRegistry.attester). */
  attester?: LocalAccount;
  /** Sends each new creator wallet its test HSK for gas. */
  funder: LocalAccount;
  /** The shared creator agent every creator names in HspSettlement.setAgent. */
  creatorAgent: Address;
  /** Ana Reyes, whose regions and maximum duration new creators start from. */
  templateCreator: Address;
  keysDir: string;
  photosDir: string;
  keystorePassword: string;
  /** "local test" when run on a developer's machine; null on the public server. */
  label: string | null;
}

export class Onboarding {
  private readonly wallets = new Map<string, LocalAccount>();

  constructor(private readonly c: OnboardingConfig) {
    mkdirSync(c.keysDir, { recursive: true, mode: 0o700 });
    mkdirSync(c.photosDir, { recursive: true });
  }

  get label() {
    return this.c.label;
  }

  /** The creator row, with a new custodial testnet wallet the first time. */
  start(uid: string, name: string): CreatorRow {
    const existing = this.c.accounts.creator(uid);
    if (existing) return existing;
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk, { nonceManager });
    writeFileSync(this.keyFile(account.address), encryptKeystore(pk, this.c.keystorePassword), { mode: 0o600 });
    this.wallets.set(account.address.toLowerCase(), account);
    this.c.log.add("chain", "info", `new custodial testnet wallet for creator ${account.address}`);
    return this.c.accounts.createCreator(uid, account.address, name, this.c.label);
  }

  async connectYoutube(uid: string, channel: Channel) {
    const other = this.c.accounts.creatorByChannel(channel.id);
    if (other && other.uid !== uid) throw new OnboardingError(409, "this YouTube channel is already connected to another account");
    return this.c.accounts.updateCreator(uid, { youtubeChannelId: channel.id, youtubeTitle: channel.title, youtubeThumbnail: channel.thumbnail, youtubeVerifiedAt: Date.now() });
  }

  savePhoto(uid: string, bytes: Buffer, consent: boolean) {
    if (!consent) throw new OnboardingError(400, "tick the consent box to show this photo publicly");
    if (bytes.length > PHOTO_MAX_BYTES) throw new OnboardingError(413, "the photo is larger than 3 MB");
    const t = photoType(bytes);
    if (!t) throw new OnboardingError(415, "use a JPEG, PNG or WebP photo");
    const row = this.c.accounts.creator(uid)!;
    const clean = t.mime === "image/jpeg" ? stripJpegMetadata(bytes) : bytes;
    const file = `${row.address.toLowerCase()}.${t.ext}`;
    writeFileSync(join(this.c.photosDir, file), clean);
    const sha = `0x${createHash("sha256").update(clean).digest("hex")}`;
    return this.c.accounts.updateCreator(uid, { photoFile: file, photoMime: t.mime, photoSha256: sha, consentAt: Date.now() });
  }

  photo(row: CreatorRow): { bytes: Buffer; mime: string } | undefined {
    if (!row.photoFile || !row.photoMime) return undefined;
    const p = join(this.c.photosDir, row.photoFile);
    return existsSync(p) ? { bytes: readFileSync(p), mime: row.photoMime } : undefined;
  }

  /**
   * Register on chain: fund the wallet with test HSK if it needs it, the platform attests the YouTube
   * check and the creator's own age declaration, the wallet registers its terms and names the agent.
   */
  async register(uid: string, terms: TermsInput, adult: boolean) {
    const row = this.c.accounts.creator(uid);
    if (!row) throw new OnboardingError(409, "start creator onboarding first");
    if (row.registeredTx && row.agentTx) throw new OnboardingError(409, "already registered");
    if (!row.youtubeChannelId) throw new OnboardingError(409, "connect your YouTube channel first");
    if (!row.photoSha256) throw new OnboardingError(409, "add your photo first");
    if (!adult) throw new OnboardingError(400, "creators must be 18 or older");
    if (!this.c.attester) throw new OnboardingError(503, "this server has no attester key: creators can't be registered here");
    const ch = this.c.chain;
    const me = this.wallet(row.address as Address);
    try {
      if (!row.registeredTx) await this.registerTerms(uid, row, me, terms);
      // Names the shared creator agent (also on a retry, if registering went through and this didn't).
      const agent = await ch.write(me, { address: ch.d.settlement, abi: hspSettlementAbi, functionName: "setAgent", args: [this.c.creatorAgent] });
      this.c.log.add("chain", "tx", `creator ${me.address} named the creator agent`, { tx: agent.transactionHash });
      return this.c.accounts.updateCreator(uid, { agentTx: agent.transactionHash });
    } catch (e) {
      // A failed send may have used a nonce locally: count again from the chain on the next try.
      nonceManager.reset({ address: me.address, chainId: ch.d.chainId });
      throw e;
    }
  }

  private async registerTerms(uid: string, row: CreatorRow, me: LocalAccount, terms: TermsInput) {
    const ch = this.c.chain;
    const balance = await ch.public.getBalance({ address: me.address });
    if (balance < CREATOR_GAS / 2n) {
      const hash = await ch.wallet(this.c.funder).sendTransaction({ to: me.address, value: CREATOR_GAS - balance } as never);
      await ch.public.waitForTransactionReceipt({ hash });
      await ch.counted(this.c.funder.address, hash);
      this.c.log.add("chain", "tx", `funded creator wallet ${me.address} with ${formatEther(CREATOR_GAS - balance)} test ${ch.d.chainId === 11155111 ? "ETH" : "HSK"}`, { tx: hash });
      // A load-balanced RPC can answer from a node that hasn't seen the funding yet: wait until it shows.
      for (let i = 0; i < 40 && (await ch.public.getBalance({ address: me.address, blockTag: "latest" })) < CREATOR_GAS / 2n; i++) await new Promise((r) => setTimeout(r, 500));
    }

    const template = await ch.terms(this.c.templateCreator);
    const attestation = {
      referenceSetHash: row.photoSha256 as Hex, // the consented public photo
      livenessSessionHash: keccak256(toBytes(`youtube:${row.youtubeChannelId}`)),
      livenessProvider: stringToHex("google-youtube-channel", { size: 32 }),
      ageProvider: stringToHex("self-declared-18+", { size: 32 }),
      verifiedAt: BigInt(Math.floor((row.youtubeVerifiedAt ?? Date.now()) / 1000)),
      adult: true,
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const nonce = await ch.public.readContract({ address: ch.d.creators, abi: creatorRegistryAbi, functionName: "attestationNonce", args: [me.address] });
    const digest = await ch.public.readContract({ address: ch.d.creators, abi: creatorRegistryAbi, functionName: "attestationDigest", args: [me.address, attestation, nonce, deadline] });
    const sig = await this.c.attester!.sign!({ hash: digest }); // checked in register()
    const payout = terms.payout ?? me.address;
    const reg = await ch.write(me, {
      address: ch.d.creators,
      abi: creatorRegistryAbi,
      functionName: "register",
      args: [payout, attestation, deadline, sig, { categories: terms.categories, regions: template.regions, maxDuration: template.maxDuration, maxRenders: terms.maxRenders, pricePerRender: terms.priceUnits, autoApprove: true }],
    });
    this.c.log.add("chain", "tx", `creator ${me.address} registered (YouTube ${row.youtubeTitle})`, { tx: reg.transactionHash });
    this.c.accounts.updateCreator(uid, { registeredTx: reg.transactionHash, payout });
  }

  /** Revokes one of this creator's own licences, signed by the creator's wallet. */
  async revoke(row: CreatorRow, licenceId: bigint): Promise<Hex> {
    const ch = this.c.chain;
    const l = await ch.licence(licenceId);
    if (l.creator.toLowerCase() !== row.address.toLowerCase()) throw new OnboardingError(403, "you can only revoke licences of your own likeness");
    const r = await ch.write(this.wallet(row.address as Address), { address: ch.d.licences, abi: licenseRegistryAbi, functionName: "revoke", args: [licenceId] });
    this.c.log.add("chain", "tx", `creator revoked licence ${licenceId}`, { tx: r.transactionHash });
    return r.transactionHash;
  }

  private keyFile(address: Address) {
    return join(this.c.keysDir, `${address.toLowerCase()}.json`);
  }

  private wallet(address: Address): LocalAccount {
    const k = address.toLowerCase();
    let a = this.wallets.get(k);
    if (!a) {
      a = privateKeyToAccount(decryptKeystore(readFileSync(this.keyFile(address), "utf8"), this.c.keystorePassword), { nonceManager });
      this.wallets.set(k, a);
    }
    return a;
  }
}
