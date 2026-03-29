import { EventEmitter } from "node:events";

export interface StageEvent {
  type: "stage";
  data: { issue: number; stage: string; timestamp: string };
}

export interface OutputEvent {
  type: "output";
  data: { line: string; timestamp: string };
}

export interface TestEvent {
  type: "test";
  data: { passed: number; failed: number; timestamp: string };
}

export interface ErrorEvent {
  type: "error";
  data: { message: string; stage: string; timestamp: string };
}

export interface CompleteEvent {
  type: "complete";
  data: { issue: number; prUrl: string; duration: number };
}

export type LoopEvent = StageEvent | OutputEvent | TestEvent | ErrorEvent | CompleteEvent;

const loopEventEmitter = new EventEmitter();

export const loopEmitter = loopEventEmitter;
