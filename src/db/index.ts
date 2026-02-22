import Database from "better-sqlite3";

export interface DbHandle {
  db: Database.Database;
}

export function openDatabase(path: string): DbHandle {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return { db };
}

export function closeDatabase(handle: DbHandle): void {
  handle.db.close();
}
