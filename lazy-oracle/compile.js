// Compiles the UNMODIFIED Lido V3 sources (LazyOracle + graph) with solc 0.8.25.
const fs = require('fs');
const path = require('path');
const solc = require('/data/data/com.termux/files/home/.hermes/cache/scratch/lidov3/node_modules/solc');

const REPO = '/data/data/com.termux/files/home/.hermes/cache/scratch/lido/repo';
const OZ = '/data/data/com.termux/files/home/.hermes/cache/scratch/lidov3/node_modules/@openzeppelin/contracts';

const entries = process.argv.slice(2);
if (!entries.length) { console.error('usage: node compile.js <src.sol relative to repo>'); process.exit(1); }

const sources = {};
for (const e of entries) {
  const p = fs.existsSync(path.join(REPO, e)) ? path.join(REPO, e) : path.join(__dirname, e);
  sources[e] = { content: fs.readFileSync(p, 'utf8') };
}

const SHADOW = {
  'contracts/0.8.25/vaults/VaultHub.sol': path.join(__dirname, 'stubs/VaultHub.sol'),
  'contracts/0.8.25/vaults/OperatorGrid.sol': path.join(__dirname, 'stubs/OperatorGrid.sol'),
};

function resolveImport(imp) {
  if (SHADOW[imp]) return { contents: fs.readFileSync(SHADOW[imp], 'utf8') };
  const cands = [];
  if (imp.startsWith('@openzeppelin/contracts-v5.2/')) cands.push(path.join(OZ, imp.replace('@openzeppelin/contracts-v5.2/', '')));
  if (imp.startsWith('@openzeppelin/contracts-v4.4/')) cands.push(path.join('/data/data/com.termux/files/home/.hermes/cache/scratch/lidov3/node_modules/oz44', imp.replace('@openzeppelin/contracts-v4.4/', '')));
  if (imp.startsWith('@openzeppelin/contracts-v4')) cands.push(path.join('/data/data/com.termux/files/home/.hermes/cache/scratch/lidov3/node_modules/oz44', imp.replace(/^@openzeppelin\/contracts-v[\d.]+\//, '')));
  if (imp.startsWith('contracts/')) cands.push(path.join(REPO, imp));
  for (const c of cands) if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
  return { error: 'not found: ' + imp };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 100 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const t0 = Date.now();
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const diags = (out.errors || []).filter((e) => /Error|Warning: Unreachable|Stack too deep/i.test(e.severity + e.formattedMessage));
for (const e of (out.errors || [])) if (e.severity === 'error') { console.error(e.formattedMessage.slice(0, 600)); }
if (out.errors && out.errors.some((e) => e.severity === 'error')) { console.error('COMPILE_FAILED'); process.exit(2); }

const art = {};
for (const f of Object.keys(out.contracts || {})) for (const c of Object.keys(out.contracts[f])) {
  const b = out.contracts[f][c];
  if ((b.evm.bytecode.object || '').length > 0) art[c] = { abi: b.abi, bytecode: '0x' + b.evm.bytecode.object };
}
const dest = path.join(__dirname, 'artifacts.json');
fs.writeFileSync(dest, JSON.stringify(art));
console.log('compiled', Object.keys(art).length, 'contracts in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log(Object.keys(art).join(','));
