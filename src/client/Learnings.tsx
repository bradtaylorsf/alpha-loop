import React, { useEffect, useState } from "react";

interface Learning {
  id: number;
  run_id: number;
  issue_number: number;
  type: "pattern" | "anti_pattern" | "prompt_improvement";
  content: string;
  confidence: number;
  created_at: string;
}

interface Metrics {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  completionRate: number;
  avgRetryCount: number;
  avgDurationSeconds: number;
  failureReasons: Array<{ reason: string; count: number }>;
}

interface Suggestion {
  id: number;
  content: string;
  confidence: number;
  run_id: number;
  issue_number: number;
  created_at: string;
}

type FilterType = "all" | "pattern" | "anti_pattern" | "prompt_improvement";

export function Learnings() {
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [total, setTotal] = useState(0);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [filter, setFilter] = useState<FilterType>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAll();
  }, [filter]);

  async function fetchAll() {
    setLoading(true);
    setError(null);
    try {
      const typeParam = filter !== "all" ? `&type=${filter}` : "";
      const [learningsRes, metricsRes, suggestionsRes] = await Promise.all([
        fetch(`/api/learnings?limit=50${typeParam}`),
        fetch("/api/learnings/metrics"),
        fetch("/api/learnings/suggestions"),
      ]);

      if (!learningsRes.ok) throw new Error(`Learnings: HTTP ${learningsRes.status}`);
      if (!metricsRes.ok) throw new Error(`Metrics: HTTP ${metricsRes.status}`);
      if (!suggestionsRes.ok) throw new Error(`Suggestions: HTTP ${suggestionsRes.status}`);

      const learningsData = await learningsRes.json();
      const metricsData = await metricsRes.json();
      const suggestionsData = await suggestionsRes.json();

      setLearnings(learningsData.learnings);
      setTotal(learningsData.total);
      setMetrics(metricsData);
      setSuggestions(suggestionsData.suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  }

  const typeLabel: Record<string, string> = {
    pattern: "Pattern",
    anti_pattern: "Anti-Pattern",
    prompt_improvement: "Improvement",
  };

  const typeBadgeColor: Record<string, string> = {
    pattern: "#4caf50",
    anti_pattern: "#f44336",
    prompt_improvement: "#ff9800",
  };

  if (loading) return <div style={styles.loading}>Loading learnings...</div>;
  if (error) return <div style={styles.error}>Error: {error}</div>;

  return (
    <div>
      {/* Metrics Section */}
      {metrics && metrics.totalRuns > 0 && (
        <div style={styles.metricsGrid} data-testid="metrics-section">
          <div style={styles.metricCard}>
            <div style={styles.metricValue}>{metrics.totalRuns}</div>
            <div style={styles.metricLabel}>Total Runs</div>
          </div>
          <div style={styles.metricCard}>
            <div style={{ ...styles.metricValue, color: "#4caf50" }}>
              {(metrics.completionRate * 100).toFixed(1)}%
            </div>
            <div style={styles.metricLabel}>Success Rate</div>
          </div>
          <div style={styles.metricCard}>
            <div style={styles.metricValue}>{metrics.avgRetryCount.toFixed(1)}</div>
            <div style={styles.metricLabel}>Avg Retries</div>
          </div>
          <div style={styles.metricCard}>
            <div style={styles.metricValue}>{metrics.avgDurationSeconds.toFixed(0)}s</div>
            <div style={styles.metricLabel}>Avg Duration</div>
          </div>
          {metrics.failureReasons.length > 0 && (
            <div style={{ ...styles.metricCard, gridColumn: "1 / -1" }}>
              <div style={styles.metricLabel}>Common Failure Reasons</div>
              {metrics.failureReasons.slice(0, 3).map((r, i) => (
                <div key={i} style={styles.failureReason}>
                  {r.reason} <span style={styles.failureCount}>({r.count}x)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Improvement Suggestions */}
      {suggestions.length > 0 && (
        <div style={styles.section} data-testid="suggestions-section">
          <h3 style={styles.sectionTitle}>Improvement Suggestions</h3>
          {suggestions.map((s) => (
            <div key={s.id} style={styles.suggestionCard}>
              <div style={styles.suggestionContent}>{s.content}</div>
              <div style={styles.suggestionMeta}>
                Confidence: {(s.confidence * 100).toFixed(0)}% | Run #{s.run_id} | Issue #{s.issue_number}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Learnings List */}
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Learnings</h2>
        <span style={styles.count}>{total} total</span>
        <div style={styles.filters}>
          {(["all", "pattern", "anti_pattern", "prompt_improvement"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setFilter(t)}
              style={{
                ...styles.filterBtn,
                ...(filter === t ? styles.filterBtnActive : {}),
              }}
              data-testid={`filter-${t}`}
            >
              {t === "all" ? "All" : typeLabel[t]}
            </button>
          ))}
        </div>
        <button onClick={fetchAll} style={styles.refresh}>Refresh</button>
      </div>

      {learnings.length === 0 ? (
        <div style={styles.empty}>No learnings yet</div>
      ) : (
        <div style={styles.learningsList}>
          {learnings.map((l) => (
            <div key={l.id} style={styles.learningCard} data-testid="learning-card">
              <div style={styles.learningHeader}>
                <span
                  style={{
                    ...styles.badge,
                    background: typeBadgeColor[l.type] ?? "#666",
                  }}
                  data-testid="type-badge"
                >
                  {typeLabel[l.type]}
                </span>
                <span style={styles.confidence}>
                  {(l.confidence * 100).toFixed(0)}% confidence
                </span>
              </div>
              <div style={styles.learningContent}>{l.content}</div>
              <div style={styles.learningMeta}>
                Run #{l.run_id} | Issue #{l.issue_number} | {new Date(l.created_at).toLocaleString()}
              </div>
            </div>
          ))}
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
  filters: { display: "flex", gap: 4, marginLeft: "auto" },
  filterBtn: {
    padding: "4px 10px",
    border: "1px solid #2a2a4a",
    borderRadius: 4,
    background: "transparent",
    color: "#a0a0b0",
    cursor: "pointer",
    fontSize: 12,
  },
  filterBtnActive: {
    background: "#2a2a4a",
    color: "#7c83ff",
    borderColor: "#7c83ff",
  },
  refresh: {
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#7c83ff",
    cursor: "pointer",
    fontSize: 13,
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 12,
    marginBottom: 20,
  },
  metricCard: {
    background: "#16213e",
    borderRadius: 8,
    padding: 16,
    textAlign: "center" as const,
  },
  metricValue: {
    fontSize: 24,
    fontWeight: 700,
    color: "#7c83ff",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
  },
  metricLabel: {
    fontSize: 12,
    color: "#a0a0b0",
    marginTop: 4,
    textTransform: "uppercase" as const,
  },
  failureReason: {
    fontSize: 13,
    color: "#c8c8d0",
    marginTop: 6,
  },
  failureCount: { color: "#f44336", fontSize: 12 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 16,
    color: "#e0e0e0",
    marginBottom: 8,
    marginTop: 0,
  },
  suggestionCard: {
    background: "#16213e",
    border: "1px solid #ff980033",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  suggestionContent: { color: "#e0e0e0", fontSize: 14 },
  suggestionMeta: { color: "#a0a0b0", fontSize: 12, marginTop: 6 },
  learningsList: { display: "flex", flexDirection: "column" as const, gap: 8 },
  learningCard: {
    background: "#16213e",
    borderRadius: 8,
    padding: 12,
  },
  learningHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
  },
  confidence: { color: "#a0a0b0", fontSize: 12, marginLeft: "auto" },
  learningContent: { color: "#c8c8d0", fontSize: 14 },
  learningMeta: { color: "#666", fontSize: 12, marginTop: 6 },
  loading: { color: "#a0a0b0", padding: 20 },
  error: { color: "#f44336", padding: 20 },
  empty: { color: "#555", fontStyle: "italic", padding: 20 },
};
