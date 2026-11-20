import { useState } from "react";
import { NETWORK_LABEL, deployment } from "../chain/config";
import { connectDemo, connectInjected, disconnect, faucet } from "../data/wallet";
import { fmtUsd, shortAddress } from "../lib/format";
import { useStore, type Page } from "../state/store";
import { Mark, Num, Spinner } from "./primitives";

const PAGES: { id: Page; label: string }[] = [
  { id: "trade", label: "Trade" },
  { id: "predict", label: "Predict" },
  { id: "earn", label: "Earn" },
  { id: "bridge", label: "Bridge" },
  { id: "docs", label: "Docs" },
];

export function Header() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const account = useStore((s) => s.account);
  const connecting = useStore((s) => s.connecting);
  const usdc = useStore((s) => s.balances.usdc);
  const online = useStore((s) => s.keeperOnline && s.chainOnline);
  const [minting, setMinting] = useState(false);

  return (
    <header className="header">
      <button className="brand" onClick={() => setPage("home")} aria-label="OpenLiquid home">
        <Mark />
        OpenLiquid
      </button>
      <nav className="nav" aria-label="Sections">
        {PAGES.map((p) => (
          <button key={p.id} aria-current={page === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>

      <div className="header-right">
        <span className="pill hide-sm" title={online ? "Prices are live" : "Waiting for the price keeper"}>
          <span className={`dot ${online ? "live" : ""}`} />
          {NETWORK_LABEL}
        </span>

        {account ? (
          <>
            <span className="pill">
              <Num value={usdc} format={(n) => fmtUsd(n)} />
              {deployment.faucet && (
                <button
                  className="link"
                  disabled={minting}
                  title="Add 10,000 test USDC"
                  onClick={async () => {
                    setMinting(true);
                    await faucet();
                    setMinting(false);
                  }}
                >
                  {minting ? <Spinner /> : "+ Faucet"}
                </button>
              )}
            </span>
            <button className="btn btn-ghost" onClick={disconnect} title="Disconnect">
              {account.kind === "demo" ? "Demo · " : ""}
              <span className="mono">{shortAddress(account.address)}</span>
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost hide-sm" disabled={connecting} onClick={connectInjected}>
              Connect wallet
            </button>
            <button className="btn btn-primary" disabled={connecting} onClick={() => connectDemo()}>
              {connecting ? <Spinner /> : null}
              Demo account
            </button>
          </>
        )}
      </div>
    </header>
  );
}
