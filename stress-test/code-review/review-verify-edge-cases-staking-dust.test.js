// Second-reviewer verification of the finding
//   "Staking: fee tranches smaller than totalStaked/1e18 micro-USDC round to zero but are still
//    marked as accounted, so the USDC is stuck for good"   (Staking.sol, _sync)
//
// Part 1 runs the contracts exactly as they are, through the engine. Each test PASSES when the
// claim reproduces: the assertions pin the claimed numbers.
//
// Part 2 checks candidate fixes. Nothing under contracts/src is touched: each candidate is the
// text of src/Staking.sol with an edit applied, compiled in memory with the solc that ships with
// Hardhat, and (for the engine runs) installed at the fixture's staking address before first use.
//
// Run only this file:  npx hardhat test test/review-verify-edge-cases-staking-dust.test.js

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const path = require("path");
const { deploy, marketConfig, usd, px, BTC } = require("./helpers");

const f6 = (v) => ethers.formatUnits(v, 6);
const OLQ = (n) => ethers.parseEther(String(n));
const note = (...a) => console.log("        ", ...a);
const OVERFLOW = 0x11; // Solidity panic for checked arithmetic, here `accounted -= amount`

// ---- candidate fixes, as edits to the source under review -------------------------------------

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "Staking.sol"), "utf8");

function edit(src, from, to, times) {
  const parts = src.split(from);
  if (parts.length - 1 !== times) throw new Error(`expected ${times} x "${from}", found ${parts.length - 1}`);
  return parts.join(to);
}

const CLAIM_LINE = "        amount = _owed[msg.sender];\n";
const SYNC_LINES =
  "            accPerShare += ((bal - accounted) * 1e18) / totalStaked;\n" + "            accounted = bal;\n";

const CANDIDATES = {
  // The scale alone: every 1e18 in the accumulator arithmetic becomes 1e30 (seven places + a comment).
  scale30: edit(SRC, "1e18", "1e30", 8),
  // The first reviewer's first suggestion.
  scale36: edit(SRC, "1e18", "1e36", 8),
  // The first reviewer's second suggestion, as worded: advance `accounted` by what was distributed.
  carry: edit(
    SRC,
    SYNC_LINES,
    "            uint256 inc = ((bal - accounted) * 1e18) / totalStaked;\n" +
      "            accPerShare += inc;\n" +
      "            accounted += (inc * totalStaked) / 1e18;\n",
    1
  ),
  // Recommended: the scale, plus one line so a claim can never ask for more than is accounted.
  fixed: edit(
    edit(SRC, "1e18", "1e30", 8),
    CLAIM_LINE,
    CLAIM_LINE + "        if (amount > accounted) amount = accounted;\n",
    1
  ),
};

function compile(sources) {
  const solc = require("solc");
  const modules = path.join(__dirname, "..", "node_modules");
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(sources).map(([k, content]) => [`${k}.sol`, { content }])),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
      outputSelection: { "*": { Staking: ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (p) => {
        try {
          return { contents: fs.readFileSync(path.join(modules, p), "utf8") };
        } catch (e) {
          return { error: `not found: ${p}` };
        }
      },
    })
  );
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  return Object.fromEntries(Object.keys(sources).map((k) => [k, out.contracts[`${k}.sol`].Staking]));
}

let built;
async function factoryFor(candidate) {
  if (!candidate) return ethers.getContractFactory("Staking");
  const [owner] = await ethers.getSigners();
  return new ethers.ContractFactory(built[candidate].abi, "0x" + built[candidate].evm.bytecode.object, owner);
}

// ---- the venue, from helpers.js ---------------------------------------------------------------

/** Push a price and hold it for 50 averaging times, so mid == slow exactly and fills have no gap. */
async function settleAt(ctx, price) {
  await ctx.push(BTC, px(price));
  await time.increase(3000);
  await ctx.push(BTC, px(price));
}

