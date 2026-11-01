# Going live on HashKey QA with USDC (HSK Chain testnet)

Prepared on 1 November; run only after HashKey's USDC reaches the server's brand wallet and Rohit says
**"go live"**. Until then the public site stays on the offline MCP emulator.

**What changes:** HSP Agentic Payment on HashKey's QA server pays in **USDC
`0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6`** (6 decimals, EIP-3009, EIP-712 domain "USD Coin" version "2",
read from `get_chain_config` and from the token itself). HspSettlement fixes its token at deployment, and
LicenseRegistry and ReceiptAnchor accept their settlement contract only once, so those three are deployed
again for USDC. **Kept:** CreatorRegistry (every creator's registration and terms, and the server's attester
`0xCaCd…6B8f`) and the Safe, which takes ownership of the new contracts.

**Reset on the public site:** licence ids start again at 1, so the app's licences, bundles and render records
move to `archived_*` tables when the backend starts on the new deployment (automatic; accounts, creators and
today's caps stay). Earlier files still verify: Verify falls back to the replaced contracts
(`previousDeployments` in `deployments/testnet.json`) and says "previous deployment". Each creator names the
creator agent again on the new HspSettlement (one transaction each).

| | Step | Time |
|---|---|---|
| 0 | USDC arrived | 2 min |
| 1 | Redeploy (dry run, Rohit's OK, broadcast) | 10 min |
| 2 | Blockscout verification | 5 min |
| 3 | Safe handover | 5 min |
| 4 | The server's own creator and render agent | 5 min |
| 5 | Deployment file and environment on the server | 5 min |
| 6 | Creators onboarded on the server name their agent | 5 min |
| 7 | Smoke test | 5 min |
| 8 | First live image, then video | 20 min |

About **1 hour**. Every step that sends a transaction is shown as a dry run first.

**0. USDC arrived** (read-only)

```sh
cast call 0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6 "balanceOf(address)(uint256)" 0x8E9B246D48C4661db6e704669674012823D4DDec --rpc-url https://testnet.hsk.xyz
```
At least 1000000 (1 USDC). No approval transaction: each payment is an EIP-3009 authorization signed after
the two approvals in the brand console.

**1. Redeploy for USDC** (Mac, from `agents/`)

```sh
export HSP_CHAIN_ID=133 HSP_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6
export RENDER_AGENTS=0x211b4FC6f1aC695173Dc217044b26380a78E783F,0xd266CB9Edc93E722655Dc435B375e72Afa183586   # the server's, this Mac's
pnpm run deploy -- --network testnet --hsp-token              # dry run: ≈ 6.1M gas ≈ 0.0061 test HSK (1 Nov)
pnpm run deploy -- --network testnet --hsp-token --broadcast  # after Rohit's OK
```
Writes `deployments/testnet.json` (the previous one is kept as a dated copy and in `previousDeployments`).

**2. Blockscout**: `pnpm run verify -- --network testnet`

**3. Safe handover**: `pnpm run safe -- --network testnet`, then `--broadcast`. Each new contract:
transferOwnership to the Safe, then acceptOwnership executed by the Safe.

**4. The server's own creator and render agent**: `pnpm run vm setup`, then `--broadcast`. Names the
server's creator agent on the new HspSettlement for the server's own creator; the render agent is already
allowed (step 1). Nothing is minted (USDC is HashKey's).

**5. On the server** (IAP SSH): copy `deployments/testnet.json` to `/opt/likeness/deployments/` (keep the old
one as `testnet.json.before-usdc`), then append to `/etc/likeness.env` (append, never overwrite: it also holds
`LIKENESS_AI` and `LIKENESS_DEMO_CREATOR`):

```
HSP_ALLOWLISTED=1
HSP_CHAIN_ID=133
HSP_TOKEN=0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6
```
`sudo systemctl restart likeness`. The log line shows `gateway: hsp-agentic-qa`; the app archives the old
records once.

**6. Creators onboarded on the server** (on the server, as the app's user, while the app runs):

```sh
cd /opt/likeness/agents
sudo -u likeness -H env LIKENESS_KEYSTORE_PASSWORD_FILE=/run/likeness/keystore-password node_modules/.bin/tsx scripts/creator-agents.ts              # dry run
sudo -u likeness -H env LIKENESS_KEYSTORE_PASSWORD_FILE=/run/likeness/keystore-password node_modules/.bin/tsx scripts/creator-agents.ts --broadcast
```

**7. Smoke test**: `/api/state` shows `gateway: hsp-agentic-qa`, `agentic.token` USDC `0x8FE3…`,
`agentic.recordable: true`; every page answers 200; a file made before the redeploy verifies, marked
"previous deployment".

**8. First live runs** (Rohit, in the browser): a bundle with one image and one video → **Make image** → both
approvals (USDC, raw amount, the creator's payout) → HSP's statuses on QA → recorded on chain → the AI image →
Verify. Then **Make video**.

**Rollback** (any step after 5): restore `testnet.json.before-usdc`, remove the three lines from
`/etc/likeness.env`, restart. The site is back on the emulator with the previous contracts (still deployed);
records the app archived stay in `archived_*`.
