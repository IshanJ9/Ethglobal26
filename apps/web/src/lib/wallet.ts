import { getAddress, keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CLAIM_TYPES, claimTypedData, makeDomain, toClaimMessage } from "@proofwork/crypto";
import type { Schemas } from "./api";

type TypedData = Schemas["TypedDataClaim"];

/**
 * DEMO KEYS ONLY (spec/vectors persona_key_rule): private_key = keccak256(utf8("proofwork-demo-persona:" + persona_id)).
 * Shown only when auth_mode=dev, clearly labelled, never holds funds. The browser never sends chain transactions.
 */
export function demoAccount(personaId: string) {
  return privateKeyToAccount(keccak256(stringToBytes(`proofwork-demo-persona:${personaId}`)));
}

/** viem wants bigint for uint fields; the API sends JSON integers. */
function toViemTypedData(td: TypedData) {
  return claimTypedData(makeDomain(td.domain.chainId, getAddress(td.domain.verifyingContract)), toClaimMessage(td.message));
}

export async function signWithDemoKey(personaId: string, td: TypedData): Promise<Hex> {
  return demoAccount(personaId).signTypedData(toViemTypedData(td));
}

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const injected = (): Eip1193 | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum);

export const hasInjectedWallet = () => !!injected();

/** MetaMask (or any EIP-1193 wallet): eth_signTypedData_v4 from the first account. Signs only, never sends. */
export async function signWithInjected(td: TypedData): Promise<{ signature: Hex; address: string }> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const payload = {
    domain: td.domain,
    types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ], ...CLAIM_TYPES },
    primaryType: "Claim",
    message: td.message,
  };
  const signature = (await eth.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(payload)] })) as Hex;
  return { signature, address };
}
