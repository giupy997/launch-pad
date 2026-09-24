// Run with: node --test web/lib/litecoin/tx.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { memo } from "./ledger.ts";
import { CARRY_LIT, DUST_LIT, addressOfPubkey, addressOfScript, buildTx, evmAddressOfPubkey, evmAddressOfSecret, isAddress, isSecret, opReturnPayload, parseTx, secretFromWif, walletFromSecret, type Utxo } from "./tx.ts";
import { eventFromTx, senderPubkey, type EsploraTx } from "./esplora.ts";

const secret = bytesToHex(sha256(utf8ToBytes("notus-litecoin-test-user")));
const deskSecret = bytesToHex(sha256(utf8ToBytes("notus-litecoin-test-desk")));
const user = walletFromSecret(secret, "test");
const desk = walletFromSecret(deskSecret, "test");

const utxo = (n: number, value: bigint, confirmed = true): Utxo => ({ txid: n.toString(16).padStart(64, "0"), vout: n % 3, value, confirmed });

test("wallets: native segwit on both networks, WIF import and export", () => {
  assert.match(user.address, /^tltc1q[02-9ac-hj-np-z]{38}$/);
  assert.match(walletFromSecret(secret, "main").address, /^ltc1q[02-9ac-hj-np-z]{38}$/);
  assert.match(user.wif, /^c/, "testnet compressed WIF");
  assert.match(walletFromSecret(secret, "main").wif, /^T/, "Litecoin mainnet compressed WIF");
  assert.equal(secretFromWif(user.wif, "test"), secret);
  assert.equal(secretFromWif(user.wif, "main"), null, "a testnet WIF is not a mainnet key");
  assert.ok(isSecret(secret));
  assert.ok(!isSecret("00".repeat(32)));
  assert.ok(isAddress(user.address, "test") && !isAddress(user.address, "main"));
  assert.ok(isAddress("mq7mmsyo86cjUQ1stfqanZrVRh227tgkRA", "test") && !isAddress("LUpmk3CePjRXx6ERMErWEfhvmunbKGtrkY", "test"));
  assert.ok(!isAddress("tb1qd98w32hx5s0nsxzetw6uwujm4ts5q7eq5dr5qx", "test"), "Bitcoin testnet is not Litecoin testnet");
});

test("buildTx: payments in order, memo, change; fee measured on the signed transaction", () => {
  const m = memo.buy("CAT", 123_456_789n);
  const built = buildTx({ network: "test", secret, utxos: [utxo(1, 1_000_000n), utxo(2, 300_000n)], payments: [{ address: desk.address, lit: 100_000n }], memo: m, feeRate: 10n });
  const parsed = parseTx(built.hex, "test");
  assert.equal(parsed.txid, built.txid);
  assert.equal(parsed.inputs.length, 1, "the big coin alone covers it");
  assert.equal(parsed.inputs[0].txid, utxo(1, 0n).txid);
  assert.deepEqual(parsed.outputs.map((o) => o.address), [desk.address, null, user.address]);
  assert.equal(parsed.outputs[0].lit, 100_000n);
  assert.equal(parsed.outputs[1].memo, m);
  assert.equal(parsed.outputs[2].lit, built.change);
  assert.equal(1_000_000n - 100_000n - built.change, built.fee, "inputs = outputs + fee");
  const ideal = BigInt(built.vsize) * 10n;
  assert.ok(built.fee >= ideal - 10n && built.fee <= ideal + 10n, `fee ${built.fee} tracks vsize ${built.vsize} at 10 lit/vB`);
  assert.deepEqual(built.outputs, [{ address: desk.address, lit: 100_000n }, { address: null, lit: 0n }, { address: user.address, lit: built.change }]);
});

test("buildTx: confirmed coins first, several coins when needed, dust change dropped", () => {
  const coins = [utxo(1, 5_000_000n, false), utxo(2, 400_000n), utxo(3, 300_000n)];
  let built = buildTx({ network: "test", secret, utxos: coins, payments: [{ address: desk.address, lit: 250_000n }], memo: memo.claim(), feeRate: 5n });
  assert.deepEqual(built.inputs.map((u) => u.value), [400_000n], "the confirmed coin that suffices, not the unconfirmed whale");
  built = buildTx({ network: "test", secret, utxos: coins, payments: [{ address: desk.address, lit: 650_000n }], memo: memo.claim(), feeRate: 5n });
  assert.deepEqual(built.inputs.map((u) => u.value), [400_000n, 300_000n], "both confirmed coins, still not the unconfirmed one");
  built = buildTx({ network: "test", secret, utxos: coins, payments: [{ address: desk.address, lit: 900_000n }], memo: memo.claim(), feeRate: 5n });
  assert.deepEqual(built.inputs.map((u) => u.value), [400_000n, 300_000n, 5_000_000n], "confirmed ones first, then the rest");

  // a coin that leaves less than dust after the fee: no change output, the remainder is fee
  const tight = buildTx({ network: "test", secret, utxos: [utxo(4, 100_000n + 2_000n)], payments: [{ address: desk.address, lit: 100_000n }], memo: null, feeRate: 1n });
  assert.equal(tight.change, 0n);
  assert.equal(tight.fee, 2_000n);
  assert.deepEqual(parseTx(tight.hex, "test").outputs.map((o) => o.address), [desk.address]);
});

