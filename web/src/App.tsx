import { useEffect } from "react";
import { startChainPolling } from "./data/chain";
import { startKeeperStream } from "./data/keeper";
import { restoreSession } from "./data/wallet";
import { useStore } from "./state/store";
import { BridgePage } from "./components/BridgePage";
import { DocsPage } from "./components/DocsPage";
import { EarnPage } from "./components/EarnPage";
import { Header } from "./components/Header";
import { HomePage } from "./components/HomePage";
import { MarketHeader } from "./components/MarketHeader";
import { MarketRail } from "./components/MarketRail";
import { MechanicsPage } from "./components/MechanicsPage";
import { OrderTicket } from "./components/OrderTicket";
import { Positions } from "./components/Positions";
import { PredictPage } from "./components/PredictPage";
import { PriceChart } from "./components/PriceChart";

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} style={{ textAlign: "left" }}>
          <i />
          <div>
            <b>{t.title}</b>
            {t.body && <span>{t.body}</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const page = useStore((s) => s.page);

  useEffect(() => {
    startKeeperStream();
    startChainPolling();
    restoreSession();
  }, []);

  return (
    <div className="app">
      <Header />
      {page === "trade" && (
        <main className="trade">
          <MarketRail />
          <section className="center">
            <MarketHeader />
            <PriceChart />
            <Positions />
          </section>
          <OrderTicket />
        </main>
      )}
      {page === "home" && <HomePage />}
      {page === "predict" && <PredictPage />}
      {page === "earn" && <EarnPage />}
      {page === "bridge" && <BridgePage />}
      {page === "mechanics" && <MechanicsPage />}
      {page === "docs" && <DocsPage />}
      <Toasts />
    </div>
  );
}
