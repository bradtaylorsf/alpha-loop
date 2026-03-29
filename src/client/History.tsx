import React, { useEffect, useState } from "react";

interface Run {
  id: number;
  issue_number: number;
  issue_title: string;
  agent: string;
  model: string;
  status: "running" | "success" | "failure";
  pr_url: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export function History() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRuns();
  }, []);

  async function fetchRuns() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/runs?limit=20");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(data.runs);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch runs");
    } finally {
      setLoading(false);
    }
  }

  function formatDuration(seconds: number | null): string {
    if (seconds === null) return "-";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  const badgeColor: Record<string, string> = {
    running: "#ff9800",
    success: "#4caf50",
    failure: "#f44336",
  };

  if (loading) return <div style={styles.loading}>Loading runs...</div>;
  if (error) return <div style={styles.error}>Error: {error}</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Run History</h2>
        <span style={styles.count}>{total} total</span>
        <button onClick={fetchRuns} style={styles.refresh}>Refresh</button>
      </div>
      {runs.length === 0 ? (
        <div style={styles.empty}>No runs yet</div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Issue</th>
                <th style={styles.th}>Agent</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Duration</th>
                <th style={styles.th}>PR</th>
                <th style={styles.th}>Date</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} style={styles.tr}>
                  <td style={styles.td}>
                    <span style={styles.issueNum}>#{run.issue_number}</span>{" "}
                    <span style={styles.issueTitle}>{run.issue_title}</span>
                  </td>
                  <td style={styles.td}>{run.agent}/{run.model}</td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.badge,
                        background: badgeColor[run.status] ?? "#666",
                      }}
                      data-testid="status-badge"
                    >
                      {run.status}
                    </span>
                  </td>
                  <td style={styles.td}>{formatDuration(run.duration_seconds)}</td>
                  <td style={styles.td}>
                    {run.pr_url ? (
                      <a href={run.pr_url} target="_blank" rel="noopener noreferrer" style={styles.link}>
                        PR
                      </a>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={styles.td}>{new Date(run.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  heading: { margin: 0, fontSize: 18, color: "#e0e0e0" },
  count: { color: "#a0a0b0", fontSize: 13 },
  refresh: {
    marginLeft: "auto",
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#7c83ff",
    cursor: "pointer",
    fontSize: 13,
  },
  tableWrap: { overflowX: "auto" },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 14,
  },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    color: "#a0a0b0",
    fontWeight: 600,
    fontSize: 12,
    textTransform: "uppercase",
    borderBottom: "1px solid #2a2a4a",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid #1a1a30" },
  td: { padding: "10px 10px", color: "#c8c8d0", whiteSpace: "nowrap" },
  issueNum: { color: "#7c83ff", fontWeight: 600 },
  issueTitle: { color: "#c8c8d0" },
  badge: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 12,
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    textTransform: "capitalize",
  },
  link: { color: "#7c83ff", textDecoration: "none" },
  loading: { color: "#a0a0b0", padding: 20 },
  error: { color: "#f44336", padding: 20 },
  empty: { color: "#555", fontStyle: "italic", padding: 20 },
};
