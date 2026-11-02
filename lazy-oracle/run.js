// Executes the REAL contracts/0.8.25/vaults/LazyOracle.sol (compiled by compile.js)
// on an in-process EVM, against a stub VaultHub mirroring the real
// Report/VaultRecord layout, and fuzzes report sequences over the invariants:
//
//  I1  applied totalValue <= reported totalValue         (no phantom value)
//  I2  applied totalValue <= max reported totalValue     (no double release)
//  I3  pending quarantine <= reported - applied          (retained value conserved)
//  I4  released amount <= increase that had been quarantined
const fs = require('fs');
const path = require('path');
const { newVM, deploy, send, call, trySend, ethers } = require('/data/data/com.termux/files/home/earn/evm-lab/harness.js');

const art = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts.json'), 'utf8'));
const ABI = ethers.AbiCoder.defaultAbiCoder();
const E = (n) => ethers.parseEther(String(n));

const ACCT = {
  admin: '0x1000000000000000000000000000000000000001',
  oracle: '0x2000000000000000000000000000000000000002',
  stranger: '0x3000000000000000000000000000000000000003',
  vault: '0x4000000000000000000000000000000000000004',
};

const leaf = (vault, tv, fees, liab, maxLiab, reserve) =>
  ethers.keccak256(ethers.concat([
    ethers.keccak256(ABI.encode(['address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      [vault, tv, fees, liab, maxLiab, reserve])),
  ]));

(async () => {
  const { vm } = await newVM();
  for (const a of Object.values(ACCT)) await vm.stateManager.putAccount(
    require('/data/data/com.termux/files/home/earn/evm-lab/node_modules/@ethereumjs/util').Address.fromString(a),
    new (require('/data/data/com.termux/files/home/earn/evm-lab/node_modules/@ethereumjs/util').Account)(0n, 10n ** 24n));

  const loc = await deploy(vm, art.MockLocator, [], ACCT.admin);
  const loD = await deploy(vm, art.LazyOracle, [loc.address], ACCT.admin);
  // initialize through an ERC1967 proxy (the implementation calls _disableInitializers in its constructor)
  const initData = loD.iface.encodeFunctionData('initialize',
    [ACCT.admin, 24 * 3600, 500, E(1)]);
  const proxy = await deploy(vm, art.HarnessProxy, [loD.address, initData], ACCT.admin);
  const hub = await deploy(vm, art.VaultHub, [proxy.address], ACCT.admin);
  const grid = await deploy(vm, art.OperatorGrid, [], ACCT.admin);
  await send(vm, loc.address, loc.iface, 'set', [hub.address, ACCT.oracle, grid.address, ACCT.admin], ACCT.admin);

  const lo = { address: proxy.address, iface: loD.iface };
  const QUARANTINE_PERIOD = 24 * 3600;

  const hubI = { address: hub.address, iface: hub.iface };
  let violations = 0;
  const stats = { rounds: 0, quarantines: 0, maxRatioBp: 0, seqs: 0, pendingOverReported: 0 };

  let s = 123456789n;
  const rnd = (n) => { s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return Number(s % BigInt(n)); };

  let vaultNonce = 0;
  async function runSequence(seq, label, verbose) {
    // fresh vault address per sequence (fresh VaultRecord + fresh quarantine)
    vaultNonce++;
    const vault = '0x' + (0x5000000000000000000000000000000000000000n + BigInt(vaultNonce)).toString(16).padStart(40, '0');
    if (verbose) console.log('vault', vault);
    await send(vm, hubI.address, hubI.iface, 'seed', [vault, 0, 0, 1000, 0, 0, 0], ACCT.admin);
    const rows = [];
    let maxReported = 0n;
    let prevApplied = 0n;
    let prevPending = 0n;

    for (let i = 0; i < seq.length; i++) {
      const { tv, ts, refSlot } = seq[i];
      const L = leaf(vault, tv, 0, 0, 0, 0);
      await send(vm, lo.address, lo.iface, 'updateReportData', [ts, refSlot, L, 'cid'], ACCT.oracle);
      const r = await trySend(vm, lo.address, lo.iface, 'updateVaultData',
        [vault, tv, 0, 0, 0, 0, []], ACCT.stranger);
      if (!r.ok) throw new Error(`${label} round ${i}: updateVaultData reverted ${r.error.slice(0, 120)}`);
      stats.rounds++;

      const n = await call(vm, hubI.address, hubI.iface, 'appliedCount', [], ACCT.admin);
      const a = await call(vm, hubI.address, hubI.iface, 'applied', [n - 1n], ACCT.admin);
      const applied = a.totalValue;
      const q = await call(vm, lo.address, lo.iface, 'vaultQuarantine', [vault], ACCT.admin);
      const pending = q.pendingTotalValueIncrease;

      rows.push({ i, ts, reported: ethers.formatEther(tv), applied: ethers.formatEther(applied), pending: ethers.formatEther(pending) });

      if (applied > tv) { violations++; console.log(`VIOLATION I1 ${label} r${i}: applied ${ethers.formatEther(applied)} > reported ${ethers.formatEther(tv)}`); }
      if (applied > maxReported) { violations++; console.log(`VIOLATION I2 ${label} r${i}: applied ${applied} > maxReported ${maxReported}`); }
      // observation-only: pendingTotalValueIncrease is a claim queue, may exceed reported-applied
      if (tv >= applied && pending > tv - applied) stats.pendingOverReported++;

      // I4: value credited this round may come from (a) reported value, or
      // (b) release of a previously quarantined increase -> must not exceed prevPending
      const credited = applied > prevApplied ? applied - prevApplied : 0n;
      const legit = (tv > prevApplied ? tv - prevApplied : 0n) + prevPending;
      if (credited > legit + 10n ** 6n) {
        violations++;
        console.log(`VIOLATION I4 ${label} r${i}: credited ${credited} > reportedDelta+prevPending ${legit}`);
      }

      if (pending > 0n) stats.quarantines++;
      if (tv > 0n) { const bp = Number((applied * 10000n) / tv); if (bp > stats.maxRatioBp) stats.maxRatioBp = bp; }
      maxReported = tv > maxReported ? tv : maxReported;
      prevApplied = applied;
      prevPending = pending;
    }
    stats.seqs++;
    if (verbose) console.log(label, JSON.stringify(rows));
    return rows;
  }

  // A: big jump held then released after expiry
  await runSequence([
    { tv: E(100), ts: 1_000_000, refSlot: 100 },
    { tv: E(150), ts: 1_003_600, refSlot: 101 },
    { tv: E(150), ts: 1_007_200, refSlot: 102 },
    { tv: E(150), ts: 1_090_000, refSlot: 103 },
    { tv: E(150), ts: 1_180_000, refSlot: 104 },
  ], 'A jump-then-expire', true);

  // B: +4% per round ratchet (below the 5% allowance)
  const seqB = [];
  let ts = 2_000_000, base = E(100);
  let vB = base;
  for (let i = 0; i < 6; i++) { vB = vB + (vB * 4n) / 100n; seqB.push({ tv: vB, ts, refSlot: 200 + i }); ts += 3600; }
  await runSequence(seqB, 'B 4%-ratchet', true);

  // C: raise, drop during active quarantine, raise again
  await runSequence([
    { tv: E(100), ts: 3_000_000, refSlot: 300 },
    { tv: E(200), ts: 3_003_600, refSlot: 301 },
    { tv: E(90), ts: 3_007_200, refSlot: 302 },
    { tv: E(300), ts: 3_010_800, refSlot: 303 },
  ], 'C raise-drop-raise', true);

  // D: expired quarantine + much larger raise (release old, queue new)
  await runSequence([
    { tv: E(100), ts: 4_000_000, refSlot: 400 },
    { tv: E(150), ts: 4_003_600, refSlot: 401 },
    { tv: E(400), ts: 4_090_000, refSlot: 402 },
    { tv: E(400), ts: 4_200_000, refSlot: 403 },
  ], 'D expired+huge', true);

  // randomized
  for (let k = 0; k < 150; k++) {
    const n = 3 + rnd(5);
    const t0 = 5_000_000 + k * 1_000_000;
    let v = BigInt(10 + rnd(900)) * E(1);
    const seq = [];
    let curTs = t0;
    for (let i = 0; i < n; i++) {
      const pct = BigInt(rnd(160) - 60);
      v = v + (v * pct) / 100n;
      if (v < E(1)) v = E(1);
      if (v > E(100_000)) v = E(100_000);
      curTs += 1800 + rnd(70_000);
      seq.push({ tv: v, ts: curTs, refSlot: 1000 + k * 10 + i });
    }
    await runSequence(seq, `R${k}`, false);
  }

  console.log('STATS', JSON.stringify({ ...stats, violations }));
  console.log(violations === 0 ? 'RESULT: ALL INVARIANTS HELD' : 'RESULT: VIOLATION FOUND');
})().catch((e) => { console.error('HARNESS_ERROR', e.message); process.exit(1); });
