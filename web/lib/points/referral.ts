// Accepting an invite is a signature, not a transaction: the invitee signs a
// plain message naming the inviter, the chain and the season, once. Without
// it anyone could bind somebody else's wallet to a stranger, or to themselves.
// The site builds the same message (this module runs in both places).

import { isAddress, recoverMessageAddress } from "viem";

/** the exact text the invitee signs */
export function referralMessage(inviter: string, chainKey: string, seasonNumber: number): string {
  return `Notus referral\nI was invited by ${inviter.toLowerCase()}\n${chainKey} · Season ${seasonNumber}`;
}

export type ReferralClaim = {
  invitee: string;
  inviter: string;
  signature: string;
  chainKey: string;
  seasonNumber: number;
};

/** whether the claim is the invitee's own, and acceptable */
export async function verifyReferral(c: ReferralClaim): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isAddress(c.invitee) || !isAddress(c.inviter)) return { ok: false, reason: "not an address" };
  if (c.invitee.toLowerCase() === c.inviter.toLowerCase()) return { ok: false, reason: "a wallet cannot invite itself" };
  if (!/^0x[0-9a-fA-F]{130}$/.test(c.signature)) return { ok: false, reason: "not a signature" };
  try {
    const signer = await recoverMessageAddress({
      message: referralMessage(c.inviter, c.chainKey, c.seasonNumber),
      signature: c.signature as `0x${string}`,
    });
    if (signer.toLowerCase() !== c.invitee.toLowerCase()) return { ok: false, reason: "the signature is not the invitee's" };
  } catch {
    return { ok: false, reason: "the signature does not verify" };
  }
  return { ok: true };
}
