import type Database from "better-sqlite3";
import type { AgentRunner } from "../engine/runner.js";
import type { Run, LearningType } from "../server/db.js";
import { createLearning } from "../server/db.js";

// --- Types ---

export interface RunContext {
  issueBody: string;
  diff: string;
  testOutput: string;
  reviewOutput: string;
  retryCount: number;
}

export interface ExtractedLearning {
  type: LearningType;
  content: string;
  confidence: number;
}

export interface ExtractionResult {
  learnings: ExtractedLearning[];
  raw: string;
}

// --- Prompt builder ---

export function buildAnalysisPrompt(run: Run, context: RunContext): string {
  return `Analyze this completed development run and extract learnings.

## Run Summary
- Issue: #${run.issue_number} "${run.issue_title}"
- Status: ${run.status}
- Duration: ${run.duration_seconds ?? "unknown"}s
- Agent: ${run.agent} (${run.model})
- Retry count: ${context.retryCount}

## Issue Requirements
${context.issueBody || "(no description)"}

## Code Diff
${context.diff || "(no diff available)"}

## Test Results
${context.testOutput || "(no test output)"}

## Review Report
${context.reviewOutput || "(no review output)"}

## Instructions
Analyze what happened in this run. Output ONLY a JSON array of learnings, no other text.
Each learning must have: type, content, confidence (0-1).

Types:
- "pattern" - Something that worked well, repeat it
- "anti_pattern" - Something that failed or caused issues, avoid it
- "prompt_improvement" - Specific improvement to agent prompts

Example output:
[
  {"type": "pattern", "content": "Breaking implementation into small commits helped the review pass on first try", "confidence": 0.8},
  {"type": "anti_pattern", "content": "Running all tests before fixing imports caused cascade failures", "confidence": 0.7}
]

Output ONLY the JSON array:`;
}

// --- JSON parsing ---

export function parseAgentOutput(raw: string): ExtractedLearning[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const validTypes = new Set<string>(["pattern", "anti_pattern", "prompt_improvement"]);

  return parsed.filter(
    (item): item is ExtractedLearning =>
      typeof item === "object" &&
      item !== null &&
      typeof item.type === "string" &&
      validTypes.has(item.type) &&
      typeof item.content === "string" &&
      item.content.length > 0 &&
      typeof item.confidence === "number" &&
      item.confidence >= 0 &&
      item.confidence <= 1,
  );
}

// --- Main extraction ---

export async function extractLearnings(
  run: Run,
  context: RunContext,
  runner: AgentRunner,
  db: Database.Database,
): Promise<ExtractionResult> {
  const prompt = buildAnalysisPrompt(run, context);

  const result = await runner.run({
    prompt,
    maxTurns: 5,
  });

  const learnings = parseAgentOutput(result.output);

  for (const learning of learnings) {
    createLearning(db, {
      run_id: run.id,
      issue_number: run.issue_number,
      type: learning.type,
      content: learning.content,
      confidence: learning.confidence,
    });
  }

  return { learnings, raw: result.output };
}
