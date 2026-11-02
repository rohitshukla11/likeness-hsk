/**
 * An offline stand-in for HashKey's QA MCP server, for the admin's live QA payment only (app/liveQa.ts):
 * the eight tools with the live schemas, get_chain_config with Ethereum Sepolia and Circle's USDC (eip3009),
 * EIP-3009 quotes that the payer's signature must match, and statuses that end in payment-finalized. No
 * chain and no money: used by the tests and for a local rehearsal (HSP_QA_LIVE_RUN=rehearsal), and always
 * labelled as such.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { recoverTypedDataAddress, type Hex } from "viem";
import { z } from "zod";
import { HspAgentic } from "./client.js";
import { typedData } from "./payer.js";

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const fail = (code: number, message: string) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }] });

export async function rehearsalQa(o: { statuses?: string[]; feeRaw?: bigint } = {}): Promise<HspAgentic> {
  const statuses = o.statuses ?? ["payment-processing", "payment-included", "payment-finalized"];
  type Order = { flowId: string; paymentRequestId: string; payTo: string; amountRaw: bigint; payer?: string; quote?: { eip712: Record<string, unknown>; cartHash: string }; signed?: boolean; polls: number; merchantName: string };
  const orders = new Map<string, Order>();
  const s = new McpServer({ name: "hsp-agentic-payment (offline rehearsal)", version: "0" });
  s.registerTool("get_chain_config", { inputSchema: {} }, async () =>
    text({
      networks: [{ chain_id: 11155111, display_name: "Ethereum Sepolia", is_testnet: true, name: "sepolia" }],
      tokens: [{ address: SEPOLIA_USDC, chain_id: 11155111, decimals: 6, is_stablecoin: true, name: "USDC", payment_protocol: "eip3009", permit2_spender: "0x85Afd346143690AFbEc392524A8bae1e9ea8f500", symbol: "USDC", version: "2" }],
    }),
  );
  s.registerTool("create_order", { inputSchema: { merchant_name: z.string(), pay_to: z.string(), cart_mandate: z.object({ contents: z.record(z.string(), z.unknown()) }) } }, async (a) => {
    const value = (a.cart_mandate.contents as { payment_request?: { details?: { total?: { amount?: { value?: string } } } } }).payment_request?.details?.total?.amount?.value ?? "0";
    const flowId = `FLOW-${randomUUID()}`;
    orders.set(flowId, { flowId, paymentRequestId: `PR-${randomUUID()}`, payTo: a.pay_to, amountRaw: BigInt(Math.round(Number(value) * 1e6)), polls: 0, merchantName: a.merchant_name });
    const order = orders.get(flowId)!;
    return text({ flow_id: flowId, payment_request_id: order.paymentRequestId, payment_url: `https://rehearsal.invalid/pay/${flowId}` });
  });
  s.registerTool("get_order", { inputSchema: { flow_id: z.string() } }, async (a) => {
    const order = orders.get(a.flow_id);
    return order ? text({ flow_id: order.flowId, pay_to: order.payTo, gas_fee_advanced: o.feeRaw === undefined }) : fail(10003, "unknown flow_id");
  });
  s.registerTool("estimate_fee", { inputSchema: { payment_request_id: z.string(), payment_payload: z.string(), merchant_name: z.string() } }, async () => text({}));
  s.registerTool("prepare_payment", { inputSchema: { flow_id: z.string(), payer: z.string(), protocol: z.enum(["eip3009", "permit2"]) } }, async (a) => {
    const order = orders.get(a.flow_id);
    if (!order) return fail(10003, "unknown flow_id");
    order.payer = a.payer;
    const total = order.amountRaw + (o.feeRaw ?? 0n);
    const eip712 = {
      domain: { name: "USDC", version: "2", chainId: 11155111, verifyingContract: SEPOLIA_USDC },
      types: {
        EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
        TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
      },
      primaryType: "TransferWithAuthorization",
      message: { from: a.payer, to: order.payTo, value: total.toString(), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: `0x${randomBytes(32).toString("hex")}` },
    };
    const cartHash = createHash("sha256").update(order.flowId).digest("hex");
    order.quote = { eip712, cartHash };
    return text({ eip712, cart_hash: cartHash, token_total_raw: total.toString(), quote_expires_at: new Date(Date.now() + 300_000).toISOString(), pay_to: order.payTo, payer: a.payer, payment_request_id: order.paymentRequestId, payment_payload: { x402Version: 2 }, payment_mandate_contents: { id: order.paymentRequestId } });
  });
  s.registerTool("finalize_payment", { inputSchema: { signature: z.string(), payment_payload: z.unknown(), payment_mandate_contents: z.unknown(), cart_hash: z.string() } }, async (a) => {
    const order = [...orders.values()].find((x) => x.quote?.cartHash === a.cart_hash);
    if (!order?.quote) return fail(10003, "no quote for this cart_hash");
    const signer = await recoverTypedDataAddress({ ...typedData(order.quote.eip712 as never), signature: a.signature as Hex });
    if (signer.toLowerCase() !== order.payer?.toLowerCase()) return fail(10002, "signature isn't the payer's");
    order.signed = true;
    return text({ payment_mandate_json: JSON.stringify({ flow_id: order.flowId }) });
  });
  s.registerTool("submit_payment", { inputSchema: { payment_mandate_json: z.string() } }, async (a) => {
    const order = orders.get((JSON.parse(a.payment_mandate_json) as { flow_id?: string }).flow_id ?? "");
    if (!order?.signed) return fail(10003, "unknown payment");
    return text({ status: "payment-submitted", flow_id: order.flowId, payment_request_id: order.paymentRequestId });
  });
  s.registerTool("query_payment", { inputSchema: { flow_id: z.string().optional(), payment_request_id: z.string().optional(), expected_merchant_name: z.string() } }, async (a) => {
    const order = (a.flow_id && orders.get(a.flow_id)) || [...orders.values()].find((x) => x.paymentRequestId === a.payment_request_id);
    if (!order) return fail(10003, "unknown payment");
    const status = statuses[Math.min(order.polls++, statuses.length - 1)];
    const final = status === "payment-safe" || status === "payment-finalized";
    return text({ attribution_verified: a.expected_merchant_name === order.merchantName, payment: { status, tx_signature: final ? `0x${createHash("sha256").update(order.flowId).digest("hex")}` : "", network: "sepolia", to_pay_address: order.payTo, payer_address: order.payer } });
  });
  const [c, srv] = InMemoryTransport.createLinkedPair();
  await s.connect(srv);
  return HspAgentic.connect(c, "emulator");
}
