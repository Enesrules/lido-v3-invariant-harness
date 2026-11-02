// run.js — executes the real PredepositGuarantee.sol (repo HEAD 2bd5322) on an in-process EVM.
// The CL/BLS precompiles (EIP-2537 0x0b..0x11) do not exist in @ethereumjs/vm, so stubs are
// installed at those addresses; everything under test (PDG + CLProofVerifier + SSZ/GIndex/BLS
// Solidity logic, guarantee ledger, stage/pendingActivations pairing) is the unmodified repo code.
const path = require("path");
const { VM } = require("@ethereumjs/vm");
const { Address, Account, hexToBytes, bytesToHex } = require("@ethereumjs/util");
const { Common, Chain, Hardfork } = require("@ethereumjs/common");
const { ethers } = require("ethers");
const arts = require(path.join(__dirname, "artifacts.json"));

const GAS = 30_000_000n;
const A = (s) => Address.fromString(s);
const b32 = ethers.ZeroHash;
let ok = 0, bad = 0;
const CHECK = (name, cond, extra = "") => {
  if (cond) { ok++; console.log("  PASS " + name + (extra ? "  " + extra : "")); }
  else { bad++; console.log("  FAIL " + name + "  " + extra); }
};

async function main() {
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
  const vm = await VM.create({ common });

  const fund = async (addr, wei = 10n ** 24n) => vm.stateManager.putAccount(A(addr), new Account(0n, wei));

  async function deploy(art, args = [], value = 0n) {
    const iface = new ethers.Interface(art.abi);
    let data = art.bytecode;
    const ctor = iface.fragments.filter((f) => f.type === "constructor");
    if (ctor.length === 1 && ctor[0].inputs.length)
      data += ethers.AbiCoder.defaultAbiCoder().encode(ctor[0].inputs, args).slice(2);
    const res = await vm.evm.runCall({ caller: A(DEPLOYER), data: hexToBytes(data), gasLimit: GAS, value });
    if (res.execResult.exceptionError) throw new Error("deploy failed " + res.execResult.exceptionError.error);
    return { address: res.createdAddress.toString(), iface };
  }
  async function send(t, fn, args = [], caller = "0x" + "11".repeat(20), value = 0n) {
    const res = await vm.evm.runCall({
      caller: A(caller), to: A(t.address), data: hexToBytes(t.iface.encodeFunctionData(fn, args)),
      gasLimit: GAS, value,
    });
    const ex = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    if (ex) { const e = new Error("revert " + ex.error); e.revertData = ret; throw e; }
    return ret;
  }
  async function call(t, fn, args = [], caller = "0x" + "11".repeat(20)) {
    const res = await vm.evm.runCall({
      caller: A(caller), to: A(t.address), data: hexToBytes(t.iface.encodeFunctionData(fn, args)), gasLimit: GAS,
    });
    if (res.execResult.exceptionError) throw new Error("call revert " + res.execResult.exceptionError.error);
    const r = t.iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
    return r.length === 1 ? r[0] : r;
  }
  async function tries(fn) { try { await fn(); return { ok: true }; } catch (e) { return { ok: false, data: e.revertData, msg: e.message }; } }
  const sel = (sig) => ethers.id(sig).slice(0, 10);

  // ---- actors
  const DEPLOYER = "0x" + "11".repeat(20);
  const ADMIN = DEPLOYER;
  const NO = "0x" + "22".repeat(20);       // node operator (self-guarantor, self-depositor)
  const GUARANTOR = "0x" + "33".repeat(20);
  const ATTACKER = "0x" + "44".repeat(20);
  for (const a of [DEPLOYER, NO, GUARANTOR, ATTACKER]) await fund(a);

  // ---- EIP-2537 stubs: pairing(0x0f) => 1 ; MAP_FP2_TO_G2(0x11) / G2ADD(0x0d) => 128 zero bytes
  const stubOne = hexToBytes("0x600160005260206000f3");         // return 32-byte 0x..01
  const stubZeros = hexToBytes("0x6101006000f3");               // return 256 zero bytes
  for (const a of ["0x0b", "0x0c", "0x0d", "0x10", "0x11"]) {
    const addr = "0x" + "00".repeat(19) + a.slice(2);
    await vm.stateManager.putAccount(A(addr), new Account(0n, 0n));
    await vm.stateManager.putContractCode(A(addr), stubZeros);
  }
  const PF = A("0x000000000000000000000000000000000000000f");
  await vm.stateManager.putAccount(PF, new Account(0n, 0n));
  await vm.stateManager.putContractCode(PF, stubOne);

  // ---- deploy real PDG (GIndex packed: (1<<40) at depth 40, pivot 0)
  const GI = ethers.zeroPadValue(ethers.toBeHex(((1n << 40n) << 8n) | 40n), 32); // pack(1<<40, 40)
  const impl = await deploy(arts.PredepositGuarantee, ["0x01017000", GI, GI, 0]);
  const proxy = await deploy(arts.TinyProxy, [impl.address]);
  const pdg = { address: proxy.address, iface: impl.iface }; // delegate to real impl
  await send(pdg, "initialize", [ADMIN]);

  console.log("\n[A] guarantee ledger: predeposit locking");
  const vault = await deploy(arts.StakingVault__MockForPDG, [ADMIN, NO, pdg.address]);
  await fund(vault.address, 10n ** 22n); // 10k ETH
  // guarantee top-up: 2 x 1 ETH
  await send(pdg, "topUpNodeOperatorBalance", [NO], NO, ethers.parseEther("2"));
  let bal = await call(pdg, "nodeOperatorBalance", [NO]);
  CHECK("total=2e18 locked=0", bal.total === ethers.parseEther("2") && bal.locked === 0n,
        `total=${ethers.formatEther(bal.total)} locked=${ethers.formatEther(bal.locked)}`);

  // BLS-stubbed deposits (pubkey[0]=0x80 => compressed, sign bit 0, no infinity flag; Y=0)
  const pk = (i) => "0x8001" + i.toString(16).padStart(2, "0") + "00".repeat(45); // 48 bytes, X!=0
  const sig = "0x80" + "00".repeat(95);
  const yFp = { a: b32, b: b32 };
  const yFp2 = { c0_a: b32, c0_b: b32, c1_a: ethers.toBeHex(1, 32), c1_b: b32 }; // non-zero G2 => not infinity
  const dep = (i) => ({ pubkey: pk(i), signature: sig, amount: ethers.parseEther("1"), depositDataRoot: b32 });
  const dY = { pubkeyY: yFp, signatureY: yFp2 };

  const r1 = await tries(() => send(pdg, "predeposit", [vault.address, [dep(1)], [dY]], NO));
  CHECK("predeposit #1 accepted", r1.ok, r1.ok ? "" : (r1.data || r1.msg));
  if (!r1.ok) { console.log("\nharness blocked at predeposit; cannot exercise state machine"); return finish(); }

  let st = await call(pdg, "validatorStatus", [pk(1)]);
  CHECK("status stage PREDEPOSITED(1)", st.stage === 1n, `stage=${st.stage}`);
  CHECK("pendingActivations=1", (await call(pdg, "pendingActivations", [vault.address])) === 1n);
  CHECK("vault staged=31e18", (await call(vault, "stagedBalance")) === ethers.parseEther("31"));
  bal = await call(pdg, "nodeOperatorBalance", [NO]);
  CHECK("locked=1e18 after 1 predeposit", bal.locked === ethers.parseEther("1"));

  // invariant: same pubkey cannot be predeposited twice (double-spend of one guarantee slot)
  const r2 = await tries(() => send(pdg, "predeposit", [vault.address, [dep(1)], [dY]], NO));
  CHECK("2nd predeposit of same pubkey reverts ValidatorNotNew", !r2.ok && r2.data?.startsWith(sel("ValidatorNotNew(bytes,uint8)")),
        (r2.data || "").slice(0, 10));
  CHECK("pendingActivations still 1", (await call(pdg, "pendingActivations", [vault.address])) === 1n);

  // invariant: a non-depositor cannot predeposit for this NO
  const r3 = await tries(() => send(pdg, "predeposit", [vault.address, [dep(2)], [dY]], ATTACKER));
  CHECK("stranger predeposit reverts NotDepositor", !r3.ok && r3.data?.startsWith(sel("NotDepositor()")), (r3.data || "").slice(0, 10));

  // guarantee cannot be over-committed: 2nd of the 2 funded ETH is fine, a 3rd is not
  const r4 = await tries(() => send(pdg, "predeposit", [vault.address, [dep(3)], [dY]], NO));
  CHECK("2nd predeposit within guarantee accepted", r4.ok, r4.ok ? "" : (r4.data || r4.msg));
  const r4b = await tries(() => send(pdg, "predeposit", [vault.address, [dep(5)], [dY]], NO));
  CHECK("over-commit reverts NotEnoughUnlocked",
        !r4b.ok && r4b.data?.startsWith(sel("NotEnoughUnlocked(uint256,uint256)")), (r4b.data || "").slice(0, 10));

  console.log("\n[B] locked guarantee cannot be withdrawn by guarantor");
  const r5 = await tries(() => send(pdg, "withdrawNodeOperatorBalance", [NO, ethers.parseEther("1"), NO], NO));
  CHECK("withdraw of locked 1 ETH reverts NotEnoughUnlocked", !r5.ok && r5.data?.startsWith(sel("NotEnoughUnlocked(uint256,uint256)")), (r5.data || "").slice(0, 10));
  const r6 = await tries(() => send(pdg, "setNodeOperatorGuarantor", [GUARANTOR], NO));
  CHECK("guarantor swap with locked!=0 reverts LockedIsNotZero", !r6.ok && r6.data?.startsWith(sel("LockedIsNotZero(uint256)")), (r6.data || "").slice(0, 10));

  console.log("\n[C] pendingActivations <=> stagedBalance pairing on the predeposit path");
  // 2nd predeposit -> pending=2, staged=62 ; must hold as a strict equality (VaultHub.sol:382)
  const r7 = await tries(() => send(pdg, "predeposit", [vault.address, [dep(4)], [dY]], NO, ethers.parseEther("1")));
  CHECK("2nd predeposit w/ inline top-up accepted", r7.ok, r7.ok ? "" : r7.msg);
  const pend = await call(pdg, "pendingActivations", [vault.address]);
  const stg = await call(vault, "stagedBalance");
  CHECK("staged == pending*31 (VaultHub connect invariant)",
        stg === pend * ethers.parseEther("31"), `pending=${pend} staged=${ethers.formatEther(stg)}`);
  bal = await call(pdg, "nodeOperatorBalance", [NO]);
  CHECK("locked == 1 ETH * pendingActivations", bal.locked === pend * ethers.parseEther("1"), `locked=${ethers.formatEther(bal.locked)}`);

  finish();
}
function finish() {
  console.log(`\nchecks: ${ok} passed, ${bad} failed`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
