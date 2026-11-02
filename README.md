# lido-v3-invariant-harness

An offline harness that compiles **unmodified** Lido V3 sources (`lidofinance/core` @ `2bd5322`) and executes
invariant checks against real contract bytecode on an in-process EVM. No fork, no archive node, no API key,
no network. One run is a few seconds.

    node compile.js && node run.js     # 16/16 checks pass

## What it is for

Reading a contract answers "what does this line do". It does not answer "can this invariant break after 50
hundreds of state transitions I did not imagine". This harness is the second question, applied to the two
places where Lido V3 holds user money:

**`predeposit_guarantee` — guarantee and proof accounting**

| Check | Holds because |
|---|---|
| invalid deposit cannot dodge slashing | `proveInvalidValidatorWC` is the only writer of `COMPENSATED` and decrements `total`/`locked` in the same tx (PDG:586,592) |
| the same deposit cannot be proven twice | the 1 ETH unlock is reachable only under `stage == PREDEPOSITED` (PDG:466,684-690) |
| a valid deposit cannot be confiscated | `WithdrawalCredentialsMatch()` (PDG:580) blocks seizure unless the proven WC differs from the vault's; the WC is bound to the pubkey at `CLProofVerifier.sol:160` |
| `pendingActivations` cannot drift from `stagedBalance` | both sides move only inside PDG (`predeposit` +len / `stage` 31xlen, activate -1 / unstage 31, compensate -1 / unstage 31); harness asserts `staged == pending*31` and `locked == pending*1 ETH` after every transition |

**`LazyOracle` — quarantine and valuation accounting** (separate harness in `lazy-oracle/`)

744 report rounds, 154 sequences, 651 quarantine entries, 0 violations across five invariants: applied <=
reported per round, applied never exceeds max-ever-reported, an increase is not credited before
`start + quarantinePeriod`, credited <= reported delta + previously pending, and the sub-`maxRewardRatioBP`
ratchet cannot smuggle value.

## Honest result

**No finding.** The harnesses were built to break these invariants and did not. The write-up of what was
exercised, what held, and why, is in `FINDING.md`. Two informational observations are recorded there and are
explicitly *not* claimed as vulnerabilities: `quarantineValue()` can exceed `reported - applied` while a
quarantine is maintained (134/744 rounds, no credit impact), and a vault owner can unstage 31 ETH reserved for
a pending validator and brick their own `connectVault` (self-inflicted, no attacker gain).

Publishing the negative result on purpose: a harness that can say "this held, here is the run" is the useful
artifact. Anyone can rerun it and check the claim.

## Layout

    compile.js      solc-js standard-JSON compile of the real repo sources (viaIR, repo optimizer settings)
    run.js          the invariant checks; prints PASS/FAIL per assertion and a summary count
    TinyProxy.sol   20-line ERC1967-style proxy so initializer-guarded implementations can be driven
    artifacts.json  compiled output, committed so the harness runs without solc installed
    lazy-oracle/    the LazyOracle/VaultHub harness (stub-based, see its README)

Only the EIP-2537 precompiles (0x0b-0x11) are stubbed, so `BLS.verifyDepositMessage` can pass; everything
under test is real repo bytecode.

## Reproducing

    git clone https://github.com/lidofinance/core && cd core && git checkout 2bd5322
    node --version   # 20+; this was run on Android/Termux aarch64
    npm i @ethereumjs/vm @ethereumjs/util @ethereumjs/common ethers solc@0.8.25
    node compile.js && node run.js
