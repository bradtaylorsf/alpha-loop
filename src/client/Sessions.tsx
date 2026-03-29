import React, { useEffect, useState, useCallback, useRef } from "react";

interface SessionIssue {
  id: number;
  session_id: number;
  issue_number: number;
  position: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  pr_url: string | null;
}

interface Session {
  id: number;
  name: string;
  status: "pending" | "active" | "completed" | "cancelled";
  created_at: string;
  completed_at: string | null;
  issues: SessionIssue[];
}

type View = "list" | "create" | "detail";

export function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  if (view === "create") {
    return <CreateSession onBack={() => { setView("list"); fetchSessions(); }} />;
  }

  if (view === "detail" && selectedSession) {
    return (
      <SessionDetail
        sessionId={selectedSession.id}
        onBack={() => { setView("list"); setSelectedSession(null); fetchSessions(); }}
      />
    );
  }

  if (loading) return <div style={styles.loading}>Loading sessions...</div>;
  if (error) return <div style={styles.error}>Error: {error}</div>;

  const statusColor: Record<string, string> = {
    pending: "#ff9800",
    active: "#2196f3",
    completed: "#4caf50",
    cancelled: "#9e9e9e",
  };

  return (
    <div>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Sessions</h2>
        <span style={styles.count}>{sessions.length} total</span>
        <button onClick={() => setView("create")} style={styles.primaryBtn}>
          + Create Session
        </button>
        <button onClick={fetchSessions} style={styles.refresh}>Refresh</button>
      </div>

      {sessions.length === 0 ? (
        <div style={styles.empty}>No sessions yet. Create one to batch and prioritize issues.</div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Issues</th>
                <th style={styles.th}>Progress</th>
                <th style={styles.th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const done = s.issues.filter((i) => i.status === "completed").length;
                const total = s.issues.length;
                return (
                  <tr
                    key={s.id}
                    style={{ ...styles.tr, cursor: "pointer" }}
                    onClick={() => { setSelectedSession(s); setView("detail"); }}
                  >
                    <td style={styles.td}>{s.name}</td>
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, background: statusColor[s.status] ?? "#666" }}>
                        {s.status}
                      </span>
                    </td>
                    <td style={styles.td}>{total}</td>
                    <td style={styles.td}>
                      <div style={styles.progressBar}>
                        <div style={{ ...styles.progressFill, width: total > 0 ? `${(done / total) * 100}%` : "0%" }} />
                      </div>
                      <span style={styles.progressText}>{done}/{total}</span>
                    </td>
                    <td style={styles.td}>{new Date(s.created_at).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateSession({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState("");
  const [issueInput, setIssueInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setError(null);
    const numbers = issueInput
      .split(/[,\s]+/)
      .map((s) => parseInt(s.replace("#", ""), 10))
      .filter((n) => !isNaN(n) && n > 0);

    if (!name.trim()) {
      setError("Session name is required");
      return;
    }
    if (numbers.length === 0) {
      setError("Add at least one issue number");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          issues: numbers.map((n, i) => ({ issue_number: n, position: i })),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button onClick={onBack} style={styles.backBtn}>Back to Sessions</button>
      <h2 style={styles.heading}>Create Session</h2>

      <div style={styles.formGroup}>
        <label style={styles.label}>Session Name</label>
        <input
          type="text"
          placeholder="e.g. Sprint 12 - Auth fixes"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={styles.input}
        />
      </div>

      <div style={styles.formGroup}>
        <label style={styles.label}>Issue Numbers (comma or space separated)</label>
        <input
          type="text"
          placeholder="e.g. 33, 34, 35 or #33 #34 #35"
          value={issueInput}
          onChange={(e) => setIssueInput(e.target.value)}
          style={styles.input}
        />
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <button onClick={handleCreate} disabled={saving} style={styles.primaryBtn}>
        {saving ? "Creating..." : "Create Session"}
      </button>
    </div>
  );
}

function SessionDetail({ sessionId, onBack }: { sessionId: number; onBack: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prioritizing, setPrioritizing] = useState(false);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const fetchSession = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSession(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch session");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  async function handleStatusChange(status: string) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSession(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update session");
    }
  }

  async function handleDelete() {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session");
    }
  }

  async function handlePrioritize() {
    setPrioritizing(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/prioritize`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSession(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI prioritization failed");
    } finally {
      setPrioritizing(false);
    }
  }

  async function handleDragEnd() {
    if (dragItem.current === null || dragOverItem.current === null || !session) return;
    if (dragItem.current === dragOverItem.current) return;

    const items = [...session.issues];
    const draggedItem = items[dragItem.current];
    items.splice(dragItem.current, 1);
    items.splice(dragOverItem.current, 0, draggedItem);

    const reordered = items.map((item, idx) => ({
      issue_number: item.issue_number,
      position: idx,
    }));

    dragItem.current = null;
    dragOverItem.current = null;

    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issues: reordered }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSession(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder");
    }
  }

  if (loading) return <div style={styles.loading}>Loading session...</div>;
  if (error && !session) return <div style={styles.error}>Error: {error}</div>;
  if (!session) return <div style={styles.error}>Session not found</div>;

  const issueStatusColor: Record<string, string> = {
    pending: "#ff9800",
    in_progress: "#2196f3",
    completed: "#4caf50",
    failed: "#f44336",
  };

  const statusColor: Record<string, string> = {
    pending: "#ff9800",
    active: "#2196f3",
    completed: "#4caf50",
    cancelled: "#9e9e9e",
  };

  return (
    <div>
      <button onClick={onBack} style={styles.backBtn}>Back to Sessions</button>

      <div style={styles.headerRow}>
        <h2 style={styles.heading}>{session.name}</h2>
        <span style={{ ...styles.badge, background: statusColor[session.status] ?? "#666" }}>
          {session.status}
        </span>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.controls}>
        {session.status === "pending" && (
          <>
            <button onClick={() => handleStatusChange("active")} style={styles.primaryBtn}>Start</button>
            <button onClick={handlePrioritize} disabled={prioritizing} style={styles.secondaryBtn}>
              {prioritizing ? "Prioritizing..." : "AI Prioritize"}
            </button>
            <button onClick={handleDelete} style={styles.dangerBtn}>Delete</button>
          </>
        )}
        {session.status === "active" && (
          <>
            <button onClick={() => handleStatusChange("pending")} style={styles.secondaryBtn}>Pause</button>
            <button onClick={() => handleStatusChange("cancelled")} style={styles.dangerBtn}>Cancel</button>
          </>
        )}
      </div>

      <h3 style={styles.subheading}>Issues ({session.issues.length})</h3>
      <div style={styles.issueList}>
        {session.issues.map((issue, idx) => (
          <div
            key={issue.id}
            draggable={session.status === "pending"}
            onDragStart={() => { dragItem.current = idx; }}
            onDragEnter={() => { dragOverItem.current = idx; }}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => e.preventDefault()}
            style={{
              ...styles.issueCard,
              cursor: session.status === "pending" ? "grab" : "default",
            }}
          >
            <span style={styles.issuePosition}>{idx + 1}</span>
            <span style={styles.issueNum}>#{issue.issue_number}</span>
            <span style={{ ...styles.issueBadge, background: issueStatusColor[issue.status] ?? "#666" }}>
              {issue.status.replace("_", " ")}
            </span>
            {issue.pr_url && /^https?:\/\//.test(issue.pr_url) && (
              <a href={issue.pr_url} target="_blank" rel="noopener noreferrer" style={styles.link}>
                PR
              </a>
            )}
          </div>
        ))}
      </div>
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
  subheading: { margin: "16px 0 8px", fontSize: 15, color: "#a0a0b0" },
  count: { color: "#a0a0b0", fontSize: 13 },
  refresh: {
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#7c83ff",
    cursor: "pointer",
    fontSize: 13,
  },
  primaryBtn: {
    padding: "8px 18px",
    border: "none",
    borderRadius: 6,
    background: "#7c83ff",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  secondaryBtn: {
    padding: "8px 18px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#7c83ff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  dangerBtn: {
    padding: "8px 18px",
    border: "1px solid #f4433650",
    borderRadius: 6,
    background: "transparent",
    color: "#f44336",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  backBtn: {
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#a0a0b0",
    cursor: "pointer",
    fontSize: 13,
    marginBottom: 16,
  },
  controls: {
    display: "flex",
    gap: 8,
    marginBottom: 16,
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
  badge: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 12,
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    textTransform: "capitalize",
  },
  issueBadge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    color: "#fff",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "capitalize",
  },
  progressBar: {
    display: "inline-block",
    width: 80,
    height: 6,
    background: "#2a2a4a",
    borderRadius: 3,
    overflow: "hidden",
    verticalAlign: "middle",
    marginRight: 6,
  },
  progressFill: {
    height: "100%",
    background: "#4caf50",
    borderRadius: 3,
    transition: "width 0.3s",
  },
  progressText: { color: "#a0a0b0", fontSize: 12 },
  issueList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  issueCard: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    background: "#0f0f1a",
    borderRadius: 6,
    border: "1px solid #2a2a4a",
  },
  issuePosition: {
    color: "#555",
    fontSize: 12,
    fontWeight: 700,
    minWidth: 20,
  },
  issueNum: { color: "#7c83ff", fontWeight: 600, fontSize: 14 },
  link: { color: "#7c83ff", textDecoration: "none", marginLeft: "auto", fontSize: 13 },
  formGroup: { marginBottom: 16 },
  label: { display: "block", color: "#a0a0b0", fontSize: 13, marginBottom: 6 },
  input: {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "#0f0f1a",
    color: "#e0e0e0",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  loading: { color: "#a0a0b0", padding: 20 },
  error: { color: "#f44336", padding: "8px 0", fontSize: 13 },
  empty: { color: "#555", fontStyle: "italic", padding: 20 },
};
