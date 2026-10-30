# HSP Agentic Payment: live-run checklist (QA)

Start only after HashKey confirms the allowlisting. **Every QA request comes from the public server**
(`likeness-hsk-vm`, static IP **35.254.5.116**); the Mac never contacts QA. `HSP_ALLOWLISTED=1` is set on the
VM only. Steps a–c run on the VM over IAP SSH, as the app's user, in `/opt/likeness/agents`:

```sh
export CLOUDSDK_ACTIVE_CONFIG_NAME=likeness-hsk
vm() { gcloud compute ssh likeness-hsk-vm --zone=us-central1-a --project=likeness-hsk --tunnel-through-iap --quiet \
  --command="cd /opt/likeness/agents && sudo -u likeness -H env HSP_ALLOWLISTED=1 $*"; }
```

Each step says what success looks like; anything else is a **stop**: report it, don't work around it.
Total: about **2 h 15 min**, most of it waiting for confirmations and the video.

| | Step | Time |
|---|---|---|
| a | Egress IP | 2 min |
| b | Live tools and schema diff | 10 min |
| c | Chain config | 5 min |
| d | Funding and approval (Rohit) | 15 min |
| e | Redeploy, verify, Safe | 30 min |
| f | Live run in the brand console | 20 min |
| g | Second run and revoke (video) | 30 min |
| h | README / BUIDL | 20 min |

**a. The VM's egress IP is 35.254.5.116; switch the app to live** (2 min)

```sh
vm curl -s https://api.ipify.org                    # expected 35.254.5.116
gcloud compute ssh likeness-hsk-vm --zone=us-central1-a --project=likeness-hsk --tunnel-through-iap --quiet \
  --command='echo HSP_ALLOWLISTED=1 | sudo tee /etc/likeness.env >/dev/null && sudo systemctl restart likeness && sleep 20 && systemctl is-active likeness'
```
Success: `35.254.5.116`, then `active`; the public banner reads "HSP Agentic Payment: HashKey QA (MCP)".
**Stop** if the IP differs, or if the app doesn't start (its log: `sudo journalctl -u likeness -n 30`).

**b. Live tools, saved schemas, diff against the emulator** (10 min)

```sh
vm pnpm hsp:agentic health        # expected {"status":"ok"}
vm pnpm hsp:agentic tools         # all eight listed; saves deployments/hsp-qa-tools.json on the VM
vm pnpm hsp:agentic diff          # saves deployments/hsp-qa-schema-diff.txt on the VM
```
Copy the saved files back for the repo: `gcloud compute scp --tunnel-through-iap --zone=us-central1-a
--project=likeness-hsk 'likeness-hsk-vm:/opt/likeness/deployments/hsp-qa-*' deployments/`.
Success: eight tools; the diff ends "No stops", or lists only "adapted" names (camelCase or
payer/payer_address), which the client maps itself. **Stop** on any "STOP" line (ambiguous, missing,
extra-required): report the differences before calling anything else.

**c. Network, token, protocol** (5 min)

```sh
vm pnpm hsp:agentic chain-config  # saves deployments/hsp-qa-chain-config.json on the VM
```
Success: one option, chain 133. If several, **ask Rohit** which, then `export HSP_CHAIN_ID=… HSP_TOKEN=0x…`.
Note the protocol (eip3009 or permit2) and, for permit2, whether the config names the Permit2 contract.

**d. Funding check and Permit2 approval: for Rohit to run** (15 min, incl. HashKey's test tokens)

HashKey's test tokens go to the **VM's brand 0x8E9B246D48C4661db6e704669674012823D4DDec**. On the Mac (the
chain-config file copied back in step b):

```sh
HSP_PAYER=0x8E9B246D48C4661db6e704669674012823D4DDec pnpm hsp:agentic commands
```
Prints the exact `cast call … balanceOf` and, for permit2, `cast send <token> "approve(address,uint256)"
<Permit2> <amount>` with the VM brand's keystore (`--keystore .secrets/vm/keystores/brand --password-file
.secrets/vm/keystore-password`). The agent never runs them. Success: the balance covers at
least two renders (2 × the quoted `token_total_raw`) and, for permit2, the approval is mined. **Stop** if
the Permit2 spender isn't named by HSP: ask HashKey.

**e. Redeploy for HSP's token, verify, Safe** (30 min)

```sh
pnpm run deploy -- --network testnet --hsp-token              # dry run: plan and gas (≈ 0.006 HSK)
# Rohit's OK, then:
pnpm run deploy -- --network testnet --hsp-token --broadcast  # LicenseRegistry, ReceiptAnchor, HspSettlement
pnpm run verify -- --network testnet                          # Blockscout
pnpm run safe -- --network testnet                            # dry run, then add --broadcast
pnpm run vm setup --broadcast                                 # the VM's creator names its agent on the new HspSettlement
```
Then commit and push the new `deployments/testnet.json`, and deploy that commit to the VM (git archive →
`/opt/likeness`, `sudo systemctl restart likeness`).
Success: three new verified contracts, all owned by the Safe; the previous deployment kept as
`deployments/testnet-<date>-usdt.json`; CreatorRegistry unchanged; `setAgent` mined (nothing paid); the
public app shows the new contracts.

**f. The live run in the brand console** (20 min)

https://35-254-5-116.sslip.io/brand (banner: "HSP Agentic Payment: HashKey QA (MCP)"); unlock with the demo
password. Take a licence → Pay for next render. **Approval 1** (before signing): check the recipient is the
creator's payout (the VM creator 0xD2925E4A…29ca9), the payer is the VM brand 0x8E9B…4DDec, and
`token_total_raw` → Approve and sign. **Approval 2**
(before submitting): the same three → Approve and submit. Then the timeline: `query_payment` every 15 s
until payment-safe or payment-finalized; transaction link; attribution "verified"; recorded on chain;
receipt; Verify says Licensed. **Stop** on payment-failed (report `status_reason`) or attribution false.
If nothing ends within 10 min: "Pending confirmation", keep the flow_id and payment_request_id, don't
create another order.

**g. Second run, then revoke: for the video** (30 min)

Record per docs/submission/VIDEO_SCRIPT.md, variant A: a second paid render (both approvals on camera),
then Creator page → Revoke, then Pay again → refused before anything is signed.

**h. README and BUIDL** (20 min)

Replace "not run yet" in README "Real HSP Agentic Payment on QA" and BUIDL with the real links: the
payment tx (from `payment.tx_signature`), recordPayment, receipt, revoke, and `attribution_verified:
true`, the payment status (safe or finalized, as reported) and `token_total_raw` in raw units.
