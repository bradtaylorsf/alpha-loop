import React, { useEffect, useRef, useState } from "react";

interface StageEvent {
  type: "stage";
  data: { issue: number; stage: string; timestamp: string };
}
interface OutputEvent {
  type: "output";
  data: { line: string; timestamp: string };
}
interface TestEvent {
  type: "test";
  data: { passed: number; failed: number; timestamp: string };
}
interface ErrorEvent {
  type: "error";
  data: { message: string; stage: string; timestamp: string };
}
interface CompleteEvent {
  type: "complete";
  data: { issue: number; prUrl: string; duration: number };
}

type LoopEvent = StageEvent | OutputEvent | TestEvent | ErrorEvent | CompleteEvent;

interface StatusState {
  stage: string;
  issue: number | null;
  startTime: string | null;
  connected: boolean;
}

export function LiveView() {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusState>({
    stage: "idle",
    issue: null,
    startTime: null,
    connected: false,
  });
  const [elapsed, setElapsed] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");

    es.onopen = () => {
      setStatus((s) => ({ ...s, connected: true }));
    };

    es.onmessage = (msg) => {
      try {
        const event: LoopEvent = JSON.parse(msg.data);
        handleEvent(event);
      } catch {
        // ignore malformed messages
      }
    };

    es.onerror = () => {
      setStatus((s) => ({ ...s, connected: false }));
    };

    return () => es.close();
  }, []);

  function handleEvent(event: LoopEvent) {
    switch (event.type) {
      case "stage":
        setStatus({
          stage: event.data.stage,
          issue: event.data.issue,
          startTime: event.data.timestamp,
          connected: true,
        });
        addLine(`[stage] #${event.data.issue} → ${event.data.stage}`);
        break;
      case "output":
        addLine(event.data.line);
        break;
      case "test":
        addLine(`[test] passed: ${event.data.passed}, failed: ${event.data.failed}`);
        break;
      case "error":
        addLine(`[error] ${event.data.stage}: ${event.data.message}`);
        break;
      case "complete":
        setStatus((s) => ({ ...s, stage: "done" }));
        addLine(`[complete] #${event.data.issue} → ${event.data.prUrl} (${event.data.duration}s)`);
        break;
    }
  }

  function addLine(line: string) {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    if (!status.startTime) return;
    const start = new Date(status.startTime).getTime();
    const tick = () => {
      const diff = Math.floor((Date.now() - start) / 1000);
      const m = Math.floor(diff / 60);
      const s = diff % 60;
      setElapsed(`${m}:${s.toString().padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status.startTime]);

  return (
    <div>
      <div style={styles.statusBar}>
        <span style={styles.indicator(status.connected)} />
        <span style={styles.statusText}>
          {status.connected ? "Connected" : "Disconnected"}
        </span>
        {status.issue !== null && (
          <span style={styles.badge}>#{status.issue}</span>
        )}
        <span style={styles.stage}>{status.stage}</span>
        {status.startTime && <span style={styles.elapsed}>{elapsed}</span>}
      </div>
      <div ref={logRef} style={styles.log} data-testid="live-log">
        {lines.length === 0 ? (
          <div style={styles.empty}>Waiting for events...</div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              style={{
                ...styles.line,
                ...(line.startsWith("[error]") ? styles.errorLine : {}),
                ...(line.startsWith("[complete]") ? styles.completeLine : {}),
              }}
            >
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const styles = {
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    background: "#16213e",
    borderRadius: 8,
    marginBottom: 12,
    flexWrap: "wrap" as const,
    fontSize: 14,
  },
  indicator: (connected: boolean): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: connected ? "#4caf50" : "#f44336",
    flexShrink: 0,
  }),
  statusText: { color: "#a0a0b0", fontSize: 13 } as React.CSSProperties,
  badge: {
    background: "#2a2a4a",
    color: "#7c83ff",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  stage: {
    color: "#e0e0e0",
    fontWeight: 600,
    textTransform: "capitalize" as const,
  } as React.CSSProperties,
  elapsed: { color: "#a0a0b0", marginLeft: "auto" } as React.CSSProperties,
  log: {
    background: "#0f0f1a",
    borderRadius: 8,
    padding: 12,
    height: 400,
    overflowY: "auto" as const,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: 13,
    lineHeight: 1.6,
  } as React.CSSProperties,
  empty: { color: "#555", fontStyle: "italic" } as React.CSSProperties,
  line: { color: "#c8c8d0", whiteSpace: "pre-wrap" as const } as React.CSSProperties,
  errorLine: { color: "#f44336" } as React.CSSProperties,
  completeLine: { color: "#4caf50" } as React.CSSProperties,
};
