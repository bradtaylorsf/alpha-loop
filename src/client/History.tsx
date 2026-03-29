import React, { useEffect, useState, useCallback } from "react";
import { RunDetail } from "./RunDetail.js";

interface Run {
  id: number;
  issue_number: number;
  issue_title: string;
  agent: string;
  model: string;
  status: "running" | "success" | "failure";
  stages_json: string;
  stage_durations_json: string;
  pr_url: string | null;
  duration_seconds: number | null;
  diff_stat: string | null;
  created_at: string;
}

export function History() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (statusFilter) params.set("status", statusFilter);
      if (searchQuery) params.set("search", searchQuery);
      const res = await fetch(`/api/runs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(data.runs);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch runs");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchQuery]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Auto-refresh: listen for SSE complete events to refresh the list
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        if (event.type === "complete" || event.type === "error") {
          fetchRuns();
        }
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [fetchRuns]);

  function formatDuration(seconds: number | null): string {
    if (seconds === null) return "-";
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function parseDiffSummary(diffStat: string | null): string {
    if (!diffStat) return "";
    const lines = diffStat.trim().split("\n");
    const summary = lines[lines.length - 1] || "";
    return summary.trim();
  }

  const badgeColor: Record<string, string> = {
    running: "#ff9800",
    success: "#4caf50",
    failure: "#f44336",
  };

  // Run detail view
  if (selectedRunId !== null) {
    return <RunDetail runId={selectedRunId} onBack={() => setSelectedRunId(null)} />;
  }

  if (loading) return <div style={styles.loading}>Loading runs...</div>;
  if (error) return <div style={styles.error}>Error: {error}</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Run History</h2>
        <span style={styles.count}>{total} total</span>
        <button onClick={fetchRuns} style={styles.refresh}>Refresh</button>
      </div>

      {/* Filters */}
      <div style={styles.filterRow} data-testid="filter-row">
        <input
          type="text"
          placeholder="Search by issue title or number..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={styles.searchInput}
          data-testid="search-input"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={styles.filterSelect}
          data-testid="status-filter"
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
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
                <th style={styles.th}>Changes</th>
                <th style={styles.th}>PR</th>
                <th style={styles.th}>Date</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <React.Fragment key={run.id}>
                  <tr
                    style={{ ...styles.tr, cursor: "pointer" }}
                    onClick={() => setSelectedRunId(run.id)}
                    data-testid={`run-row-${run.id}`}
                  >
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
                      <span style={styles.diffSummary}>{parseDiffSummary(run.diff_stat)}</span>
                    </td>
                    <td style={styles.td}>
                      {run.pr_url && /^https?:\/\//.test(run.pr_url) ? (
                        <a
                          href={run.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={styles.link}
                          onClick={(e) => e.stopPropagation()}
                        >
                          PR
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td style={styles.td}>{new Date(run.created_at).toLocaleString()}</td>
                  </tr>
                </React.Fragment>
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
  filterRow: {
    display: "flex",
    gap: 10,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  searchInput: {
    flex: 1,
    minWidth: 200,
    padding: "8px 12px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "#0f0f1a",
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
  },
  filterSelect: {
    padding: "8px 12px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "#0f0f1a",
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
    cursor: "pointer",
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
  diffSummary: {
    color: "#a0a0b0",
    fontSize: 12,
    maxWidth: 150,
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "inline-block",
  },
  link: { color: "#7c83ff", textDecoration: "none" },
  loading: { color: "#a0a0b0", padding: 20 },
  error: { color: "#f44336", padding: 20 },
  empty: { color: "#555", fontStyle: "italic", padding: 20 },
};
