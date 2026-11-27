import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export const hash = (value) => createHash("sha256").update(value).digest("hex");

// Records are atomic and fsynced before the client sees completion. Session
// transactions use OS-owned SQLite locks, shared across overlapping Bun hosts.
// A crash releases the lock automatically; the pending journal stays on disk.
export class SessionStore {
  constructor(directory) { this.directory = resolve(directory); }
  async start() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }

  path(namespace, kind, id) { return join(this.directory, hash(JSON.stringify([namespace, kind, id])) + ".json"); }

  async get(namespace, kind, id) {
    let record;
    try { record = JSON.parse(await readFile(this.path(namespace, kind, id), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (record.version !== 1 || record.namespace !== namespace || record.kind !== kind || record.id !== id) throw new Error("invalid session record");
    return record.value;
  }

  async put(namespace, kind, id, value) {
    const target = this.path(namespace, kind, id), temp = target + "." + randomUUID() + ".tmp";
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, namespace, kind, id, value }));
      await file.sync();
      await file.close();
      await rename(temp, target);
      // Windows cannot fsync a directory (EPERM in Node and Bun). The file
      // is still fsynced before the atomic rename; retain directory fsync
      // on platforms that support it rather than suppressing file errors.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  async close() {}
}

let databaseClass;
// Keep native handles strongly reachable while a streaming transaction waits.
const activeDatabases = new Set();
async function openLockDatabase(file) {
  databaseClass ??= (async () => {
    if (globalThis.Bun) return (await import("bun:sqlite")).Database;
    return (await import("node:sqlite")).DatabaseSync;
  })();
  const Database = await databaseClass;
  // Precreate with private permissions; SQLite must not inherit a loose umask.
  try { const handle = await open(file, "wx", 0o600); await handle.close(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return new Database(file);
}

export class SessionLocks {
  constructor(directory) { this.directory = resolve(directory, ".locks"); }

  async run(key, signal, fn) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const db = await openLockDatabase(join(this.directory, hash(key) + ".sqlite"));
    activeDatabases.add(db);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      for (;;) {
        signal?.throwIfAborted();
        try {
          // Initialize a stable SQLite file before acquiring the write lock.
          db.exec("CREATE TABLE IF NOT EXISTS session_lock (id INTEGER PRIMARY KEY)");
          db.exec("BEGIN IMMEDIATE"); break;
        }
        catch (error) {
          if (!/busy|locked/i.test(error.message)) throw error;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      try { signal?.throwIfAborted(); return await fn(); }
      finally { db.exec("ROLLBACK"); }
    } finally { activeDatabases.delete(db); db.close(); }
  }
}
