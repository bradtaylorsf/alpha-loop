import Database from "better-sqlite3";
import node_path from "node:path";
import fs from "node:fs";

export interface Run {
  id: number;
  issue_number: number;
  issue_title: string;
  agent: string;
  model: string;
  status: "running" | "success" | "failure";
  stages_json: string;
  pr_url: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface CreateRunInput {
  issue_number: number;
  issue_title: string;
  agent: string;
  model: string;
}

export interface UpdateRunInput {
  status?: Run["status"];
  stages_json?: string;
  pr_url?: string;
  duration_seconds?: number;
}

export type LearningType = "pattern" | "anti_pattern" | "prompt_improvement";

export interface Learning {
  id: number;
  run_id: number;
  issue_number: number;
  type: LearningType;
  content: string;
  confidence: number;
  created_at: string;
}

export interface CreateLearningInput {
  run_id: number;
  issue_number: number;
  type: LearningType;
  content: string;
  confidence: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    stages_json TEXT NOT NULL DEFAULT '[]',
    pr_url TEXT,
    duration_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    issue_number INTEGER NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  )
`;

export function createDatabase(dbPath?: string): Database.Database {
  if (!dbPath) {
    const dataDir = node_path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    dbPath = node_path.join(dataDir, "alpha-loop.db");
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function createInMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

export function createRun(db: Database.Database, input: CreateRunInput): Run {
  const stmt = db.prepare(
    `INSERT INTO runs (issue_number, issue_title, agent, model) VALUES (?, ?, ?, ?)`
  );
  const result = stmt.run(input.issue_number, input.issue_title, input.agent, input.model);
  return getRun(db, result.lastInsertRowid as number)!;
}

export function getRun(db: Database.Database, id: number): Run | undefined {
  const stmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  return stmt.get(id) as Run | undefined;
}

export function updateRun(db: Database.Database, id: number, input: UpdateRunInput): Run | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.status !== undefined) {
    fields.push("status = ?");
    values.push(input.status);
  }
  if (input.stages_json !== undefined) {
    fields.push("stages_json = ?");
    values.push(input.stages_json);
  }
  if (input.pr_url !== undefined) {
    fields.push("pr_url = ?");
    values.push(input.pr_url);
  }
  if (input.duration_seconds !== undefined) {
    fields.push("duration_seconds = ?");
    values.push(input.duration_seconds);
  }

  if (fields.length === 0) return getRun(db, id);

  values.push(id);
  const stmt = db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`);
  stmt.run(...values);
  return getRun(db, id);
}

export function listRuns(
  db: Database.Database,
  options: { limit?: number; offset?: number } = {}
): { runs: Run[]; total: number } {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) as count FROM runs`).get() as { count: number }).count;
  const runs = db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as Run[];

  return { runs, total };
}

// --- Learnings CRUD ---

export function createLearning(db: Database.Database, input: CreateLearningInput): Learning {
  const stmt = db.prepare(
    `INSERT INTO learnings (run_id, issue_number, type, content, confidence) VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(input.run_id, input.issue_number, input.type, input.content, input.confidence);
  return getLearning(db, result.lastInsertRowid as number)!;
}

export function getLearning(db: Database.Database, id: number): Learning | undefined {
  return db.prepare(`SELECT * FROM learnings WHERE id = ?`).get(id) as Learning | undefined;
}

export function listLearnings(
  db: Database.Database,
  options: { limit?: number; offset?: number; type?: LearningType } = {}
): { learnings: Learning[]; total: number } {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  if (options.type) {
    const total = (db.prepare(`SELECT COUNT(*) as count FROM learnings WHERE type = ?`).get(options.type) as { count: number }).count;
    const learnings = db.prepare(`SELECT * FROM learnings WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(options.type, limit, offset) as Learning[];
    return { learnings, total };
  }

  const total = (db.prepare(`SELECT COUNT(*) as count FROM learnings`).get() as { count: number }).count;
  const learnings = db.prepare(`SELECT * FROM learnings ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as Learning[];
  return { learnings, total };
}
