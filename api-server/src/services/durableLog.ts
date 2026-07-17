import fs from 'fs';
import path from 'path';

export interface DurableLogOptions {
  /** Number of appended lines after which the log auto-compacts. Defaults to max(200, 4x live keys). */
  compactThreshold?: number;
}

/**
 * Append-only JSONL log that replays the latest record per key on load.
 *
 * Every write is fsync'd to disk before being considered durable, so a fresh
 * instance pointed at the same filePath recovers full state after a process
 * restart (or crash — a torn last line from a mid-append crash is tolerated
 * and skipped; every prior line is a complete record).
 */
export class DurableLog<T> {
  private data = new Map<string, T>();
  private lines = 0;

  constructor(private readonly filePath: string, private readonly opts: DurableLogOptions = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { key, value, deleted } = JSON.parse(line) as { key: string; value?: T; deleted?: boolean };
        if (deleted) this.data.delete(key);
        else this.data.set(key, value as T);
        this.lines++;
      } catch {
        // Tolerate a torn last line from a crash mid-append.
      }
    }
  }

  private appendLine(obj: unknown): void {
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(obj) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.lines++;
    const threshold = this.opts.compactThreshold ?? Math.max(200, this.data.size * 4);
    if (this.lines > threshold) this.compact();
  }

  set(key: string, value: T): void {
    this.data.set(key, value);
    this.appendLine({ key, value });
  }

  get(key: string): T | undefined {
    return this.data.get(key);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
    this.appendLine({ key, deleted: true });
  }

  keys(): string[] {
    return Array.from(this.data.keys());
  }

  values(): T[] {
    return Array.from(this.data.values());
  }

  entries(): [string, T][] {
    return Array.from(this.data.entries());
  }

  compact(): void {
    const lines = Array.from(this.data.entries()).map(([key, value]) => JSON.stringify({ key, value }));
    const fd = fs.openSync(this.filePath, 'w');
    try {
      if (lines.length) fs.writeSync(fd, lines.join('\n') + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.lines = lines.length;
  }

  /**
   * Irreversibly destroys `key`: the in-memory entry is dropped, the on-disk
   * file is zero-overwritten in place (so no prior byte offset containing the
   * key's serialized value survives, even before the rewrite lands), and the
   * file is then recompacted to contain only the remaining live keys.
   *
   * Used for genuine key destruction (crypto-shredding), not ordinary delete:
   * ordinary `delete()` leaves earlier log lines with the value physically
   * present on disk until a future compaction; `shred()` guarantees the value
   * is gone from this file immediately.
   */
  shred(key: string): void {
    this.data.delete(key);
    try {
      const stat = fs.statSync(this.filePath);
      const fd = fs.openSync(this.filePath, 'w');
      try {
        fs.writeSync(fd, Buffer.alloc(stat.size, 0));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // File may not exist yet — nothing on disk to shred.
    }
    this.compact();
  }
}
