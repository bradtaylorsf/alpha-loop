import * as readline from "node:readline";
import type { GitHubClient, GitHubIssue } from "../engine/github.js";

// --- Types ---

export interface IssueWithDeps {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  dependencies: number[];
}

// --- Dependency Parsing ---

/**
 * Parse dependency references from an issue body.
 * Supports: "Depends on #N", "Blocked by #N", "After #N", "Requires #N"
 * Also checks a "### Dependencies" section.
 */
export function parseDependencies(body: string | null): number[] {
  if (!body) return [];

  const deps = new Set<number>();

  // Inline patterns (case-insensitive)
  const inlinePattern =
    /(?:depends\s+on|blocked\s+by|after|requires)\s+#(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = inlinePattern.exec(body)) !== null) {
    deps.add(Number(match[1]));
  }

  // ### Dependencies section
  const sectionMatch = body.match(
    /###\s*Dependencies\s*\n([\s\S]*?)(?=\n###\s|\n$|$)/i,
  );
  if (sectionMatch) {
    const sectionBody = sectionMatch[1];
    const refPattern = /#(\d+)/g;
    while ((match = refPattern.exec(sectionBody)) !== null) {
      deps.add(Number(match[1]));
    }
  }

  return [...deps];
}

// --- Fetch & Enrich ---

export async function fetchReadyIssues(
  github: GitHubClient,
  label: string,
): Promise<IssueWithDeps[]> {
  const issues = await github.listIssues({
    labels: [label],
    state: "open",
    limit: 100,
  });

  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    dependencies: parseDependencies(issue.body),
  }));
}

// --- Topological Sort ---

/**
 * Sort issues so dependencies come before dependents.
 * Issues not in the input set have their dependency ignored.
 * Throws if a cycle is detected.
 */
