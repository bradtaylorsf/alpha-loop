import React, { useEffect, useRef, useState, useCallback } from "react";

interface StageEvent {
  type: "stage";
  data: { issue: number; stage: string; timestamp: string };
}
interface StageStartEvent {
  type: "stage_start";
  data: { issue: number; stage: string; timestamp: string };
}
interface StageCompleteEvent {
  type: "stage_complete";
  data: { issue: number; stage: string; duration: number; timestamp: string };
}
interface OutputEvent {
  type: "output";
  data: { line: string; timestamp: string };
}
interface TestEvent {
  type: "test";
  data: { passed: number; failed: number; timestamp: string };
}
interface TestResultEvent {
  type: "test_result";
  data: { passed: number; failed: number; attempt: number; maxAttempts: number; timestamp: string };
}
interface ReviewResultEvent {
  type: "review_result";
  data: { issue: number; success: boolean; timestamp: string };
}
interface ErrorEvent {
  type: "error";
  data: { message: string; stage: string; timestamp: string };
}
interface CompleteEvent {
  type: "complete";
  data: { issue: number; prUrl: string; duration: number };
}

type LoopEvent =
  | StageEvent
  | StageStartEvent
  | StageCompleteEvent
  | OutputEvent
  | TestEvent
  | TestResultEvent
  | ReviewResultEvent
  | ErrorEvent
  | CompleteEvent;

const PIPELINE_STAGES = ["setup", "implement", "test", "review", "pr", "done"] as const;

interface StageTiming {
  stage: string;
  startTime: string;
  duration?: number;
}

