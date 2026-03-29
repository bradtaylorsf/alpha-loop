import React, { useState } from "react";
import { LiveView } from "./LiveView.js";
import { History } from "./History.js";
import { Config } from "./Config.js";
import { Learnings } from "./Learnings.js";

type Tab = "live" | "history" | "learnings" | "config";

export function App() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Alpha Loop</h1>
        <nav style={styles.nav}>
          {(["live", "history", "learnings", "config"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                ...styles.tab,
                ...(tab === t ? styles.activeTab : {}),
              }}
            >
              {t === "live" ? "Live View" : t === "history" ? "Run History" : t === "learnings" ? "Learnings" : "Config"}
            </button>
          ))}
        </nav>
      </header>
      <main style={styles.main}>
        {tab === "live" && <LiveView />}
        {tab === "history" && <History />}
        {tab === "learnings" && <Learnings />}
        {tab === "config" && <Config />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 960,
    margin: "0 auto",
    padding: "0 16px",
    color: "#e0e0e0",
    background: "#1a1a2e",
    minHeight: "100vh",
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 0",
    borderBottom: "1px solid #2a2a4a",
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 20,
    fontWeight: 700,
    color: "#7c83ff",
  },
  nav: {
    display: "flex",
    gap: 4,
  },
  tab: {
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: "#a0a0b0",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
  },
  activeTab: {
    background: "#2a2a4a",
    color: "#7c83ff",
  },
  main: {
    padding: "16px 0",
  },
};
