"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { isAddress as isEvmAddress } from "viem";
import { PARAMS, memo } from "@/lib/litecoin/ledger";
import { CARRY_LIT, evmAddressOfPubkey, evmAddressOfSecret, inputKindOf } from "@/lib/litecoin/tx";
import { LTC_NETWORK, useLtcWallet, type LState } from "@/lib/litecoin/client";
import { SendPanel } from "./SendPanel";
import { Copyable } from "./Copyable";

function derive(pubkey: string): string | null {
  try {
    return evmAddressOfPubkey(pubkey);
  } catch {
    return null;
  }
}

/** Where a holder's coins land when the ledger migrates to LitVM. Without a
 *  word from them, the snapshot takes the LitVM account of the very key that
 *  signed their Litecoin transactions (the two chains share the curve). A
 *  holder who would rather receive on a wallet they already use, or whose
 *  key cannot be read from their transactions (a Taproot account), registers
 *  the address with one `evm 0x…` instruction, changeable until the snapshot. */
export function EvmDestination({ state }: { state: LState | null | undefined }) {
  const { kind, secret, address, ext } = useLtcWallet();
  const extName = ext?.name ?? "the extension";
  const { address: connected } = useAccount();
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  if (!address || !state) return null;

  const desk = state.desk.address;
  const registered = state.evm?.[address] ?? null;
  const pending = (state.pending ?? []).find((p) => p.sender === address && /^NOTUS1 evm 0x[0-9a-f]{40}$/i.test(p.memo ?? ""));
  const taproot = kind === "ext" && !!ext && inputKindOf(address, ext.pubkey, LTC_NETWORK) === "tr";
  const derived = kind === "hot" && secret ? evmAddressOfSecret(secret) : kind === "ext" && ext && !taproot ? derive(ext.pubkey) : null;
  const tip = state.chainTip ?? state.height;
  const opensAt = PARAMS[LTC_NETWORK].rulesV2From ?? 0;
  const accepting = tip + 1 >= opensAt; // the next block takes the instruction
  const blocksAway = Math.max(0, opensAt - (tip + 1));
  const v = value.trim();
  const valid = isEvmAddress(v);
  const unchanged = valid && !!registered && v.toLowerCase() === registered;
  const form = !registered || editing;

  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">LitVM — where your coins land at the migration</div>
        {registered && (
          <button type="button" onClick={() => setEditing((e) => !e)} className="text-xs text-zinc-400 underline">
            {editing ? "keep it" : "change"}
          </button>
        )}
      </div>

      {registered ? (
        <>
          <Copyable label="registered" value={registered} />
          <p className="text-xs text-zinc-500">
            Every coin this Litecoin address holds is delivered to that LitVM address when the ledger migrates. It can be changed until
            the snapshot is taken.
          </p>
        </>
      ) : taproot ? (
        <p className="text-xs text-zinc-400">
          ⚠ Your {extName} account is Taproot: its key cannot be read from its transactions, so without a registration your coins
          would wait in the migration vault for a signed claim. Register the LitVM address that should receive them.
        </p>
      ) : derived ? (
        <>
          <Copyable label={kind === "ext" ? `${extName} key on LitVM` : "this key on LitVM"} value={derived} />
          <p className="text-xs text-zinc-500">
            {kind === "ext"
              ? `Without a registration your coins land on the LitVM account of your ${extName} key, which you would have to export from ${extName} to reach. Register a wallet you already use instead.`
              : "Without a registration your coins land on the LitVM account of this very key: import the wallet secret into MetaMask and they are there. Register a wallet you already use instead, and they land there directly."}
          </p>
        </>
      ) : null}

      {pending && (
        <p className="text-xs text-zinc-400">
          A registration is waiting for a block: <span className="font-mono">{pending.memo?.split(" ")[2]}</span>
        </p>
      )}

      {form &&
        (!accepting ? (
          <p className="text-xs text-zinc-500">
            Registrations open at block {opensAt.toLocaleString("en-US")}: {blocksAway.toLocaleString("en-US")} block{blocksAway === 1 ? "" : "s"} away
            (~{Math.round((blocksAway * 2.5) / 60)} h). The migration itself comes later; there is time.
          </p>
        ) : (
          desk && (
            <>
              <div className="flex gap-2">
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0x… the LitVM (EVM) address that receives your coins"
                  spellCheck={false}
                  className="flex-1 min-w-0 rounded-lg input px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600"
                />
                {connected && connected.toLowerCase() !== v.toLowerCase() && (
                  <button
                    type="button"
                    onClick={() => setValue(connected)}
                    title={connected}
                    className="rounded-full border border-white/15 px-3 text-xs text-zinc-300 hover:border-white whitespace-nowrap"
                  >
                    use connected wallet
                  </button>
                )}
              </div>
              {v && !valid && <p className="text-[11px] text-zinc-500">⚠ Not an EVM address: 0x and 40 hex characters (with a valid checksum if it has capitals).</p>}
              {unchanged && <p className="text-[11px] text-zinc-500">That is the registered address already.</p>}
              {valid && !unchanged && (
                <SendPanel
                  payments={[{ address: desk, lit: CARRY_LIT }]}
                  memo={memo.evm(v)}
                  title="Register LitVM address"
                  confirmLabel="Sign & register"
                  note="The address travels in the OP_RETURN; the dust that carries it is credited back. Nothing about the address is checked: make sure it is a wallet you control on LitVM."
                />
              )}
              <p className="text-[11px] text-zinc-600">
                Any EVM wallet works: MetaMask, Rabby, a hardware wallet, the one you connect on the LitVM pages. The coins arrive there as
                ERC-20 tokens, on LitVM.
              </p>
            </>
          )
        ))}
    </section>
  );
}
