// compile.js — compiles the UNMODIFIED Lido PDG sources from the repo at HEAD 2bd5322.
const fs = require("fs");
const path = require("path");
const solc = require("/data/data/com.termux/files/home/.hermes/cache/scratch/lidov3/node_modules/solc");

const REPO = "/data/data/com.termux/files/home/.hermes/cache/scratch/lido/repo";
const OUT = path.join(__dirname, "artifacts.json");

const ENTRIES = [
  "contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee.sol",
  "test/0.8.25/vaults/predepositGuarantee/contracts/StakingVault__MockForPDG.sol",
];

const sources = {};
for (const e of ENTRIES) sources[e] = { content: fs.readFileSync(path.join(REPO, e), "utf8") };
sources["TinyProxy.sol"] = { content: fs.readFileSync(path.join(__dirname, "TinyProxy.sol"), "utf8") };

// solc remappings: contracts-v5.2/ is the repo's vendored OZ v5.2 (absent here) -> evm-lab OZ v5
function readImport(p) {
  const remap = {
    "@openzeppelin/contracts-v5.2/": "/data/data/com.termux/files/home/earn/evm-lab/node_modules/@openzeppelin/contracts/",
    "contracts-v5.2/": "/data/data/com.termux/files/home/earn/evm-lab/node_modules/@openzeppelin/contracts/",
  };
  for (const [from, to] of Object.entries(remap)) {
    if (p.startsWith(from)) p = to + p.slice(from.length);
  }
  for (const c of [p, path.join(REPO, p)]) {
    if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
  }
  return { error: "not found: " + p };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: readImport }));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) {
  console.error(errs.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
const arts = {};
for (const [file, cs] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(cs)) {
    arts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, file };
  }
}
fs.writeFileSync(OUT, JSON.stringify(arts, null, 1));
console.log("compiled:", Object.keys(arts).join(", "));
