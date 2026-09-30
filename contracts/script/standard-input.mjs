// Blockscout verification by hand, for when `forge verify-contract` keeps
// retrying: the Standard JSON input of a contract, rebuilt from the artifact
// `forge build` wrote — the very sources it compiled (their hashes are checked
// against the metadata), the same remappings, optimizer and EVM version.
// Upload it on the contract's page under Verify & publish → "Solidity
// (Standard JSON input)", with the compiler version it prints and the
// ABI-encoded constructor arguments (`cast abi-encode`).
//
//   cd contracts && forge build
//   node script/standard-input.mjs src/Launchpad.sol:Launchpad src/UniV2Migrator.sol:UniV2Migrator \
//     lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController
//   → out/verify/<Name>.standard-input.json
import fs from "node:fs";
import path from "node:path";
import { keccak_256 } from "../../web/node_modules/@noble/hashes/sha3.js";

const root = path.resolve(import.meta.dirname, "..");
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("usage: node script/standard-input.mjs <path/File.sol>:<Name> …");
  process.exit(1);
}
fs.mkdirSync(path.join(root, "out/verify"), { recursive: true });
for (const target of targets) {
  const [file, name] = target.split(":");
  if (!file || !name) throw new Error(`${target}: expected <path/File.sol>:<Name>`);
  const artifact = path.join(root, "out", path.basename(file), `${name}.json`);
  if (!fs.existsSync(artifact)) throw new Error(`${artifact} is missing: run forge build first`);
  const art = JSON.parse(fs.readFileSync(artifact, "utf8"));
  const md = JSON.parse(art.rawMetadata);
  const sources = {};
  for (const [p, info] of Object.entries(md.sources)) {
    const content = fs.readFileSync(path.join(root, p), "utf8");
    const hash = "0x" + Buffer.from(keccak_256(new TextEncoder().encode(content))).toString("hex");
    if (hash !== info.keccak256) throw new Error(`${p}: the file on disk is not the one compiled (hash mismatch): run forge build again`);
    sources[p] = { content };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      remappings: md.settings.remappings,
      optimizer: md.settings.optimizer,
      evmVersion: md.settings.evmVersion,
      metadata: { bytecodeHash: md.settings.metadata?.bytecodeHash ?? "ipfs" },
      libraries: {},
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata"] } },
    },
  };
  const out = path.join(root, "out/verify", `${name}.standard-input.json`);
  fs.writeFileSync(out, JSON.stringify(input, null, 1));
  console.log(
    `${name}: ${Object.keys(sources).length} sources · solc ${md.compiler.version} · evm ${md.settings.evmVersion} · optimizer ${JSON.stringify(md.settings.optimizer)} → ${path.relative(process.cwd(), out)}`
  );
}
