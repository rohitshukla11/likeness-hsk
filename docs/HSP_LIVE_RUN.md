# HSP Agentic Payment: live-run checklist (QA)

Start only after HashKey confirms the allowlisting of **103.197.74.221**. Run from `agents/`. Each step
says what success looks like; anything else is a **stop**: report it, don't work around it. Total: about
**2 h 15 min**, most of it waiting for confirmations and the video.

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

**a. Egress IP is still 103.197.74.221** (2 min)

```sh
curl -s https://api.ipify.org; echo
```
Success: `103.197.74.221`. **Stop** if not: ask HashKey to update the allowlist; don't contact the QA server.

**b. Live tools, saved schemas, diff against the emulator** (10 min)

```sh
export HSP_ALLOWLISTED=1
pnpm hsp:agentic health        # expected {"status":"ok"}
pnpm hsp:agentic tools         # all eight listed; saves deployments/hsp-qa-tools.json
pnpm hsp:agentic diff          # saves deployments/hsp-qa-schema-diff.txt
```
Success: eight tools; the diff ends "No stops", or lists only "adapted" names (camelCase or
payer/payer_address), which the client maps itself. **Stop** on any "STOP" line (ambiguous, missing,
extra-required): report the differences before calling anything else.

**c. Network, token, protocol** (5 min)

```sh
pnpm hsp:agentic chain-config  # saves deployments/hsp-qa-chain-config.json
```
Success: one option, chain 133. If several, **ask Rohit** which, then `export HSP_CHAIN_ID=… HSP_TOKEN=0x…`.
Note the protocol (eip3009 or permit2) and, for permit2, whether the config names the Permit2 contract.

**d. Funding check and Permit2 approval: for Rohit to run** (15 min, incl. HashKey's test tokens)

```sh
HSP_PAYER=0xBE91B3445A2C3366079170eFF000D8963d413bDe pnpm hsp:agentic commands
```
Prints the exact `cast call … balanceOf` and, for permit2, `cast send <token> "approve(address,uint256)"
<Permit2> <amount>` with the brand keystore. The agent never runs them. Success: the balance covers at
least two renders (2 × the quoted `token_total_raw`) and, for permit2, the approval is mined. **Stop** if
the Permit2 spender isn't named by HSP: ask HashKey.

**e. Redeploy for HSP's token, verify, Safe** (30 min)

```sh
pnpm run deploy -- --network testnet --hsp-token              # dry run: plan and gas (≈ 0.006 HSK)
# Rohit's OK, then:
pnpm run deploy -- --network testnet --hsp-token --broadcast  # LicenseRegistry, ReceiptAnchor, HspSettlement
pnpm run verify -- --network testnet                          # Blockscout
pnpm run safe -- --network testnet                            # dry run, then add --broadcast
LIKENESS_HSP=agentic pnpm run testnet -- --setup-only         # the creator names its agent on the new HspSettlement
```
Success: three new verified contracts, all owned by the Safe; the previous deployment kept as
`deployments/testnet-<date>-usdt.json`; CreatorRegistry unchanged; `setAgent` mined (nothing paid).

**f. The live run in the brand console** (20 min)

```sh
LIKENESS_HSP=agentic pnpm app      # http://127.0.0.1:8788/brand; banner: "HSP Agentic Payment: HashKey QA (MCP)"
```
Take a licence → Pay for next render. **Approval 1** (before signing): check the recipient is the
creator's payout, the payer is 0xBE91…bDe, and `token_total_raw` → Approve and sign. **Approval 2**
(before submitting): the same three → Approve and submit. Then the timeline: `query_payment` every 15 s
until payment-safe or payment-finalized; transaction link; attribution "verified"; recorded on chain;
receipt; Verify says Licensed. **Stop** on payment-failed (report `status_reason`) or attribution false.
If nothing ends within 10 min: "Pending confirmation", keep the flow_id and payment_request_id, don't
create another order. (Command-line alternative: `LIKENESS_HSP=agentic pnpm run testnet`, approvals by
typing "yes".)

**g. Second run, then revoke: for the video** (30 min)

Record per docs/submission/VIDEO_SCRIPT.md, variant A: a second paid render (both approvals on camera),
then Creator page → Revoke, then Pay again → refused before anything is signed.

**h. README and BUIDL** (20 min)

Replace "not run yet" in README "Real HSP Agentic Payment on QA" and BUIDL with the real links: the
payment tx (from `payment.tx_signature`), recordPayment, receipt, revoke, and `attribution_verified:
true`, the payment status (safe or finalized, as reported) and `token_total_raw` in raw units.