/**
 * The fixture, a BTC market, and Alice holding OLQ earned the only way there is: a winning close.
 * 3,000,000 long, +10%: profit 300,000 (her 10x cap), fee 15,000, which mints 1,477,832.5 OLQ.
 */
async function world(candidate) {
  const ctx = await deploy();
  if (candidate) {
    // Same constructor arguments, so the same immutables; the fixture's instance has no state yet.
    const twin = await (await factoryFor(candidate)).deploy(ctx.token.target, ctx.usdc.target);
    await twin.waitForDeployment();
    await network.provider.send("hardhat_setCode", [ctx.staking.target, await ethers.provider.getCode(twin.target)]);
  }
  const { engine, vault, lp, alice } = ctx;
  await engine.setMarket(BTC, marketConfig());
  await vault.connect(lp).deposit(usd(5_000_000), lp.address);
  await settleAt(ctx, 60_000);
  await engine.connect(alice).open(BTC, true, usd(30_000), 100, false, "0x");
  await settleAt(ctx, 66_000);
  const [pos] = await engine.positionsOf(alice.address);
  await engine.connect(alice).close(pos.id, "0x");
  expect(await ctx.usdc.balanceOf(ctx.staking.target), "nobody staked yet: no staker share").to.equal(0n);
  return ctx;
}

async function stakeOlq(ctx, who, amount) {
  await ctx.token.connect(who).approve(ctx.staking.target, amount);
  await ctx.staking.connect(who).stake(amount);
}

/**
 * n winning closes by Bob. Each is a 10,000 long (100 margin at 100x) that gains 0.6%:
 * profit 60, fee 3.00 (5%), stakers' share 0.90 (30% of the fee).
 */
async function smallWins(ctx, n, afterEach = async () => {}, margin = 100) {
  const { engine, usdc, staking, bob, push } = ctx;
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) await push(BTC, px(66_000)); // keep the price inside maxAge
    await engine.connect(bob).open(BTC, true, usd(margin), 100, false, "0x");
  }
  await settleAt(ctx, 66_396);
  const ids = (await engine.positionsOf(bob.address)).map((v) => v.id);
  let sent = 0n;
  const sizes = new Set();
  for (let i = 0; i < ids.length; i++) {
    if (i % 5 === 0) await push(BTC, px(66_396));
    const before = await usdc.balanceOf(staking.target);
    await engine.connect(bob).close(ids[i], "0x");
    const tranche = (await usdc.balanceOf(staking.target)) - before;
    sent += tranche;
    sizes.add(tranche);
    await afterEach(i);
  }
  return { sent, sizes: [...sizes] };
}

async function claimOf(ctx, who) {
  const before = await ctx.usdc.balanceOf(who.address);
  await ctx.staking.connect(who).claim();
  return (await ctx.usdc.balanceOf(who.address)) - before;
}

// ---- the staking contract on its own ----------------------------------------------------------

