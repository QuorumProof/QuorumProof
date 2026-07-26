import * as fs from "fs";
import * as path from "path";

/**
 * Snapshot Manager Helper
 *
 * Utilities for managing API response snapshots and detecting changes.
 */

export interface SnapshotDiff {
  key: string;
  old: any;
  new: any;
  type: "created" | "deleted" | "modified";
}

/**
 * Load snapshot from disk
 */
export function loadSnapshot(name: string, snapshotsDir: string): any {
  const filePath = path.join(snapshotsDir, `${name}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

/**
 * Save snapshot to disk
 */
export function saveSnapshot(name: string, data: any, snapshotsDir: string): void {
  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }

  const filePath = path.join(snapshotsDir, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Compare current response with snapshot
 */
export function compareWithSnapshot(
  current: any,
  snapshot: any,
  path = ""
): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];

  if (snapshot === null || snapshot === undefined) {
    diffs.push({
      key: path || "root",
      old: undefined,
      new: current,
      type: "created",
    });
    return diffs;
  }

  // Check all keys in current
  for (const key in current) {
    const currentValue = current[key];
    const snapshotValue = snapshot[key];
    const keyPath = path ? `${path}.${key}` : key;

    if (snapshotValue === undefined) {
      diffs.push({
        key: keyPath,
        old: undefined,
        new: currentValue,
        type: "created",
      });
    } else if (typeof currentValue === "object" && typeof snapshotValue === "object") {
      diffs.push(...compareWithSnapshot(currentValue, snapshotValue, keyPath));
    } else if (currentValue !== snapshotValue) {
      diffs.push({
        key: keyPath,
        old: snapshotValue,
        new: currentValue,
        type: "modified",
      });
    }
  }

  // Check for deleted keys
  for (const key in snapshot) {
    if (!(key in current)) {
      const keyPath = path ? `${path}.${key}` : key;
      diffs.push({
        key: keyPath,
        old: snapshot[key],
        new: undefined,
        type: "deleted",
      });
    }
  }

  return diffs;
}

/**
 * Format snapshot diffs for human review
 */
export function formatSnapshotDiff(diffs: SnapshotDiff[]): string {
  if (diffs.length === 0) {
    return "No differences found";
  }

  let output = `Found ${diffs.length} difference(s):\n\n`;

  for (const diff of diffs) {
    output += `${diff.type.toUpperCase()}: ${diff.key}\n`;

    if (diff.type === "created") {
      output += `  + ${JSON.stringify(diff.new)}\n`;
    } else if (diff.type === "deleted") {
      output += `  - ${JSON.stringify(diff.old)}\n`;
    } else {
      output += `  - Old: ${JSON.stringify(diff.old)}\n`;
      output += `  + New: ${JSON.stringify(diff.new)}\n`;
    }
    output += "\n";
  }

  return output;
}

/**
 * Get all snapshots in directory
 */
export function listSnapshots(snapshotsDir: string): string[] {
  if (!fs.existsSync(snapshotsDir)) {
    return [];
  }

  return fs
    .readdirSync(snapshotsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
}

/**
 * Delete old snapshots
 */
export function deleteSnapshot(name: string, snapshotsDir: string): void {
  const filePath = path.join(snapshotsDir, `${name}.json`);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Generate snapshot report
 */
export function generateSnapshotReport(
  snapshotsDir: string,
  currentSnapshots: Record<string, any>
): string {
  const existing = listSnapshots(snapshotsDir);
  const current = Object.keys(currentSnapshots);

  const added = current.filter((s) => !existing.includes(s));
  const removed = existing.filter((s) => !current.includes(s));
  const modified: string[] = [];

  for (const name of current) {
    if (existing.includes(name)) {
      const old = loadSnapshot(name, snapshotsDir);
      const diffs = compareWithSnapshot(currentSnapshots[name], old);
      if (diffs.length > 0) {
        modified.push(name);
      }
    }
  }

  let report = "Snapshot Summary\n";
  report += "================\n\n";
  report += `Total snapshots: ${existing.length}\n`;
  report += `Added: ${added.length}\n`;
  report += `Modified: ${modified.length}\n`;
  report += `Removed: ${removed.length}\n\n`;

  if (added.length > 0) {
    report += "Added snapshots:\n";
    added.forEach((s) => (report += `  + ${s}\n`));
    report += "\n";
  }

  if (modified.length > 0) {
    report += "Modified snapshots:\n";
    modified.forEach((s) => (report += `  ~ ${s}\n`));
    report += "\n";
  }

  if (removed.length > 0) {
    report += "Removed snapshots:\n";
    removed.forEach((s) => (report += `  - ${s}\n`));
    report += "\n";
  }

  return report;
}

/**
 * Mask sensitive data in snapshots
 * Useful for credentials, tokens, etc.
 */
export function maskSensitiveData(snapshot: any): any {
  const masked = JSON.parse(JSON.stringify(snapshot));

  function maskRecursive(obj: any): void {
    if (obj === null || obj === undefined) {
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach(maskRecursive);
      return;
    }

    if (typeof obj === "object") {
      for (const key in obj) {
        const value = obj[key];

        // Mask common sensitive fields
        if (
          key.toLowerCase().includes("secret") ||
          key.toLowerCase().includes("token") ||
          key.toLowerCase().includes("password") ||
          key.toLowerCase().includes("key")
        ) {
          obj[key] = "***MASKED***";
        } else if (typeof value === "object") {
          maskRecursive(value);
        }
      }
    }
  }

  maskRecursive(masked);
  return masked;
}
