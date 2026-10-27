import { randomUUID } from "node:crypto";
import { hashMessage, type Address, type Hex, type LocalAccount } from "viem";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { cartHash, type CartMandate } from "./cart.js";
import { X402 } from "./cart.js";

/**
 * The payment agent's side: the wallet signature over the stablecoin transfer, and the AP2 Payment
 * Mandate that carries it to the HSP Gateway.
 *
 * Verified against HashKey's docs and SDKs: the EIP-3009 and Permit2 typed data (Go SDK
 * crypto/signing.go) and the PaymentMandate fields (Go SDK types/ap2.go).
 * NOT yet confirmed by HashKey (asked): where in `payment_response.details` the Gateway expects the
 * authorization, and the format of `user_authorization`. We follow the x402 "exact" scheme payload
 * ({ authorization, signature }) and send a signed hash binding of the cart and the mandate; both are
 * isolated here so they can change in one place.
 */

export type Rail = "eip3009" | "permit2";

export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface Permit2Transfer {
  token: Address;
  amount: bigint;
  spender: Address; // the HSP Gateway's executor
  nonce: bigint;
  deadline: bigint;
}

export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** EIP-712 domain of USDC.e on HSK Chain (checked on chain 177: "Bridged USDC", version "2"). */
export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export function eip3009TypedData(domain: TokenDomain, a: Eip3009Authorization) {
  return {
    domain,
    primaryType: "TransferWithAuthorization" as const,
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const,
    message: { ...a },
  };
}

export function permit2TypedData(chainId: number, p: Permit2Transfer, permit2: Address = PERMIT2) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: permit2 },
    primaryType: "PermitTransferFrom" as const,
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    } as const,
    message: { permitted: { token: p.token, amount: p.amount }, spender: p.spender, nonce: p.nonce, deadline: p.deadline },
  };
}

/** The x402 "exact" payload for one signed transfer. Numbers as decimal strings, as JSON needs. */
export type ExactPayload =
  | {
      scheme: "exact";
      rail: "eip3009";
      signature: Hex;
      authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
    }
  | {
      scheme: "exact";
      rail: "permit2";
      signature: Hex;
      owner: Address;
      permit: { token: Address; amount: string; spender: Address; nonce: string; deadline: string };
    };

export async function signEip3009(account: LocalAccount, domain: TokenDomain, a: Eip3009Authorization): Promise<ExactPayload> {
  if (a.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("authorization must be from the signer");
  const signature = await account.signTypedData(eip3009TypedData(domain, a));
  return {
    scheme: "exact",
    rail: "eip3009",
    signature,
    authorization: {
      from: a.from,
      to: a.to,
      value: a.value.toString(),
      validAfter: a.validAfter.toString(),
      validBefore: a.validBefore.toString(),
      nonce: a.nonce,
    },
  };
}

export async function signPermit2(account: LocalAccount, chainId: number, p: Permit2Transfer, permit2: Address = PERMIT2): Promise<ExactPayload> {
  const signature = await account.signTypedData(permit2TypedData(chainId, p, permit2));
  return {
    scheme: "exact",
    rail: "permit2",
    signature,
    owner: account.address,
    permit: { token: p.token, amount: p.amount.toString(), spender: p.spender, nonce: p.nonce.toString(), deadline: p.deadline.toString() },
  };
}

/** AP2 PaymentMandate (Go SDK types/ap2.go), as submitted to the Gateway. */
export interface PaymentMandate {
  payment_mandate_contents: {
    payment_mandate_id: string; // = payment_request_id (ID2 = ID4)
    payment_details_id: string; // the payer's random request id (ID5)
    payment_details_total: { label: string; amount: { currency: "USD"; value: string } };
    payment_response: {
      request_id: string; // = payment_request_id
      method_name: typeof X402;
      details: { x402Version: 2; network: string; chain_id: number; payload: ExactPayload };
    };
    merchant_agent: string;
    timestamp: string;
  };
  user_authorization: string;
}

export function paymentMandateHash(m: PaymentMandate["payment_mandate_contents"]): string {
  return sha256Hex(canonicalJson(m));
}

/**
 * Builds the mandate and the payer's user_authorization: the payer wallet's signature (EIP-191) over
 * the cart hash and the mandate hash, base64url-encoded with both hashes. It ties the wallet signature
 * to this exact cart and mandate.
 */
export async function buildPaymentMandate(
  account: LocalAccount,
  cart: CartMandate,
  payload: ExactPayload,
  opts: { now?: Date; requestId?: string } = {},
): Promise<PaymentMandate> {
  const method = cart.contents.payment_request.method_data[0];
  if (!method) throw new Error("cart has no payment method");
  const details = cart.contents.payment_request.details;
  const contents: PaymentMandate["payment_mandate_contents"] = {
    payment_mandate_id: details.id,
    payment_details_id: opts.requestId ?? `req_${randomUUID()}`,
    payment_details_total: details.total,
    payment_response: {
      request_id: details.id,
      method_name: X402,
      details: { x402Version: 2, network: method.data.network, chain_id: method.data.chain_id, payload },
    },
    merchant_agent: cart.contents.merchant_name,
    timestamp: (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const binding = { cart_hash: cartHash(cart.contents), payment_mandate_hash: paymentMandateHash(contents) };
  const message = `HSP payment mandate\ncart_hash:${binding.cart_hash}\npayment_mandate_hash:${binding.payment_mandate_hash}`;
  const signature = await account.signMessage({ message });
  const userAuthorization = Buffer.from(
    JSON.stringify({ type: "EIP191HashBinding", payer: account.address, ...binding, message_hash: hashMessage(message), signature }),
  ).toString("base64url");
  return { payment_mandate_contents: contents, user_authorization: userAuthorization };
}