/** Staking with a mintable stake token, so stakes can be exact. Amounts of `olq` are 18-dp wei. */
async function bare(candidate) {
  const [, a, b, c, d] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockUSDC");
  const usdc = await Mock.deploy();
  const olq = await Mock.deploy(); // Staking only sees an ERC-20; the decimals label is irrelevant
  const staking = await (await factoryFor(candidate)).deploy(olq.target, usdc.target);
  const stake = async (who, wei) => {
    await olq.mint(who.address, wei);
    await olq.connect(who).approve(staking.target, wei);
    await staking.connect(who).stake(wei);
  };
  const fee = (micro) => usdc.mint(staking.target, micro); // "Fees arrive as plain transfers"
  return { usdc, olq, staking, stake, fee, users: [a, b, c, d] };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random stakes, unstakes, claims and fees among four accounts, then everyone leaves and claims.
 * A sixty-digit model that never rounds says what each account was due.
 */
async function fuzz(candidate, seed, steps) {
  const { usdc, staking, stake, fee, users } = await bare(candidate);
  const rand = rng(seed);
  const pick = (n) => Math.floor(rand() * n);
  // Up to 2,000,000 OLQ with all eighteen decimals in use, as minted balances have.
  const someOlq = () => BigInt(1 + pick(2_000_000)) * 10n ** 18n + BigInt(pick(1e9)) * 10n ** 9n + BigInt(pick(1e9));

  const M = 10n ** 60n;
  const model = { acc: 0n, unsynced: 0n, total: 0n };
  const book = new Map(users.map((u) => [u.address, { staked: 0n, mark: 0n, due: 0n, claimed: 0n }]));
  const touch = (u) => {
    if (model.unsynced > 0n && model.total > 0n) {
      model.acc += (model.unsynced * M) / model.total;
      model.unsynced = 0n;
    }
    const m = book.get(u.address);
    m.due += m.staked * (model.acc - m.mark);
    m.mark = model.acc;
    return m;
  };

  let feesIn = 0n;
  let refused = 0;
  let blocked = 0n; // the largest claim that reverted
  let shortBy = 0n; // and the most `accounted` fell short of a claim, in micro-USDC
  const doStake = async (u, wei) => {
    const m = touch(u);
    await stake(u, wei);
    m.staked += wei;
    model.total += wei;
  };
  const doUnstake = async (u, wei) => {
    const m = touch(u);
    await staking.connect(u).unstake(wei);
    m.staked -= wei;
    model.total -= wei;
  };
  const doClaim = async (u) => {
    const m = touch(u);
    const before = await usdc.balanceOf(u.address);
    try {
      await staking.connect(u).claim();
    } catch (e) {
      // The only revert a claim may hit here is `accounted -= amount` underflowing.
      expect(e.message, "a refused claim is the accounted underflow and nothing else").to.match(/panic code 0x11/);
      const owed = await staking.pending(u.address);
      const have = await staking.accounted();
      refused++;
      if (owed > blocked) blocked = owed;
      if (owed - have > shortBy) shortBy = owed - have;
      return;
    }
    m.claimed += (await usdc.balanceOf(u.address)) - before;
  };

  for (let i = 0; i < steps; i++) {
    const u = users[pick(users.length)];
    const r = rand();
    if (r < 0.2) await doStake(u, someOlq());
    else if (r < 0.3) {
      const s = book.get(u.address).staked;
      if (s > 0n) await doUnstake(u, (s * BigInt(1 + pick(1000))) / 1000n);
    } else if (r < 0.5) await doClaim(u);
    else if (model.total > 0n) {
      // The engine sends a share only while somebody is staked. Mostly small closes, some large.
      const amount = rand() < 0.7 ? BigInt(1 + pick(3_000_000)) : BigInt(1 + pick(500_000_000));
      await fee(amount);
      model.unsynced += amount;
      feesIn += amount;
    }
    if (candidate === "fixed") {
      expect(await staking.accounted(), "accounted never exceeds the balance").to.be.lte(
        await usdc.balanceOf(staking.target)
      );
    }
  }
  for (const u of users) {
    const s = book.get(u.address).staked;
    if (s > 0n) await doUnstake(u, s);
  }
  for (const u of users) await doClaim(u);

  let claimed = 0n;
  let worstShort = 0n;
  let worstOver = 0n;
  for (const m of book.values()) {
    claimed += m.claimed;
    const due = m.due / M;
    if (due - m.claimed > worstShort) worstShort = due - m.claimed;
    if (m.claimed - due > worstOver) worstOver = m.claimed - due;
  }
  const stuck = await usdc.balanceOf(staking.target);
  expect(claimed + stuck, "every micro-USDC is either claimed or still in the contract").to.equal(feesIn);
  return { feesIn, claimed, stuck, refused, blocked, shortBy, worstShort, worstOver };
}

// =================================================================================================

describe("Verify: Staking loses fee tranches to the 1e18 accumulator scale", function () {
  this.timeout(900_000);

  before(() => {
    built = compile(CANDIDATES);
  });

  describe("Part 1: the contracts as they are, through the engine", () => {
    it("V1 1,000,000 OLQ staked, 100 closes of 0.90 each, a non-staker calls claim() after each: 0 claimable, 90 stuck", async () => {
      const ctx = await world();
      const { usdc, token, staking, alice, bob, carol } = ctx;
      note(`Alice's 15,000 fee minted ${ethers.formatEther(await token.balanceOf(alice.address))} OLQ; she stakes 1,000,000`);
      await stakeOlq(ctx, alice, OLQ(1_000_000));

      expect(await staking.staked(carol.address)).to.equal(0n);
      const { sent, sizes } = await smallWins(ctx, 100, () => staking.connect(carol).claim());
      expect(sizes, "every close sent exactly 0.90").to.deep.equal([usd(0.9)]);
      expect(sent).to.equal(usd(90));

      // (900,000 * 1e18) / 1e24 == 0, a hundred times, and each time `accounted` took the 0.90.
      expect(await staking.accPerShare()).to.equal(0n);
      expect(await staking.accounted()).to.equal(usd(90));
      expect(await staking.pending(alice.address)).to.equal(0n);
      expect(await claimOf(ctx, alice), "the sole staker's claim").to.equal(0n);
      expect(await usdc.balanceOf(staking.target)).to.equal(usd(90));

      // "Stuck for good": leaving does not release it, and a later staker is paid later fees only.
      await staking.connect(alice).unstake(OLQ(1_000_000));
      expect(await claimOf(ctx, alice)).to.equal(0n);
      expect(await staking.totalStaked()).to.equal(0n);
      await stakeOlq(ctx, bob, OLQ(1));
      await usdc.mint(staking.target, usd(5)); // the next fee
      expect(await claimOf(ctx, bob), "a later staker gets the later fee").to.equal(usd(5));
      await staking.connect(bob).unstake(OLQ(1));
      expect(await claimOf(ctx, bob)).to.equal(0n);
      expect(await staking.totalStaked()).to.equal(0n);
      expect(await usdc.balanceOf(staking.target), "nobody is staked or owed, the 90 is still there").to.equal(usd(90));
      expect(await staking.accounted()).to.equal(usd(90));
      note(`sent ${f6(sent)}; sole staker claimed 0; ${f6(await usdc.balanceOf(staking.target))} left with no stake and no claim on it`);
    });

    it("V2 control: the same 100 closes with nobody touching Staking in between pay the staker 90.00", async () => {
      const ctx = await world();
      const { usdc, staking, alice } = ctx;
      await stakeOlq(ctx, alice, OLQ(1_000_000));
      const { sent } = await smallWins(ctx, 100);
      expect(sent).to.equal(usd(90));
      expect(await staking.pending(alice.address)).to.equal(usd(90));
      expect(await claimOf(ctx, alice)).to.equal(usd(90));
      expect(await usdc.balanceOf(staking.target)).to.equal(0n);
      note("one sync of 90.00 divides exactly: the loss in V1 is made by the syncs, not by the fees");
    });

    it("V3 no griefer needed: each winner stakes the OLQ the close just paid him, and every 0.90 is lost", async () => {
      const ctx = await world();
      const { usdc, token, staking, alice, bob } = ctx;
      await stakeOlq(ctx, alice, OLQ(1_000_000));
      await token.connect(bob).approve(staking.target, ethers.MaxUint256);
      const { sent } = await smallWins(ctx, 100, async () =>
        staking.connect(bob).stake(await token.balanceOf(bob.address))
      );
      expect(sent).to.equal(usd(90));
      expect(await staking.accPerShare()).to.equal(0n);
      expect(await staking.pending(alice.address)).to.equal(0n);
      expect(await staking.pending(bob.address)).to.equal(0n);
      expect(await usdc.balanceOf(staking.target)).to.equal(usd(90));
      note(
        `stake() syncs too: ${ethers.formatEther(await staking.totalStaked())} OLQ staked, ` +
          `${f6(sent)} sent, 0 claimable by either staker`
      );
    });

    it("V4 a larger tranche loses its remainder: 26.10 arrives, 26.00 is claimable, 0.10 stays", async () => {
      const ctx = await world();
      const { usdc, staking, alice } = ctx;
      await stakeOlq(ctx, alice, OLQ(1_000_000));
      const { sent } = await smallWins(ctx, 1, async () => {}, 2_900); // 290,000 long: profit 1,740, fee 87
      expect(sent).to.equal(usd(26.1));
      expect(await claimOf(ctx, alice)).to.equal(usd(26));
      expect(await staking.pending(alice.address)).to.equal(0n);
      expect(await usdc.balanceOf(staking.target)).to.equal(usd(0.1));
      expect(await staking.accounted()).to.equal(usd(0.1));
    });
  });

  describe("Part 2: candidate fixes", () => {
    for (const candidate of ["scale30", "scale36", "fixed"]) {
      it(`F1 ${candidate}: V1 again through the engine pays the staker the full 90.00`, async () => {
        const ctx = await world(candidate);
        const { usdc, staking, alice, carol } = ctx;
        await stakeOlq(ctx, alice, OLQ(1_000_000));
        const { sent } = await smallWins(ctx, 100, () => staking.connect(carol).claim());
        expect(sent).to.equal(usd(90));
        expect(await staking.pending(alice.address)).to.equal(usd(90));
        expect(await claimOf(ctx, alice)).to.equal(usd(90));
        expect(await usdc.balanceOf(staking.target)).to.equal(0n);
      });
    }

    it("F2 the 'carry the remainder' suggestion as worded makes claim() revert for any stake that is not a whole number of OLQ", async () => {
      const { staking, stake, fee, users } = await bare("carry");
      const [alice, , , outsider] = users;
      await stake(alice, 1_477_832_512315270935960591n); // what the 15,000 fee minted in V1
      for (let i = 0; i < 2; i++) {
        await fee(usd(2));
        await staking.connect(outsider).claim(); // sync
      }
      // accounted advanced by floor(1,477,832.51) twice = 2,955,664; she is credited floor(2,955,665.02).
      expect(await staking.accounted()).to.equal(2_955_664n);
      expect(await staking.pending(alice.address)).to.equal(2_955_665n);
      await expect(staking.connect(alice).claim()).to.be.revertedWithPanic(OVERFLOW);
    });

    for (const [candidate, pays] of [
      [null, false],
      ["scale30", false],
      ["fixed", true],
    ]) {
      it(`F3 ${candidate || "as it is"}: when per-account rounding credits 1 micro-USDC more than arrived, the last claim ${pays ? "is paid what is there" : "reverts"}`, async () => {
        const { usdc, staking, stake, fee, users } = await bare(candidate);
        const [a, b, c] = users;
        await stake(c, OLQ(1_000_000));
        await fee(usd(1)); // 1 micro-USDC per OLQ
        await stake(a, OLQ("500000.5")); // debt is floor(500,000.5)
        await stake(b, OLQ("500000.5"));
        await fee(usd("2.000001")); // exactly 1 more micro-USDC per OLQ on 2,000,001 OLQ
        const owed = [c, a, b].map((u) => staking.pending(u.address));
        expect(await Promise.all(owed)).to.deep.equal([2_000_000n, 500_001n, 500_001n]); // 3,000,002 against 3,000,001
        await staking.connect(c).claim();
        await staking.connect(a).claim();
        if (!pays) {
          await expect(staking.connect(b).claim()).to.be.revertedWithPanic(OVERFLOW);
        } else {
          const before = await usdc.balanceOf(b.address);
          await staking.connect(b).claim();
          expect((await usdc.balanceOf(b.address)) - before).to.equal(500_000n);
          expect(await usdc.balanceOf(staking.target)).to.equal(0n);
        }
      });
    }

    it("F4 random stakes, unstakes, claims and fees, then everyone leaves: what is lost, and whether a claim is ever refused", async () => {
      const STEPS = 250;
      const tally = {};
      for (const candidate of [null, "scale30", "fixed"]) {
        const t = (tally[candidate || "as it is"] = {
          feesIn: 0n,
          stuck: 0n,
          refused: 0,
          blocked: 0n,
          shortBy: 0n,
          worstShort: 0n,
          worstOver: 0n,
        });
        for (const seed of [1, 2, 3, 4]) {
          const r = await fuzz(candidate, seed, STEPS);
          t.feesIn += r.feesIn;
          t.stuck += r.stuck;
          t.refused += r.refused;
          for (const k of ["blocked", "shortBy", "worstShort", "worstOver"]) if (r[k] > t[k]) t[k] = r[k];
          if (candidate === "fixed") {
            expect(r.refused, `seed ${seed}: no claim reverts`).to.equal(0);
            expect(r.stuck, `seed ${seed}: left behind, in micro-USDC`).to.be.lte(BigInt(STEPS));
            expect(r.worstShort, `seed ${seed}: worst underpayment, in micro-USDC`).to.be.lte(BigInt(STEPS));
            expect(r.worstOver, `seed ${seed}: worst overpayment, in micro-USDC`).to.be.lte(BigInt(STEPS));
          }
        }
      }
      for (const [name, t] of Object.entries(tally)) {
        note(
          `${name.padEnd(9)} fees ${f6(t.feesIn)}  left behind ${f6(t.stuck)}  worst account short ${f6(t.worstShort)} / over ${f6(t.worstOver)}` +
            `  claims reverted ${t.refused}` +
            (t.refused ? ` (largest ${f6(t.blocked)}, for want of ${t.shortBy} micro-USDC)` : "")
        );
      }
      expect(tally["as it is"].stuck, "the contract as it is leaves real money behind").to.be.gt(usd(10));
      // The scale alone removes the slack that used to hide per-account rounding: claims revert.
      expect(tally.scale30.refused, "scale alone: some claim reverts").to.be.gt(0);
      expect(tally.scale30.shortBy, "and only for a few micro-USDC").to.be.lte(BigInt(STEPS));
    });

    for (const [candidate, bricked] of [
      ["scale36", true],
      ["scale30", false],
    ]) {
      it(`F5 ${candidate}: a sole 1-wei staker cycles 120bn USDC through the contract at no cost; a 1,000,000 OLQ stake then ${bricked ? "overflows" : "still works"}`, async () => {
        const { usdc, olq, staking, stake, users } = await bare(candidate);
        const [attacker, whale] = users;
        await stake(attacker, 1n);
        const lot = usd(10_000_000_000);
        await usdc.mint(attacker.address, lot);
        for (let i = 0; i < 12; i++) {
          await usdc.connect(attacker).transfer(staking.target, lot);
          await staking.connect(attacker).claim(); // the sole staker is owed all of it back
        }
        expect(await usdc.balanceOf(attacker.address), "the attacker has every dollar back").to.equal(lot);
        await olq.mint(whale.address, OLQ(1_000_000));
        await olq.connect(whale).approve(staking.target, OLQ(1_000_000));
        if (bricked) {
          await expect(staking.connect(whale).stake(OLQ(1_000_000))).to.be.revertedWithPanic(OVERFLOW);
        } else {
          await staking.connect(whale).stake(OLQ(1_000_000));
          expect(await staking.staked(whale.address)).to.equal(OLQ(1_000_000));
        }
      });
    }
  });
});
