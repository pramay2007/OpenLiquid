import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { IS_LOCAL } from "../chain/config";
import { ARC, REMOTE_CHAINS, bridge, quote, type BridgeProgress, type Quote } from "../data/bridge";
import { refreshAll } from "../data/chain";
import { connectDemo, explain } from "../data/wallet";
import { fmtNumber } from "../lib/format";
import { useStore } from "../state/store";
import { Num, Spinner } from "./primitives";

/** Left on Arc after a transfer out, so the account can still pay for its next transactions. */
const GAS_FLOOR = 0.05;

const STEPS: { stage: BridgeProgress["stage"]; label: string }[] = [
  { stage: "approve", label: "Approve USDC" },
  { stage: "burn", label: "Burn on the source chain" },
  { stage: "attest", label: "Circle attests and forwards" },
  { stage: "done", label: "Minted on the destination" },
];

export function BridgePage() {
  const account = useStore((s) => s.account);
  const onArc = useStore((s) => s.balances.gas);
  const toast = useStore((s) => s.toast);
  const [toArc, setToArc] = useState(true);
  const [remoteKey, setRemoteKey] = useState(REMOTE_CHAINS[0].key);
  const [text, setText] = useState("");
  const [recipientText, setRecipientText] = useState("");
  const [fees, setFees] = useState<Quote | null>(null);
  const [progress, setProgress] = useState<BridgeProgress | null>(null);
  const [busy, setBusy] = useState(false);

  const remote = REMOTE_CHAINS.find((c) => c.key === remoteKey)!;
  const from = toArc ? remote : ARC;
  const to = toArc ? ARC : remote;
  const amount = Number(text) || 0;
  const recipient = (recipientText || account?.address || "") as `0x${string}`;
  const maxOut = Math.max(0, onArc - GAS_FLOOR);

  // Live fees from Circle for the chosen route and amount.
  useEffect(() => {
    let stale = false;
    setFees(null);
    if (IS_LOCAL) return;
    const timer = setTimeout(() => {
      quote(from, to, amount || 1)
        .then((q) => !stale && setFees(q))
        .catch(() => undefined);
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [from, to, amount]);

  const totalFee = fees ? fees.protocolFee + fees.forwardFee : 0;
  const receive = Math.max(0, amount - totalFee);
  const problem = !account
    ? null
    : !isAddress(recipient)
      ? "Enter a valid recipient address"
      : !toArc && amount > maxOut
        ? `At most ${fmtNumber(maxOut, 2)} USDC, keeping ${GAS_FLOOR} for gas`
        : amount > 0 && fees && amount <= totalFee
          ? "The amount is smaller than the fee"
          : null;

  async function run() {
    setBusy(true);
    setProgress(null);
    try {
      const done = await bridge(from, to, amount, recipient, setProgress);
      toast(
        done.mintTx
          ? { kind: "success", title: `USDC arrived on ${to.name}`, body: `${fmtNumber(receive, 2)} USDC` }
          : { kind: "info", title: "Transfer in flight", body: "Circle is still working on it. It will arrive without further action." }
      );
      setText("");
    } catch (err) {
      setProgress(null);
      toast({ kind: "error", title: "Transfer not sent", body: explain(err) });
    } finally {
      setBusy(false);
      void refreshAll();
    }
  }

  const reached = (stage: BridgeProgress["stage"]) =>
    progress ? STEPS.findIndex((s) => s.stage === stage) <= STEPS.findIndex((s) => s.stage === progress.stage) : false;

  return (
    <main className="page">
      <div className="page-inner">
        <div>
          <h2>
            USDC in and out, <em>one signature.</em>
          </h2>
          <p className="lede">
            On Arc, USDC is the gas token as well as the dollar. Transfers here use Circle's CCTP: USDC is burned on
            one chain and minted on the other, and Circle's forwarding service submits the mint. You sign once, on the
            chain the USDC is leaving, and need nothing on the chain it is going to.
          </p>
        </div>

        <div className="grid-2">
          <section className="card">
            <div className="bridge-head">
              <div className="eyebrow">Transfer</div>
              <div className="seg" role="group" aria-label="Direction">
                <button aria-pressed={toArc} onClick={() => setToArc(true)}>
                  To Arc
                </button>
                <button aria-pressed={!toArc} onClick={() => setToArc(false)}>
                  From Arc
                </button>
              </div>
            </div>

            <div className="route">
              <div className="route-end">
                <span>From</span>
                {toArc ? <ChainSelect value={remoteKey} onChange={setRemoteKey} /> : <b>{ARC.name}</b>}
              </div>
              <span className="route-arrow" aria-hidden>
                →
              </span>
              <div className="route-end">
                <span>To</span>
                {toArc ? <b>{ARC.name}</b> : <ChainSelect value={remoteKey} onChange={setRemoteKey} />}
              </div>
            </div>

            <div className="field">
              <div className="field-head">
                <span>Amount</span>
                {!toArc && account && (
                  <button className="link" onClick={() => setText(maxOut.toFixed(2))}>
                    Max {fmtNumber(maxOut, 2)}
                  </button>
                )}
              </div>
              <label className="amount">
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={text}
                  onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))}
                  aria-label="Amount in USDC"
                />
                <em>USDC</em>
              </label>
            </div>

            <div className="field">
              <div className="field-head">
                <span>Recipient on {to.name}</span>
                {recipientText && (
                  <button className="link" onClick={() => setRecipientText("")}>
                    Use my address
                  </button>
                )}
              </div>
              <label className="amount address">
                <input
                  spellCheck={false}
                  placeholder={account?.address ?? "0x…"}
                  value={recipientText}
                  onChange={(e) => setRecipientText(e.target.value.trim())}
                  aria-label="Recipient address"
                />
              </label>
            </div>

            <div className="bridge-quote">
              <div className="kv">
                <span>Circle transfer fee</span>
                <b>{fees ? `${fmtNumber(fees.protocolFee, 4)} USDC` : "—"}</b>
              </div>
              <div className="kv">
                <span>Forwarding fee</span>
                <b>{fees ? `${fmtNumber(fees.forwardFee, 4)} USDC` : "—"}</b>
              </div>
              <div className="kv">
                <span>Arrives in</span>
                <b>{from.eta}</b>
              </div>
              <div className="kv total">
                <span>You receive</span>
                <b>{amount > 0 && fees ? `${fmtNumber(receive, 4)} USDC` : "—"}</b>
              </div>
            </div>

            {IS_LOCAL ? (
              <p className="note">Transfers run against Arc testnet. This build is connected to a local chain.</p>
            ) : account ? (
              <button className="btn btn-primary btn-lg" disabled={busy || amount <= 0 || !!problem || !fees} onClick={run}>
                {busy ? <Spinner /> : null}
                {problem ?? (toArc ? `Bring USDC from ${remote.name}` : `Send USDC to ${remote.name}`)}
              </button>
            ) : (
              <button className="btn btn-primary btn-lg" onClick={() => connectDemo()}>
                Start a demo account
              </button>
            )}
            {toArc && !IS_LOCAL && (
              <p className="note">
                Signed by your browser wallet on {remote.name}, which needs USDC and a little gas there. The USDC lands
                in the account shown above, on Arc.
              </p>
            )}
          </section>

          <section className="card">
            <div className="eyebrow">Your USDC on Arc</div>
            <div className="figure bridge-figure">
              <Num value={account ? onArc : null} format={(n) => fmtNumber(n, 4)} />
              <small>USDC · pays for gas</small>
            </div>

            <ol className="steps">
              {STEPS.map((s) => {
                const active = progress?.stage === s.stage && s.stage !== "done";
                return (
                  <li key={s.stage} className={reached(s.stage) ? (active ? "active" : "reached") : ""}>
                    <i>{active ? <Spinner /> : null}</i>
                    <span>{s.label}</span>
                    {s.stage === "burn" && progress?.burnTx && (
                      <a className="link" href={from.txUrl(progress.burnTx)} target="_blank" rel="noreferrer">
                        View
                      </a>
                    )}
                    {s.stage === "done" && progress?.mintTx && (
                      <a className="link" href={to.txUrl(progress.mintTx)} target="_blank" rel="noreferrer">
                        View
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>

            <p className="note">
              Collateral on this testnet deployment is a faucet token, so that anyone can trade at size. USDC brought
              to Arc here pays an account's gas. On a mainnet deployment the collateral is USDC itself, and this
              transfer is the deposit.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

function ChainSelect({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <select className="chain-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Chain">
      {REMOTE_CHAINS.map((c) => (
        <option key={c.key} value={c.key}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
