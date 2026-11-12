import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function dirSize(path: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  if (!existsSync(path)) return { bytes, files };
  for (const name of readdirSync(path)) {
    const p = join(path, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        const sub = dirSize(p);
        bytes += sub.bytes;
        files += sub.files;
      } else {
        bytes += st.size;
        files++;
      }
    } catch {}
  }
  return { bytes, files };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Disk usage of the .agentrunlog directory, broken down by its top-level folders. */
export function storageUsage(root: string): { total: number; entries: { name: string; bytes: number; files: number }[] } {
  const entries: { name: string; bytes: number; files: number }[] = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory()) entries.push({ name: name + '/', ...dirSize(p) });
        else entries.push({ name, bytes: statSync(p).size, files: 1 });
      } catch {}
    }
  }
  return { total: entries.reduce((a, e) => a + e.bytes, 0), entries };
}