export function sortByDependencies(issues: IssueWithDeps[]): IssueWithDeps[] {
  const issueMap = new Map(issues.map((i) => [i.number, i]));
  const sorted: IssueWithDeps[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();

  function visit(num: number): void {
    if (visited.has(num)) return;
    if (visiting.has(num)) {
      throw new Error(`Dependency cycle detected involving #${num}`);
    }
    visiting.add(num);

    const issue = issueMap.get(num);
    if (issue) {
      for (const dep of issue.dependencies) {
        if (issueMap.has(dep)) {
          visit(dep);
        }
      }
    }

    visiting.delete(num);
    visited.add(num);
    if (issue) sorted.push(issue);
  }

  for (const issue of issues) {
    visit(issue.number);
  }

  return sorted;
}

/**
 * Validate that a user-provided ordering respects dependencies.
 * Returns the first violation found, or null if valid.
 */
export function validateOrder(
  ordered: IssueWithDeps[],
): { issue: number; dependency: number } | null {
  const issueSet = new Set(ordered.map((i) => i.number));
  const positionOf = new Map(ordered.map((i, idx) => [i.number, idx]));

  for (const issue of ordered) {
    for (const dep of issue.dependencies) {
      if (!issueSet.has(dep)) continue;
      const depPos = positionOf.get(dep)!;
      const issuePos = positionOf.get(issue.number)!;
      if (depPos > issuePos) {
        return { issue: issue.number, dependency: dep };
      }
    }
  }

  return null;
}

// --- Display ---

export function formatIssueList(issues: IssueWithDeps[]): string {
  const issueSet = new Set(issues.map((i) => i.number));
  const lines: string[] = [];

  lines.push(`\nAvailable issues (${issues.length} ready):\n`);

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const num = String(i + 1).padStart(3);
    const issueNum = `#${issue.number}`.padEnd(6);
    let line = `  ${num}. [ ] ${issueNum} ${issue.title}`;

    // Show dependencies that are in the current list
    const relevantDeps = issue.dependencies.filter((d) => issueSet.has(d));
    if (relevantDeps.length > 0) {
      const depStr = relevantDeps.map((d) => `#${d}`).join(", ");
      line += `  (depends on ${depStr})`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

export function formatProcessingOrder(issues: IssueWithDeps[]): string {
  const lines: string[] = ["\nProcessing order:"];

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const num = String(i + 1).padStart(3);
    lines.push(`  ${num}. #${issue.number}  ${issue.title}`);
  }

  return lines.join("\n");
}

// --- Interactive Selection ---

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export async function interactiveSelect(
  issues: IssueWithDeps[],
): Promise<IssueWithDeps[]> {
  const rl = createInterface();
  const selected = new Set<number>();

  try {
    console.log(formatIssueList(issues));
    console.log(
      "\nType issue numbers to toggle (e.g. '1 3 5'), 'a' for all, 'n' for none, Enter to confirm:",
    );

    while (true) {
      const input = await ask(rl, "> ");

      if (input === "" && selected.size > 0) {
        break;
      }

      if (input === "") {
        console.log("No issues selected. Type numbers or 'a' for all.");
        continue;
      }

      if (input.toLowerCase() === "a") {
        issues.forEach((i) => selected.add(i.number));
        console.log(`Selected all ${issues.length} issues.`);
        break;
      }

      if (input.toLowerCase() === "n") {
        selected.clear();
        console.log("Cleared selection.");
        continue;
      }

      // Parse numbers
      const nums = input.split(/\s+/).map(Number).filter((n) => !isNaN(n));
      for (const n of nums) {
        if (n < 1 || n > issues.length) {
          console.log(`Invalid: ${n} (must be 1-${issues.length})`);
          continue;
        }
        const issueNum = issues[n - 1].number;
        if (selected.has(issueNum)) {
          selected.delete(issueNum);
          console.log(`Deselected #${issueNum}`);
        } else {
          selected.add(issueNum);
          console.log(`Selected #${issueNum}`);
        }
      }

      // Show current selection
      if (selected.size > 0) {
        const selStr = [...selected].map((n) => `#${n}`).join(", ");
        console.log(`Current: ${selStr} (Enter to confirm)`);
      }
    }

    // Build selected list
    let selectedIssues = issues.filter((i) => selected.has(i.number));

    // Check for missing dependencies
    selectedIssues = await checkMissingDependencies(
      rl,
      selectedIssues,
      issues,
    );

    // Sort by dependencies
    const sorted = sortByDependencies(selectedIssues);

    // Show processing order and allow reordering
    return await confirmOrder(rl, sorted);
  } finally {
    rl.close();
  }
}

async function checkMissingDependencies(
  rl: readline.Interface,
  selected: IssueWithDeps[],
  allIssues: IssueWithDeps[],
): Promise<IssueWithDeps[]> {
  const selectedNums = new Set(selected.map((i) => i.number));
  const allIssueMap = new Map(allIssues.map((i) => [i.number, i]));
  const result = [...selected];

  for (const issue of selected) {
    for (const dep of issue.dependencies) {
      if (selectedNums.has(dep)) continue;
      if (!allIssueMap.has(dep)) continue;

      const answer = await ask(
        rl,
        `\u26a0 #${issue.number} depends on #${dep} which is not selected. Add #${dep}? [Y/n] `,
      );

      if (answer.toLowerCase() !== "n") {
        const depIssue = allIssueMap.get(dep)!;
        result.push(depIssue);
        selectedNums.add(dep);
        console.log(`Added #${dep}: ${depIssue.title}`);
      }
    }
  }

  return result;
}

async function confirmOrder(
  rl: readline.Interface,
  sorted: IssueWithDeps[],
): Promise<IssueWithDeps[]> {
  console.log(formatProcessingOrder(sorted));

  const input = await ask(
    rl,
    '\nReorder? (type new order like "1,3,2" or Enter to keep): ',
  );

  if (!input) return sorted;

  const indices = input
    .split(/[,\s]+/)
    .map(Number)
    .filter((n) => !isNaN(n));

  if (indices.length !== sorted.length) {
    console.log(
      `Expected ${sorted.length} numbers, got ${indices.length}. Keeping original order.`,
    );
    return sorted;
  }

  // Check all indices are valid
  const valid = indices.every((n) => n >= 1 && n <= sorted.length);
  const unique = new Set(indices).size === indices.length;
  if (!valid || !unique) {
    console.log("Invalid indices. Keeping original order.");
    return sorted;
  }

  const reordered = indices.map((n) => sorted[n - 1]);

  // Validate dependencies
  const violation = validateOrder(reordered);
  if (violation) {
    console.log(
      `Error: #${violation.issue} depends on #${violation.dependency}, which must come first.`,
    );
    console.log("Keeping dependency-sorted order.");
    return sorted;
  }

  return reordered;
}

// --- Non-Interactive Modes ---

/**
 * Process all ready issues (--all flag).
 */
export async function selectAll(
  github: GitHubClient,
  label: string,
): Promise<IssueWithDeps[]> {
  const issues = await fetchReadyIssues(github, label);
  if (issues.length === 0) return [];
  return sortByDependencies(issues);
}

/**
 * Process specific issues by number (--issues flag).
 */
export async function selectSpecific(
  github: GitHubClient,
  label: string,
  issueNumbers: number[],
): Promise<IssueWithDeps[]> {
  const allIssues = await fetchReadyIssues(github, label);
  const issueMap = new Map(allIssues.map((i) => [i.number, i]));
  const selected: IssueWithDeps[] = [];

  for (const num of issueNumbers) {
    const issue = issueMap.get(num);
    if (!issue) {
      console.warn(
        `Warning: Issue #${num} not found or not labeled '${label}', skipping.`,
      );
      continue;
    }
    selected.push(issue);
  }

  return sortByDependencies(selected);
}

/**
 * Full interactive selection flow.
 */
export async function selectInteractive(
  github: GitHubClient,
  label: string,
): Promise<IssueWithDeps[]> {
  const issues = await fetchReadyIssues(github, label);

  if (issues.length === 0) {
    console.log(`No issues labeled '${label}' found.`);
    return [];
  }

  return interactiveSelect(issues);
}
