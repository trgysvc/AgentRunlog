/**
 * Bump when the shape/completeness of imported history changes. A project whose last sync used an
 * older version re-imports automatically in the background (v2: messages are no longer truncated).
 */
export const IMPORT_VERSION = 2;
/** Minimum time between automatic background history syncs. */
export const HISTORY_SYNC_INTERVAL_MS = 30 * 60 * 1000;
