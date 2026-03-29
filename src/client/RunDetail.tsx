import React, { useEffect, useState } from "react";

interface Learning {
  id: number;
  type: string;
  content: string;
  confidence: number;
}

interface RunData {
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
  test_output: string | null;
  review_output: string | null;
  diff_stat: string | null;
  created_at: string;
  learnings: Learning[];
}

interface RunDetailProps {
  runId: number;
  onBack: () => void;
}

const STAGE_ORDER = ["setup", "implement", "test", "fix", "review", "pr", "cleanup", "done", "failed"];

export function RunDetail({ runId, onBack }: RunDetailProps) {
  const [run, setRun] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"timeline" | "tests" | "review" | "diff">("timeline");

  useEffect(() => {
    fetchRun();
  }, [runId]);

  async function fetchRun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRun(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch run");
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={styles.loading}>Loading run details...</div>;
  if (error) return <div style={styles.error}>Error: {error}</div>;
  if (!run) return <div style={styles.error}>Run not found</div>;

  const stages: string[] = JSON.parse(run.stages_json || "[]");
  const stageDurations: Record<string, number> = JSON.parse(run.stage_durations_json || "{}");
  const issueUrl = run.pr_url ? run.pr_url.replace(/\/pull\/\d+$/, `/issues/${run.issue_number}`) : null;

  const badgeColor: Record<string, string> = {
    running: "#ff9800",
    success: "#4caf50",
    failure: "#f44336",
  };

  return (
    <div>
      <button onClick={onBack} style={styles.backBtn} data-testid="back-button">
        &larr; Back to History
      </button>

      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.issueNum}>#{run.issue_number}</span>
          <h2 style={styles.title}>{run.issue_title}</h2>
        </div>
        <span
          style={{ ...styles.statusBadge, background: badgeColor[run.status] ?? "#666" }}
          data-testid="run-status"
        >
          {run.status}
        </span>
      </div>

      {/* Meta info */}
      <div style={styles.meta}>
        <span>Agent: {run.agent}/{run.model}</span>
        <span>Duration: {formatDuration(run.duration_seconds)}</span>
        <span>Date: {new Date(run.created_at).toLocaleString()}</span>
        {issueUrl && (
          <a href={issueUrl} target="_blank" rel="noopener noreferrer" style={styles.link}>
            GitHub Issue
          </a>
        )}
        {run.pr_url && /^https?:\/\//.test(run.pr_url) && (
          <a href={run.pr_url} target="_blank" rel="noopener noreferrer" style={styles.link}>
            Pull Request
          </a>
        )}
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {(["timeline", "tests", "review", "diff"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{ ...styles.tab, ...(activeTab === t ? styles.activeTab : {}) }}
          >
            {t === "timeline" ? "Timeline" : t === "tests" ? "Test Output" : t === "review" ? "Review" : "Diff Summary"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={styles.tabContent}>
        {activeTab === "timeline" && (
          <div data-testid="timeline-tab">
            <div style={styles.timeline}>
              {stages.map((stage, i) => {
                const duration = stageDurations[stage];
                const isTerminal = stage === "done" || stage === "failed";
                return (
                  <div key={`${stage}-${i}`} style={styles.timelineItem}>
                    <div
                      style={{
                        ...styles.timelineDot,
                        background:
                          stage === "done"
                            ? "#4caf50"
                            : stage === "failed"
                            ? "#f44336"
                            : "#7c83ff",
                      }}
                    />
                    <div style={styles.timelineContent}>
                      <span style={styles.timelineStage}>{stage}</span>
                      {duration !== undefined && (
                        <span style={styles.timelineDuration}>{duration}s</span>
                      )}
                    </div>
                    {i < stages.length - 1 && <div style={styles.timelineLine} />}
                  </div>
                );
              })}
            </div>
            {run.learnings.length > 0 && (
              <div style={styles.learningsSection}>
                <h3 style={styles.sectionTitle}>Learnings ({run.learnings.length})</h3>
                {run.learnings.map((l) => (
                  <div key={l.id} style={styles.learningItem}>
                    <span style={{
                      ...styles.learningType,
                      color: l.type === "pattern" ? "#4caf50" : l.type === "anti_pattern" ? "#f44336" : "#ff9800",
                    }}>
                      {l.type.replace("_", " ")}
                    </span>
                    <span style={styles.learningContent}>{l.content}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "tests" && (
          <div data-testid="tests-tab">
            {run.test_output ? (
              <pre style={styles.codeBlock}>{run.test_output}</pre>
            ) : (
              <div style={styles.emptyTab}>No test output recorded</div>
            )}
          </div>
        )}

        {activeTab === "review" && (
          <div data-testid="review-tab">
            {run.review_output ? (
              <pre style={styles.codeBlock}>{run.review_output}</pre>
            ) : (
              <div style={styles.emptyTab}>No review output recorded</div>
            )}
          </div>
        )}

        {activeTab === "diff" && (
          <div data-testid="diff-tab">
            {run.diff_stat ? (
              <pre style={styles.codeBlock}>{run.diff_stat}</pre>
            ) : (
              <div style={styles.emptyTab}>No diff summary recorded</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "-";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const styles: Record<string, React.CSSProperties> = {
  loading: { color: "#a0a0b0", padding: 20 },
  error: { color: "#f44336", padding: 20 },
  backBtn: {
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#7c83ff",
    cursor: "pointer",
    fontSize: 13,
    marginBottom: 16,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 12,
    flexWrap: "wrap",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  issueNum: {
    color: "#7c83ff",
    fontWeight: 700,
    fontSize: 18,
  },
  title: {
    margin: 0,
    fontSize: 18,
    color: "#e0e0e0",
    fontWeight: 600,
  },
  statusBadge: {
    display: "inline-block",
    padding: "4px 12px",
    borderRadius: 12,
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    textTransform: "capitalize",
  },
  meta: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
    color: "#a0a0b0",
    fontSize: 13,
    marginBottom: 16,
    padding: "10px 14px",
    background: "#16213e",
    borderRadius: 8,
  },
  link: {
    color: "#7c83ff",
    textDecoration: "none",
  },
  tabs: {
    display: "flex",
    gap: 4,
    marginBottom: 12,
  },
  tab: {
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: "#a0a0b0",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  },
  activeTab: {
    background: "#2a2a4a",
    color: "#7c83ff",
  },
  tabContent: {
    background: "#0f0f1a",
    borderRadius: 8,
    padding: 16,
    minHeight: 200,
  },
  timeline: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  timelineItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    position: "relative",
    paddingLeft: 8,
    paddingBottom: 16,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    flexShrink: 0,
  },
  timelineContent: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  timelineStage: {
    color: "#e0e0e0",
    fontWeight: 600,
    fontSize: 14,
    textTransform: "capitalize",
  },
  timelineDuration: {
    color: "#a0a0b0",
    fontSize: 12,
  },
  timelineLine: {
    position: "absolute",
    left: 13,
    top: 20,
    bottom: 0,
    width: 2,
    background: "#2a2a4a",
  },
  codeBlock: {
    background: "#0a0a15",
    padding: 12,
    borderRadius: 6,
    color: "#c8c8d0",
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    lineHeight: 1.6,
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    maxHeight: 400,
    overflowY: "auto",
    margin: 0,
  },
  emptyTab: {
    color: "#555",
    fontStyle: "italic",
    padding: 20,
    textAlign: "center",
  },
  learningsSection: {
    marginTop: 20,
    borderTop: "1px solid #2a2a4a",
    paddingTop: 16,
  },
  sectionTitle: {
    margin: "0 0 10px 0",
    fontSize: 14,
    color: "#e0e0e0",
    fontWeight: 600,
  },
  learningItem: {
    display: "flex",
    gap: 10,
    padding: "6px 0",
    borderBottom: "1px solid #1a1a30",
    fontSize: 13,
  },
  learningType: {
    fontWeight: 600,
    fontSize: 11,
    textTransform: "uppercase",
    minWidth: 100,
  },
  learningContent: {
    color: "#c8c8d0",
  },
};
