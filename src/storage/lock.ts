import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';

export const DEFAULT_STALE_MS = 10 * 60 * 1000;

/** True when the lock file exists and is younger than staleMs. */
export function isLockFresh(lockPath: string, staleMs: number = DEFAULT_STALE_MS): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < staleMs;
  } catch {
    return false;
  }
}

/**
 * Acquires an exclusive lock (O_EXCL). A stale lock (crashed worker) is taken over.
 * Returns a release function, or null if another live worker holds the lock.
 */
export function acquireLock(lockPath: string, staleMs: number = DEFAULT_STALE_MS): (() => void) | null {
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (!tryCreate()) {
    if (isLockFresh(lockPath, staleMs)) return null;
    try {
      unlinkSync(lockPath);
    } catch {}
    if (!tryCreate()) return null;
  }
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {}
  };
}