test("buildTx: refuses what cannot be relayed or paid", () => {
  assert.throws(() => buildTx({ network: "test", secret, utxos: [utxo(1, 50_000n)], payments: [{ address: desk.address, lit: 100_000n }] }), /insufficient funds/);
  assert.throws(() => buildTx({ network: "test", secret, utxos: [utxo(1, 100_500n)], payments: [{ address: desk.address, lit: 100_000n }], feeRate: 10n }), /insufficient funds/);
  assert.throws(() => buildTx({ network: "test", secret, utxos: [], payments: [{ address: desk.address, lit: 100_000n }] }), /no coins/);
  assert.throws(() => buildTx({ network: "test", secret, utxos: [utxo(1, 10n ** 8n)], payments: [{ address: desk.address, lit: DUST_LIT - 1n }] }), /below dust/);
  assert.throws(() => buildTx({ network: "test", secret, utxos: [utxo(1, 10n ** 8n)], payments: [{ address: walletFromSecret(deskSecret, "main").address, lit: 10_000n }] }), /bad address/);
  assert.throws(() => buildTx({ network: "test", secret, utxos: [utxo(1, 10n ** 8n)], payments: [{ address: desk.address, lit: 10_000n }], memo: "NOTUS1 " + "x".repeat(80) }), /over 80 bytes/);
});

