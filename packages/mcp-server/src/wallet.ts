import { privateKeyToAccount } from "viem/accounts";
import { parseSignature } from "viem";

export type TypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type Signer = {
  address: `0x${string}`;
  signTypedData(typedData: TypedData): Promise<`0x${string}`>;
  signMessage(message: string): Promise<`0x${string}`>;
};

export class WalletRequiredError extends Error {
  constructor(reason?: string) {
    super(reason ?? "This tool signs an economic action and requires AGENT_PRIVATE_KEY to be set on the MCP server.");
    this.name = "WalletRequiredError";
  }
}

export function createSigner(privateKey: `0x${string}`): Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData as never),
    signMessage: (message) => account.signMessage({ message }),
  };
}

/**
 * Signs the actor EIP-712 payload the Court returned and reshapes it into the
 * `actorAuthorization` body the API expects. The typed data is signed exactly as
 * returned; nonce and deadline are stringified because the contract reads them as
 * decimal strings over the wire.
 */
export async function signActorAuthorization(typedData: TypedData, signer: Signer) {
  const signature = await signer.signTypedData(typedData);
  return {
    ...typedData.message,
    nonce: String(typedData.message.nonce),
    deadline: String(typedData.message.deadline),
    signature,
  };
}

export type PreparedFunding = {
  validAfter: string | number;
  validBefore: string | number;
  nonce: string;
  typedData: TypedData;
};

/** Signs the EIP-3009 funding authorization and splits it into the v/r/s the token expects. */
export async function signFundingAuthorization(funding: PreparedFunding, signer: Signer) {
  const signature = await signer.signTypedData(funding.typedData);
  const split = parseSignature(signature);
  return {
    validAfter: funding.validAfter,
    validBefore: funding.validBefore,
    nonce: funding.nonce,
    v: split.v === undefined ? split.yParity + 27 : Number(split.v),
    r: split.r,
    s: split.s,
  };
}