interface Toast {
  id: number;
  message: string;
  type: "success" | "error" | "info";
  timestamp: number;
}

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
  const [stageTimings, setStageTimings] = useState<StageTiming[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastEventId, setLastEventId] = useState<number>(0);
  const logRef = useRef<HTMLDivElement>(null);
  const toastIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  const addToast = useCallback((message: string, type: Toast["type"]) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-4), { id, message, type, timestamp: Date.now() }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const handleEvent = useCallback((event: LoopEvent) => {
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
      case "stage_start":
        setStageTimings((prev) => [
          ...prev.filter((t) => t.stage !== event.data.stage),
          { stage: event.data.stage, startTime: event.data.timestamp },
        ]);
        break;
      case "stage_complete":
        setStageTimings((prev) =>
          prev.map((t) =>
            t.stage === event.data.stage ? { ...t, duration: event.data.duration } : t
          )
        );
        addLine(`[stage_complete] ${event.data.stage} (${event.data.duration}s)`);
        break;
      case "output":
        addLine(event.data.line);
        break;
      case "test":
        addLine(`[test] passed: ${event.data.passed}, failed: ${event.data.failed}`);
        break;
      case "test_result":
        addLine(`[test] attempt ${event.data.attempt}/${event.data.maxAttempts} — passed: ${event.data.passed}, failed: ${event.data.failed}`);
        break;
      case "review_result":
        addLine(`[review] #${event.data.issue} — ${event.data.success ? "passed" : "issues found"}`);
        break;
      case "error":
        addLine(`[error] ${event.data.stage}: ${event.data.message}`);
        addToast(`Failed at ${event.data.stage}: ${event.data.message}`, "error");
        break;
      case "complete":
        setStatus((s) => ({ ...s, stage: "done" }));
        addLine(`[complete] #${event.data.issue} → ${event.data.prUrl} (${event.data.duration}s)`);
        addToast(`Issue #${event.data.issue} completed — PR created`, "success");
        break;
    }
  }, [addToast]);

  function addLine(line: string) {
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }

  useEffect(() => {
    function connect() {
      const url = lastEventId > 0 ? `/api/stream` : "/api/stream";
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        setStatus((s) => ({ ...s, connected: true }));
      };

      es.onmessage = (msg) => {
        try {
          // Parse the id from the raw event if available
          const parsed = JSON.parse(msg.data);
          if (msg.lastEventId) {
            setLastEventId(parseInt(msg.lastEventId) || 0);
          }
          handleEvent(parsed as LoopEvent);
        } catch {
          // ignore malformed messages
        }
      };

      es.onerror = () => {
        setStatus((s) => ({ ...s, connected: false }));
      };
    }

    connect();
    return () => {
      esRef.current?.close();
    };
  }, [handleEvent, lastEventId]);

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

  const currentStageIndex = PIPELINE_STAGES.indexOf(status.stage as typeof PIPELINE_STAGES[number]);

  return (
    <div>
      {/* Toast notifications */}
      <div style={styles.toastContainer} data-testid="toast-container">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            style={{
              ...styles.toast,
              borderLeft: `4px solid ${toast.type === "success" ? "#4caf50" : toast.type === "error" ? "#f44336" : "#2196f3"}`,
            }}
            data-testid="toast"
          >
            {toast.message}
          </div>
        ))}
      </div>

      {/* Status bar */}
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

      {/* Pipeline progress indicator */}
      {status.stage !== "idle" && (
        <div style={styles.pipeline} data-testid="pipeline-progress">
          {PIPELINE_STAGES.map((stage, i) => {
            const timing = stageTimings.find((t) => t.stage === stage);
            const isActive = status.stage === stage;
            const isComplete = currentStageIndex > i || status.stage === "done";
            const isFailed = status.stage === "failed" && currentStageIndex === -1;

            return (
              <div key={stage} style={styles.pipelineStage}>
                <div
                  style={{
                    ...styles.pipelineDot,
                    background: isActive
                      ? "#ff9800"
                      : isComplete
                      ? "#4caf50"
                      : isFailed
                      ? "#f44336"
                      : "#333",
                  }}
                  data-testid={`pipeline-dot-${stage}`}
                />
                <span
                  style={{
                    ...styles.pipelineLabel,
                    color: isActive ? "#ff9800" : isComplete ? "#4caf50" : "#666",
                  }}
                >
                  {stage}
                </span>
                {timing?.duration !== undefined && (
                  <span style={styles.pipelineDuration}>{timing.duration}s</span>
                )}
                {i < PIPELINE_STAGES.length - 1 && (
                  <div
                    style={{
                      ...styles.pipelineConnector,
                      background: isComplete ? "#4caf50" : "#333",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Log output */}
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
                ...(line.startsWith("[stage_complete]") ? styles.stageCompleteLine : {}),
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

const styles: Record<string, React.CSSProperties | ((...args: any[]) => React.CSSProperties)> = {
  toastContainer: {
    position: "fixed" as const,
    top: 16,
    right: 16,
    zIndex: 1000,
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  },
  toast: {
    background: "#1e1e3a",
    color: "#e0e0e0",
    padding: "10px 16px",
    borderRadius: 6,
    fontSize: 13,
    maxWidth: 350,
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  },
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
  pipeline: {
    display: "flex",
    alignItems: "center",
    gap: 0,
    padding: "12px 14px",
    background: "#16213e",
    borderRadius: 8,
    marginBottom: 12,
    overflowX: "auto" as const,
  } as React.CSSProperties,
  pipelineStage: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    position: "relative" as const,
    flex: 1,
    minWidth: 60,
  } as React.CSSProperties,
  pipelineDot: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    marginBottom: 4,
  } as React.CSSProperties,
  pipelineLabel: {
    fontSize: 11,
    textTransform: "capitalize" as const,
    fontWeight: 500,
  } as React.CSSProperties,
  pipelineDuration: {
    fontSize: 10,
    color: "#a0a0b0",
    marginTop: 2,
  } as React.CSSProperties,
  pipelineConnector: {
    position: "absolute" as const,
    top: 6,
    left: "60%",
    right: "-40%",
    height: 2,
  } as React.CSSProperties,
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
  stageCompleteLine: { color: "#81c784" } as React.CSSProperties,
};