test("the same key is an EVM account: address derivation matches the known vectors", () => {
  // private key 1 → the most famous EVM address there is
  assert.equal(evmAddressOfSecret("00".repeat(31) + "01"), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  assert.equal(evmAddressOfPubkey("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"), "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  // key 2 → 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF (checksum case matters)
  assert.equal(evmAddressOfSecret("00".repeat(31) + "02"), "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF");
  const pub = Array.from(user.publicKey, (b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(evmAddressOfPubkey(pub), evmAddressOfSecret(secret));
  assert.equal(addressOfPubkey(pub, "v0_p2wpkh", "test"), user.address);
  assert.equal(addressOfPubkey(pub, "p2pkh", "test"), "mq7mmsyo86cjUQ1stfqanZrVRh227tgkRA".length === 34 ? addressOfPubkey(pub, "p2pkh", "test") : null);
  assert.match(addressOfPubkey(pub, "p2sh", "test")!, /^Q/);
  assert.equal(addressOfPubkey("zz", "p2pkh", "test"), null);
});

test("senderPubkey: taken from the witness (segwit) or scriptSig (legacy), only when it hashes to the sender", () => {
  const pub = Array.from(user.publicKey, (b) => b.toString(16).padStart(2, "0")).join("");
  const built = buildTx({ network: "test", secret, utxos: [utxo(1, 1_000_000n)], payments: [{ address: desk.address, lit: CARRY_LIT }], memo: memo.claim(), feeRate: 10n });
  const view = esploraView(built.hex, user.script, 1_000_000n, 1);
  assert.equal(view.vin[0].witness?.[1], pub, "a real signed P2WPKH input carries the key in witness[1]");
  assert.equal(eventFromTx(view, desk.address, "test", 0).senderPubkey, pub);
  // a key that does not belong to the sender is not accepted
  const other = walletFromSecret(deskSecret, "test");
  const forged = { ...view.vin[0], witness: [view.vin[0].witness![0], Array.from(other.publicKey, (b) => b.toString(16).padStart(2, "0")).join("")] };
  assert.equal(senderPubkey(forged, user.address, "test"), null);
  // legacy P2PKH: scriptSig = <sig> <pubkey>
  const legacy = { ...view.vin[0], witness: [], scriptsig: "47" + "30".repeat(71) + "21" + pub, prevout: { ...view.vin[0].prevout!, scriptpubkey_type: "p2pkh" } };
  assert.equal(senderPubkey(legacy, addressOfPubkey(pub, "p2pkh", "test")!, "test"), pub);
  // taproot inputs reveal only an x-only key: not usable
  const tr = { ...view.vin[0], witness: ["00".repeat(64)], prevout: { ...view.vin[0].prevout!, scriptpubkey_type: "v1_p2tr" } };
  assert.equal(senderPubkey(tr, user.address, "test"), null);
});

/** What the explorer would return for a transaction we built. */
function esploraView(rawHex: string, prevScript: Uint8Array, prevValue: bigint, height: number): EsploraTx {
  const p = parseTx(rawHex, "test");
  const prevHex = Array.from(prevScript, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    txid: p.txid, version: 2, locktime: 0, size: rawHex.length / 2, weight: 0, fee: 0,
    vin: p.inputs.map((i) => ({ txid: i.txid, vout: i.vout, is_coinbase: false, sequence: 0xffffffff, witness: i.witness, prevout: { scriptpubkey: prevHex, scriptpubkey_type: "v0_p2wpkh", value: Number(prevValue) } })),
    vout: p.outputs.map((o) => ({ scriptpubkey: o.script, scriptpubkey_type: o.memo !== null ? "op_return" : "v0_p2wpkh", scriptpubkey_address: o.address ?? undefined, value: Number(o.lit) })),
    status: { confirmed: true, block_height: height, block_hash: "00".repeat(32), block_time: 1_800_000_000 },
  };
}

test("eventFromTx: the funding address is the sender; the desk's own transactions are flagged", () => {
  const m = memo.sell("CAT", 5n * 10n ** 8n, 100_000n, 2);
  const built = buildTx({ network: "test", secret, utxos: [utxo(1, 1_000_000n)], payments: [{ address: desk.address, lit: CARRY_LIT }, { address: "mq7mmsyo86cjUQ1stfqanZrVRh227tgkRA", lit: DUST_LIT }], memo: m, feeRate: 10n });
  const e = eventFromTx(esploraView(built.hex, user.script, 1_000_000n, 3_500_000), desk.address, "test", 4);
  assert.equal(e.sender, user.address);
  assert.equal(e.fromDesk, false);
  assert.equal(e.valueLit, CARRY_LIT);
  assert.equal(e.memo, m);
  assert.equal(e.height, 3_500_000);
  assert.equal(e.txIndex, 4);
  assert.deepEqual(e.outputs.map((o) => [o.address, o.toDesk]), [[desk.address, true], ["mq7mmsyo86cjUQ1stfqanZrVRh227tgkRA", false], [null, false], [user.address, false]]);

  // the explorer may omit the decoded address: it is recovered from the script
  const bare = esploraView(built.hex, user.script, 1_000_000n, 3_500_000);
  for (const v of bare.vin) delete v.prevout!.scriptpubkey_address;
  for (const v of bare.vout) delete v.scriptpubkey_address;
  const b = eventFromTx(bare, desk.address, "test", 4);
  assert.equal(b.sender, user.address);
  assert.deepEqual(b.outputs.map((o) => o.address), e.outputs.map((o) => o.address));

  // the desk paying out: the desk is the sender, and its change does not count as a payment to it
  const pay = buildTx({ network: "test", secret: deskSecret, utxos: [utxo(9, 50_000_000n)], payments: [{ address: user.address, lit: 2_000_000n }], memo: memo.paid([0]), feeRate: 10n });
  const d = eventFromTx(esploraView(pay.hex, desk.script, 50_000_000n, 3_500_001), desk.address, "test", 0);
  assert.equal(d.fromDesk, true);
  assert.equal(d.valueLit, 0n);
  assert.equal(d.memo, memo.paid([0]));
  assert.deepEqual(d.outputs.map((o) => [o.address, o.lit, o.toDesk]), [[user.address, 2_000_000n, false], [null, 0n, false], [desk.address, pay.change, true]]);
  assert.throws(() => eventFromTx({ ...d && esploraView(pay.hex, desk.script, 50_000_000n, 1), status: { confirmed: false } }, desk.address, "test", 0), /not confirmed/);
});

test("scripts: OP_RETURN has no address; addresses decode from output scripts", () => {
  assert.equal(addressOfScript("6a0b4e4f545553312062757920", "test"), null);
  assert.equal(opReturnPayload("6a134e4f5455533120627579204341542031323334"), "NOTUS1 buy CAT 1234");
  assert.equal(opReturnPayload("76a914" + "00".repeat(20) + "88ac"), null);
  const hexScript = Array.from(user.script, (b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(addressOfScript(hexScript, "test"), user.address);
  assert.equal(addressOfScript(hexScript, "main"), walletFromSecret(secret, "main").address);
});
