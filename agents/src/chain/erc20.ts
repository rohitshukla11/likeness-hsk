import { decodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";

/**
 * ERC-20 writes declared without a return value, so viem doesn't try to decode one: classic Tether
 * USDT (HashKey's testnet USDT is one) returns nothing from approve, transfer and transferFrom.
 */
export const erc20WriteAbi = parseAbi([
  "function approve(address spender, uint256 value)",
  "function transfer(address to, uint256 value)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

type Write = (account: LocalAccount, req: { address: Address; abi: typeof erc20WriteAbi; functionName: "approve" | "transfer"; args: readonly [Address, bigint] }) => Promise<unknown>;

/** SafeERC20's rule for a call's return data: nothing, or an ABI-encoded `true`. */
export function optionalReturnOk(data: Hex | undefined): boolean {
  if (!data || data === "0x") return true;
  try {
    return decodeAbiParameters([{ type: "bool" }], data)[0];
  } catch {
    return false;
  }
}

/** Runs the call first and refuses a token that answers `false`, then sends it. */
async function safeWrite(pub: PublicClient, write: Write, account: LocalAccount, token: Address, functionName: "approve" | "transfer", args: readonly [Address, bigint]) {
  const { data } = await pub.call({ account: account.address, to: token, data: encodeFunctionData({ abi: erc20WriteAbi, functionName, args }) });
  if (!optionalReturnOk(data)) throw new Error(`${functionName} on ${token} returned false`);
  return write(account, { address: token, abi: erc20WriteAbi, functionName, args });
}

/**
 * Like OpenZeppelin's SafeERC20.forceApprove: works with tokens that return nothing, and resets a
 * non-zero allowance to 0 first, which classic USDT requires before setting another non-zero value.
 */
export async function forceApprove(pub: PublicClient, write: Write, owner: LocalAccount, token: Address, spender: Address, value: bigint) {
  const current = await pub.readContract({ address: token, abi: erc20WriteAbi, functionName: "allowance", args: [owner.address, spender] });
  if (current === value) return;
  if (current !== 0n && value !== 0n) await safeWrite(pub, write, owner, token, "approve", [spender, 0n]);
  await safeWrite(pub, write, owner, token, "approve", [spender, value]);
}

/** Like SafeERC20.safeTransfer. */
export function safeTransfer(pub: PublicClient, write: Write, from: LocalAccount, token: Address, to: Address, value: bigint) {
  return safeWrite(pub, write, from, token, "transfer", [to, value]);
}
