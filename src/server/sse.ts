import { EventEmitter } from "node:events";

export interface StageEvent {
  type: "stage";
  data: { issue: number; stage: string; timestamp: string };
}

export interface StageStartEvent {
  type: "stage_start";
  data: { issue: number; stage: string; timestamp: string };
}

export interface StageCompleteEvent {
  type: "stage_complete";
  data: { issue: number; stage: string; duration: number; timestamp: string };
}

export interface OutputEvent {
  type: "output";
  data: { line: string; timestamp: string };
}

export interface TestResultEvent {
  type: "test_result";
  data: { passed: number; failed: number; attempt: number; maxAttempts: number; timestamp: string };
}

export interface TestEvent {
  type: "test";
  data: { passed: number; failed: number; timestamp: string };
}

export interface ReviewResultEvent {
  type: "review_result";
  data: { issue: number; success: boolean; timestamp: string };
}

export interface ErrorEvent {
  type: "error";
  data: { message: string; stage: string; timestamp: string };
}

export interface CompleteEvent {
  type: "complete";
  data: { issue: number; prUrl: string; duration: number };
}

export interface LearningEvent {
  type: "learning";
  data: { issue: number; count: number; timestamp: string };
}

export type LoopEvent =
  | StageEvent
  | StageStartEvent
  | StageCompleteEvent
  | OutputEvent
  | TestEvent
  | TestResultEvent
  | ReviewResultEvent
  | ErrorEvent
  | CompleteEvent
  | LearningEvent;

export interface SequencedEvent {
  id: number;
  event: LoopEvent;
}

const MAX_BUFFER_SIZE = 1000;

class SSEBroadcaster {
  private emitter = new EventEmitter();
  private sequence = 0;
  private buffer: SequencedEvent[] = [];

  emit(event: LoopEvent): number {
    const id = ++this.sequence;
    const sequenced: SequencedEvent = { id, event };
    this.buffer.push(sequenced);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
    }
    this.emitter.emit("loopEvent", sequenced);
    return id;
  }

  on(listener: (event: SequencedEvent) => void): void {
    this.emitter.on("loopEvent", listener);
  }

  off(listener: (event: SequencedEvent) => void): void {
    this.emitter.off("loopEvent", listener);
  }

  replay(lastEventId: number): SequencedEvent[] {
    return this.buffer.filter((e) => e.id > lastEventId);
  }

  listenerCount(): number {
    return this.emitter.listenerCount("loopEvent");
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }

  getSequence(): number {
    return this.sequence;
  }
}

export const broadcaster = new SSEBroadcaster();

// Backward-compatible loopEmitter that wraps the broadcaster
const loopEventEmitter = new EventEmitter();

// Proxy: when engine code calls loopEmitter.emit("loopEvent", event),
// route through the broadcaster for sequencing
const originalEmit = loopEventEmitter.emit.bind(loopEventEmitter);
loopEventEmitter.emit = function (eventName: string, ...args: unknown[]): boolean {
  if (eventName === "loopEvent") {
    broadcaster.emit(args[0] as LoopEvent);
    return true;
  }
  return originalEmit(eventName, ...args);
};

export const loopEmitter = loopEventEmitter;
