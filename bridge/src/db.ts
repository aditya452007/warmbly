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
  return db;
}

export function closeDb(db: BridgeDb): void {
  if (db.open) db.close();
}
