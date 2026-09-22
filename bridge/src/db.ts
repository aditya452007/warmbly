import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BridgeDb = InstanceType<typeof Database>;

// Opens the bridge SQLite database: ensures the parent directory exists,
// enables WAL mode with a bounded busy timeout and foreign keys, then
// applies schema.sql idempotently. No secrets are read or written here.
export function openBridgeDb(dbPath: string): BridgeDb {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  const schemaPath = fileURLToPath(new URL("./db/schema.sql", import.meta.url));
  db.exec(readFileSync(schemaPath, "utf8"));
  // Forward-only additive migrations for databases created before a column
  // existed. CREATE TABLE IF NOT EXISTS cannot add columns to old files.
  for (const [table, column, ddl] of [
    ["outreach_drafts", "source", "TEXT NOT NULL DEFAULT 'ai'"],
    ["outreach_drafts", "version", "INTEGER NOT NULL DEFAULT 1"],
  ] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
  return db;
}

export function closeDb(db: BridgeDb): void {
  if (db.open) db.close();
}
