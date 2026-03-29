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
  stage_durations_json: string;
  pr_url: string | null;
  duration_seconds: number | null;
  test_output: string | null;
  review_output: string | null;
  diff_stat: string | null;
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
  stage_durations_json?: string;
  pr_url?: string;
  duration_seconds?: number;
  test_output?: string;
  review_output?: string;
  diff_stat?: string;
}

// --- Session types ---

export type SessionStatus = "pending" | "active" | "completed" | "cancelled";
export type SessionIssueStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Session {
  id: number;
  name: string;
  status: SessionStatus;
  created_at: string;
  completed_at: string | null;
}

export interface SessionIssue {
  id: number;
  session_id: number;
  issue_number: number;
  position: number;
  status: SessionIssueStatus;
  pr_url: string | null;
}

export interface CreateSessionInput {
  name: string;
  issues: { issue_number: number; position?: number }[];
}

export interface UpdateSessionIssueOrderInput {
  issues: { issue_number: number; position: number }[];
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
    stage_durations_json TEXT NOT NULL DEFAULT '{}',
    pr_url TEXT,
    duration_seconds INTEGER,
    test_output TEXT,
    review_output TEXT,
    diff_stat TEXT,
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

const SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS session_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    issue_number INTEGER NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pr_url TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`;

const MIGRATIONS = [
  // Add new columns to existing databases
  `ALTER TABLE runs ADD COLUMN stage_durations_json TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE runs ADD COLUMN test_output TEXT`,
  `ALTER TABLE runs ADD COLUMN review_output TEXT`,
  `ALTER TABLE runs ADD COLUMN diff_stat TEXT`,
];

function applyMigrations(db: Database.Database): void {
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Column already exists — ignore
    }
  }
}

export function createDatabase(dbPath?: string): Database.Database {
  if (!dbPath) {
    dbPath = process.env.DATABASE_PATH;
  }

  if (dbPath === ":memory:") {
    return createInMemoryDatabase();
  }

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
  db.exec(SESSIONS_SCHEMA);
  applyMigrations(db);
  return db;
}

export function createInMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.exec(SESSIONS_SCHEMA);
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
  if (input.stage_durations_json !== undefined) {
    fields.push("stage_durations_json = ?");
    values.push(input.stage_durations_json);
  }
  if (input.pr_url !== undefined) {
    fields.push("pr_url = ?");
    values.push(input.pr_url);
  }
  if (input.duration_seconds !== undefined) {
    fields.push("duration_seconds = ?");
    values.push(input.duration_seconds);
  }
  if (input.test_output !== undefined) {
    fields.push("test_output = ?");
    values.push(input.test_output);
  }
  if (input.review_output !== undefined) {
    fields.push("review_output = ?");
    values.push(input.review_output);
  }
  if (input.diff_stat !== undefined) {
    fields.push("diff_stat = ?");
    values.push(input.diff_stat);
  }

  if (fields.length === 0) return getRun(db, id);

  values.push(id);
  const stmt = db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`);
  stmt.run(...values);
  return getRun(db, id);
}

export interface ListRunsOptions {
  limit?: number;
  offset?: number;
  status?: string;
  issueNumber?: number;
  search?: string;
}

export function listRuns(
  db: Database.Database,
  options: ListRunsOptions = {}
): { runs: Run[]; total: number } {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.issueNumber) {
    conditions.push("issue_number = ?");
    params.push(options.issueNumber);
  }
  if (options.search) {
    conditions.push("(issue_title LIKE ? OR CAST(issue_number AS TEXT) LIKE ?)");
    params.push(`%${options.search}%`, `%${options.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) as count FROM runs ${where}`).get(...params) as { count: number }).count;
  const runs = db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Run[];

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

// --- Sessions CRUD ---

export function createSession(db: Database.Database, input: CreateSessionInput): Session & { issues: SessionIssue[] } {
  const insertSession = db.prepare(
    `INSERT INTO sessions (name) VALUES (?)`
  );
  const insertIssue = db.prepare(
    `INSERT INTO session_issues (session_id, issue_number, position) VALUES (?, ?, ?)`
  );

  const result = db.transaction(() => {
    const res = insertSession.run(input.name);
    const sessionId = res.lastInsertRowid as number;

    for (let i = 0; i < input.issues.length; i++) {
      const issue = input.issues[i];
      insertIssue.run(sessionId, issue.issue_number, issue.position ?? i);
    }

    return sessionId;
  })();

  return getSession(db, result)!;
}

export function getSession(db: Database.Database, id: number): (Session & { issues: SessionIssue[] }) | undefined {
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session | undefined;
  if (!session) return undefined;

  const issues = db.prepare(
    `SELECT * FROM session_issues WHERE session_id = ? ORDER BY position ASC`
  ).all(id) as SessionIssue[];

  return { ...session, issues };
}

export function listSessions(
  db: Database.Database,
  options: { status?: string } = {}
): (Session & { issues: SessionIssue[] })[] {
  let sessions: Session[];
  if (options.status) {
    sessions = db.prepare(`SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC, id DESC`).all(options.status) as Session[];
  } else {
    sessions = db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC, id DESC`).all() as Session[];
  }

  return sessions.map((s) => {
    const issues = db.prepare(
      `SELECT * FROM session_issues WHERE session_id = ? ORDER BY position ASC`
    ).all(s.id) as SessionIssue[];
    return { ...s, issues };
  });
}

export function updateSessionStatus(
  db: Database.Database,
  id: number,
  status: SessionStatus
): (Session & { issues: SessionIssue[] }) | undefined {
  const completedAt = status === "completed" || status === "cancelled" ? "datetime('now')" : "NULL";
  db.prepare(`UPDATE sessions SET status = ?, completed_at = ${completedAt} WHERE id = ?`).run(status, id);
  return getSession(db, id);
}

export function reorderSessionIssues(
  db: Database.Database,
  sessionId: number,
  input: UpdateSessionIssueOrderInput
): (Session & { issues: SessionIssue[] }) | undefined {
  const stmt = db.prepare(
    `UPDATE session_issues SET position = ? WHERE session_id = ? AND issue_number = ?`
  );

  db.transaction(() => {
    for (const issue of input.issues) {
      stmt.run(issue.position, sessionId, issue.issue_number);
    }
  })();

  return getSession(db, sessionId);
}

export function deleteSession(db: Database.Database, id: number): boolean {
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Session | undefined;
  if (!session) return false;
  if (session.status !== "pending") return false;

  db.transaction(() => {
    db.prepare(`DELETE FROM session_issues WHERE session_id = ?`).run(id);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  })();

  return true;
}

export function updateSessionIssueStatus(
  db: Database.Database,
  sessionId: number,
  issueNumber: number,
  status: SessionIssueStatus,
  prUrl?: string
): void {
  if (prUrl !== undefined) {
    db.prepare(
      `UPDATE session_issues SET status = ?, pr_url = ? WHERE session_id = ? AND issue_number = ?`
    ).run(status, prUrl, sessionId, issueNumber);
  } else {
    db.prepare(
      `UPDATE session_issues SET status = ? WHERE session_id = ? AND issue_number = ?`
    ).run(status, sessionId, issueNumber);
  }
}

export function getActiveSession(db: Database.Database): (Session & { issues: SessionIssue[] }) | undefined {
  const session = db.prepare(`SELECT * FROM sessions WHERE status = 'active' LIMIT 1`).get() as Session | undefined;
  if (!session) return undefined;

  const issues = db.prepare(
    `SELECT * FROM session_issues WHERE session_id = ? ORDER BY position ASC`
  ).all(session.id) as SessionIssue[];

  return { ...session, issues };
}
