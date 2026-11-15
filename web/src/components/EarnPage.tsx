import { useState } from "react";
import { claimFees, connectDemo, stake, unstake, vaultDeposit, vaultWithdraw } from "../data/wallet";
import { fmtCompactUsd, fmtNumber, fmtPct, fmtUsd } from "../lib/format";
import { useStore } from "../state/store";
import { Num, Spinner } from "./primitives";

function AmountForm({
  unit,
  actions,
}: {
  unit: string;
  actions: { label: string; primary?: boolean; max: number; run: (amount: number) => Promise<boolean> }[];
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const account = useStore((s) => s.account);
  const amount = Number(text) || 0;

  return (
    <div className="form-row" style={{ gridTemplateColumns: `1fr ${actions.map(() => "auto").join(" ")}` }}>
      <label className="amount">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))}
          aria-label={`Amount in ${unit}`}
        />
        <em>{unit}</em>
      </label>
      {actions.map((a) => (
        <button
          key={a.label}
          className={`btn ${a.primary ? "btn-primary" : "btn-ghost"}`}
          disabled={!account || !!busy || amount <= 0 || amount > a.max + 1e-9}
          title={amount > a.max ? `At most ${fmtNumber(a.max, 2)} ${unit}` : undefined}
          onClick={async () => {
            setBusy(a.label);
            if (await a.run(amount)) setText("");
            setBusy(null);
          }}
        >
          {busy === a.label ? <Spinner /> : null}
          {a.label}
        </button>
      ))}
    </div>
  );
}

export function EarnPage() {
  const vault = useStore((s) => s.vault);
  const staking = useStore((s) => s.staking);
  const balances = useStore((s) => s.balances);
  const account = useStore((s) => s.account);
  const stakerShare = useStore((s) => s.params.stakerShare);
  const [claiming, setClaiming] = useState(false);

  const cash = vault?.cash ?? 0;
  const part = (v: number) => `${cash ? (v / cash) * 100 : 0}%`;

  return (
    <main className="page">
      <div className="page-inner">
        <div>
          <h2>
            Two ways to earn, <em>kept apart.</em>
          </h2>
          <p className="lede">
            Liquidity providers take the other side of every trade, so trader losses and wins belong to them. OLQ
            stakers take none of that risk and receive {fmtPct(stakerShare, 0, false)} of the fees winners pay. Nobody
            is paid out of anyone's losses for holding a token.
          </p>
        </div>

        <div className="grid-2">
          <section className="card">
            <div>
              <div className="eyebrow">Liquidity vault</div>
              <div className="figure" style={{ marginTop: 8 }}>
                <Num value={vault?.totalAssets} format={(n) => fmtUsd(n, 0)} />
                <small>LP value</small>
              </div>
            </div>

            <div>
              <div className="stack-bar" title="Where the vault's USDC sits right now">
                <i style={{ width: part(vault?.marginHeld ?? 0), background: "var(--text-3)" }} />
                <i style={{ width: part(vault?.reserved ?? 0), background: "var(--brass)" }} />
                <i style={{ width: part(vault?.free ?? 0), background: "var(--long)" }} />
              </div>
              <div className="key" style={{ marginTop: 10 }}>
                <span style={{ ["--c" as string]: "var(--text-3)" }}>Trader margin {fmtCompactUsd(vault?.marginHeld)}</span>
                <span style={{ ["--c" as string]: "var(--brass)" }}>Locked for payouts {fmtCompactUsd(vault?.reserved)}</span>
                <span style={{ ["--c" as string]: "var(--long)" }}>Free {fmtCompactUsd(vault?.free)}</span>
              </div>
            </div>

            <div className="metrics">
              <div className="metric">
                <label>Share price</label>
                <div className="v">{vault ? `$${vault.sharePrice.toFixed(4)}` : "—"}</div>
              </div>
              <div className="metric">
                <label>Your deposit</label>
                <div className="v">{fmtUsd(vault?.myAssets ?? 0)}</div>
              </div>
              <div className="metric">
                <label>Withdrawable now</label>
                <div className="v">{fmtUsd(vault?.myMaxWithdraw ?? 0)}</div>
              </div>
            </div>

            <AmountForm
              unit="USDC"
              actions={[
                { label: "Deposit", primary: true, max: balances.usdc, run: vaultDeposit },
                { label: "Withdraw", max: vault?.myMaxWithdraw ?? 0, run: vaultWithdraw },
              ]}
            />
            <p>
              Every open position's maximum payout is locked here when it opens, so a winner is paid the moment they
              close. Locked USDC cannot be withdrawn; the share price marks open positions at the oracle price.
            </p>
          </section>

          <section className="card">
            <div>
              <div className="eyebrow">OLQ staking</div>
              <div className="figure" style={{ marginTop: 8 }}>
                <Num value={staking?.myPending} format={(n) => fmtUsd(n)} />
                <small>claimable fees</small>
              </div>
            </div>

            <div>
              <div className="stack-bar" title="OLQ minted so far against the maximum supply">
                <i
                  style={{
                    width: `${staking && staking.maxSupply ? (staking.totalSupply / staking.maxSupply) * 100 : 0}%`,
                    background: "var(--brass)",
                  }}
                />
              </div>
              <div className="key" style={{ marginTop: 10 }}>
                <span style={{ ["--c" as string]: "var(--brass)" }}>
                  Minted {fmtNumber(staking?.totalSupply ?? 0, 0)} of {fmtNumber(staking?.maxSupply ?? 0, 0)} OLQ
                </span>
              </div>
            </div>

            <div className="metrics">
              <div className="metric">
                <label>In wallet</label>
                <div className="v">{fmtNumber(balances.olq, 2)}</div>
              </div>
              <div className="metric">
                <label>Staked</label>
                <div className="v">{fmtNumber(staking?.myStaked ?? 0, 2)}</div>
              </div>
              <div className="metric">
                <label>Mint rate now</label>
                <div className="v">{staking ? `${fmtNumber(staking.mintRate, 1)} / $1 fee` : "—"}</div>
              </div>
            </div>

            <AmountForm
              unit="OLQ"
              actions={[
                { label: "Stake", primary: true, max: balances.olq, run: stake },
                { label: "Unstake", max: staking?.myStaked ?? 0, run: unstake },
              ]}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                className="btn btn-ghost"
                disabled={!account || claiming || !(staking && staking.myPending > 0)}
                onClick={async () => {
                  setClaiming(true);
                  await claimFees();
                  setClaiming(false);
                }}
              >
                {claiming ? <Spinner /> : null}
                Claim fees
              </button>
              {!account && (
                <button className="link" onClick={() => connectDemo()}>
                  Start a demo account
                </button>
              )}
            </div>
            <p>
              OLQ is minted only when a fee is paid, to whoever paid it, on a curve that decays toward a fixed maximum
              supply. Losing a trade mints nothing, so a pair of wallets trading against each other gets no more OLQ
              per dollar of cost than anyone else.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
