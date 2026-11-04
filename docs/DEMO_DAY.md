# Demo day: 4 Nov 2026

**The server is frozen: no deploys until 5 Nov, 05:30 IST (00:00 UTC).** Deployed 4 Nov 05:47 UTC: the VM runs the code
of `b7b9dec` (rewritten from `bf47f4f` on 4 Nov to drop a trailer: identical tree, so identical code), and the
deployed tree is that of `b1b8c6c` (was `d56b124`); demo prep raised at 05:50 UTC (on until 00:00 UTC). Backups on the VM:
`/opt/likeness/backups/before-demoday-20261104T054734Z`, `/opt/likeness/web-dist-before-20261104T054734Z`. The only changes allowed on the VM today
are the ones written below (the RPC secret and its restart before T−60, the demo prep button, and the fallback
switch). The live script is [submission/VIDEO_SCRIPT.md](submission/VIDEO_SCRIPT.md).

```sh
export CLOUDSDK_ACTIVE_CONFIG_NAME=likeness-hsk
vmssh() { gcloud compute ssh likeness-hsk-vm --zone=us-central1-a --project=likeness-hsk --tunnel-through-iap --quiet --command="$*"; }
```

## Before T−60: the dedicated RPC (optional, Rohit)

**Done, 4 Nov 06:05 UTC:** an Infura key is in the `likeness-rpc-url` secret (tested first: 4,000-block
`eth_getLogs` ranges answer), the backend restarted once (the freeze's one restart), and `/api/state` shows
`"rpc":"dedicated"`. Alchemy's free tier was tried and refused: `eth_getLogs` is limited to 10 blocks there. Rotate
both keys after the demo (they were pasted in a chat). The steps below are for reference.

Sepolia's public RPC (publicnode) is load-balanced and has lagged before. A dedicated free key avoids that.
**Provider: Infura** (MetaMask Developer, free tier): no `eth_getLogs` block-range limit (only 10,000 results per
call), which our 4,000-block log scan needs. Alchemy's free tier limits `eth_getLogs` to a handful of blocks, which
would break the dashboards' history scan. Never reuse the old, exposed Alchemy key.

1. Create a **new** Infura key, Sepolia enabled; the URL is `https://sepolia.infura.io/v3/<key>`.
2. Store it as a secret the VM can read (from the Mac, typed at the prompt, so it's not in your shell history):
   ```sh
   read -rs URL && printf %s "$URL" | gcloud secrets create likeness-rpc-url --project=likeness-hsk --data-file=- && unset URL
   gcloud secrets add-iam-policy-binding likeness-rpc-url --project=likeness-hsk \
     --member=serviceAccount:likeness-vm@likeness-hsk.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
   ```
3. Restart the backend (it reads the secret at start; a restart signs the admin out and must not happen during a
   payment): `vmssh 'sudo systemctl restart likeness && sleep 45 && systemctl is-active likeness'`
4. Check: https://hsk.likeness.site/api/state shows `"rpc":"dedicated"`. If it says `public`, the secret wasn't
   read (`vmssh 'sudo journalctl -u likeness -n 30'`); the app works as before on the public RPC.

Undo: `gcloud secrets delete likeness-rpc-url --project=likeness-hsk`, then restart. Without the secret the app
uses the public RPC.

## T−60 min: state, balances, HashKey QA

1. **State:** https://hsk.likeness.site/api/state must show `"gateway":"hsp-agentic-qa"`, `"chainId":11155111`,
   `"token":"USDC"`, `"agentic":{…"recordable":true…}`.
2. **HashKey QA answers:** `vmssh 'cd /opt/likeness/agents && sudo -u likeness -H env HSP_ALLOWLISTED=1 node_modules/.bin/tsx scripts/hsp-agentic.ts health'`
   prints `{"status":"ok"}`.
3. **Balances** (dry run, sends nothing): `cd agents && pnpm run vm sepolia-gas 0x0770C614661F5D3041d87BD2d273d534Da8Fa02E`

   | Wallet | Address | Needs | 4 Nov, 05:20 UTC |
   |---|---|---|---|
   | Brand (pays every ad) | `0x8E9B246D…4DDec` | ≥ 2 USDC, ≥ 0.01 ETH | 9.88 USDC, 0.06 ETH |
   | Creator agent (records each payment) | `0x348241F6…eCC31` | ≥ 0.01 ETH | 0.07 ETH |
   | Render agent (anchors each receipt) | `0x211b4FC6…E783F` | ≥ 0.01 ETH | 0.04 ETH |
   | Creator's own wallet (signs revokes) | `0x0770C614…Fa02E` | ≥ 0.01 ETH | 0.03 ETH (topped up 4 Nov) |
   | Executor (gas for new creators) | `0x91a72ffE…B95E5` | ≥ 0.01 ETH | 0.055 ETH |
   | Deployer (tops the others up) | `0x80Bc5b9E…85AA7` | | 0.085 ETH |

   Anything under its line: `pnpm run vm sepolia-gas 0x0770C614661F5D3041d87BD2d273d534Da8Fa02E --broadcast`
   (tops each of the creator agent, render agent and creator wallet up to 0.03 ETH). USDC comes from
   https://faucet.circle.com (Ethereum Sepolia) to the brand address.

## T−45 min: demo prep and pre-staging

1. **/admin** (demo password, in a profile that won't be on screen) → **Demo prep** → **Raise limits for today
   (UTC)**. Today: 10 images + 4 videos per brand, 20 images + 6 videos across the server, 26 paid renders,
   2.00 USDC budget. It lapses by itself at 00:00 UTC (05:30 IST on 5 Nov); **Restore normal limits now** ends it
   early. Check: `/api/state` shows `"demoPrep":{"active":true,…}` and `"cap":{"max":26,…}`.
2. **Bundle A** (for the live image): Brand → Creators → Rohit Shukla → request a bundle, 3 images, 1 video.
3. **Bundle B** (for revoke): another bundle, **2 images + 2 videos**. Make one image **and** one video now (about 9
   minutes), so both licences stay active (1/2 each): Revoke only revokes active licences, and a used-up one would
   say "Exhausted", not "Revoked". Download B's image (**Download**), and save a re-encoded copy of it (open it in Preview → Export as
   JPEG, quality changed) as the "unlicensed" file. Both on the desktop.
4. **Bundle C** (spare): one more bundle, 1 image, untouched, in case A or B goes wrong.
5. Don't revoke anything before the demo: a revoked bundle can't be used again.

## T−10 min: warm-up

Open each once (the first load after idle can take ~18 s on the e2-micro):

- https://hsk.likeness.site
- https://hsk.likeness.site/creators
- https://hsk.likeness.site/creators/0x0770c614661f5d3041d87bd2d273d534da8fa02e
- https://hsk.likeness.site/dashboard (both profiles)
- https://hsk.likeness.site/verify (drop B's image once: Licensed)
- https://hsk.likeness.site/how
- https://hsk.likeness.site/api/agents/0x0770c614661f5d3041d87bd2d273d534da8fa02e/.well-known/agent-card.json
- https://sepolia.etherscan.io/address/0x8E9B246D48C4661db6e704669674012823D4DDec

Fallback address for the same server: https://35-254-5-116.sslip.io (same pages).

## During the demo

- One payment at a time (the server refuses a second while one is paying).
- Answer each approval within its countdown (5 minutes). An expired quote is cancelled: click **Make image** again.
- **Never restart the server during a payment**: approvals and HSP polling live in the running process.
- Nothing on screen from /admin.

## Fallbacks

**1. A payment is slow** (no payment-included after 60 s, or no payment-safe after 6 minutes): keep going with the
script (Verify, creator dashboard, revoke all use bundle B), and show B's image and video from the gallery.
Say: "Sepolia is slow right now; here is one made the same way earlier today, with its payment and receipt on
Etherscan." The live payment carries on; come back to it at the end.

**2. The site is down or very slow:** play the recorded demo, downloaded beforehand so it doesn't depend on the
venue's network: `yt-dlp -o ~/Desktop/likeness-demo.mp4 https://youtu.be/fhu-Uw2wYeE` (or YouTube's own
download). Say: "The server isn't answering from here, so here's the recording of the same flow, made on the
public site."

**3. HashKey QA is down** (health check fails, or `create_order` errors): switch the backend to our offline
emulator of HSP's eight MCP tools. This is a restart, so only between payments:

```sh
vmssh 'sudo sed -i "s/^HSP_ALLOWLISTED=1$/#HSP_ALLOWLISTED=1/" /etc/likeness.env && sudo systemctl restart likeness && sleep 45 && systemctl is-active likeness'
```

`/api/state` then shows `"gateway":"hsp-agentic-emulator"`, and the status card says **HSP: offline emulator**.
The emulator broadcasts the same EIP-3009 USDC transfer on Sepolia itself (gas from the executor) instead of
HashKey. **Not rehearsed on Sepolia**: try one payment off stage first; if it fails, use fallback 2. Say:
"HashKey's QA server isn't answering, so this payment runs through our offline emulator of its MCP tools, and
the label says so. The contracts, the transfer on Sepolia and the recording are the same." Never call an
emulator payment a HashKey one.

Back to live (after the demo, or once QA answers):

```sh
vmssh 'sudo sed -i "s/^#HSP_ALLOWLISTED=1$/HSP_ALLOWLISTED=1/" /etc/likeness.env && sudo systemctl restart likeness && sleep 45 && systemctl is-active likeness'
```

**4. A payment got stuck after a restart** (paid on Sepolia, not recorded): `pnpm run recover` records it
afterwards (docs/HSP_LIVE_RUN.md); not on stage.

## After the demo

Restore normal limits (/admin → Demo prep → Restore), or let them lapse at 05:30 IST. Deploys can start again on 5 Nov.
