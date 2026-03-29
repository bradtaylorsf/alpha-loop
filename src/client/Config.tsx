import React, { useEffect, useState } from "react";

export function Config() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, []);

  async function fetchConfig() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data);
      setDraft(JSON.stringify(data, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch config");
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setConfig(data);
      setDraft(JSON.stringify(data, null, 2));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={styles.loading}>Loading config...</div>;

  return (
    <div>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Configuration</h2>
        {!editing ? (
          <button onClick={() => setEditing(true)} style={styles.editBtn}>
            Edit
          </button>
        ) : (
          <div style={styles.actions}>
            <button
              onClick={() => {
                setEditing(false);
                setDraft(JSON.stringify(config, null, 2));
                setError(null);
              }}
              style={styles.cancelBtn}
            >
              Cancel
            </button>
            <button onClick={saveConfig} disabled={saving} style={styles.saveBtn}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={styles.textarea}
          spellCheck={false}
          data-testid="config-editor"
        />
      ) : (
        <pre style={styles.pre} data-testid="config-view">
          {JSON.stringify(config, null, 2)}
        </pre>
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
  actions: { display: "flex", gap: 8, marginLeft: "auto" },
  editBtn: {
    marginLeft: "auto",
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#7c83ff",
    cursor: "pointer",
    fontSize: 13,
  },
  cancelBtn: {
    padding: "6px 14px",
    border: "1px solid #2a2a4a",
    borderRadius: 6,
    background: "transparent",
    color: "#a0a0b0",
    cursor: "pointer",
    fontSize: 13,
  },
  saveBtn: {
    padding: "6px 14px",
    border: "none",
    borderRadius: 6,
    background: "#7c83ff",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
  textarea: {
    width: "100%",
    minHeight: 400,
    padding: 14,
    background: "#0f0f1a",
    border: "1px solid #2a2a4a",
    borderRadius: 8,
    color: "#c8c8d0",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1.6,
    resize: "vertical",
    boxSizing: "border-box",
  },
  pre: {
    background: "#0f0f1a",
    borderRadius: 8,
    padding: 14,
    color: "#c8c8d0",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1.6,
    overflow: "auto",
    margin: 0,
  },
  loading: { color: "#a0a0b0", padding: 20 },
  error: {
    color: "#f44336",
    background: "#1a0a0a",
    padding: "8px 12px",
    borderRadius: 6,
    marginBottom: 12,
    fontSize: 13,
  },
};
