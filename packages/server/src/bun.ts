/**
 * @epicenter/server/bun: the Bun host surface.
 *
 * Same library, second runtime (ADR-0066). `apps/api/server.ts` composes its
 * server from here and serves it with `Bun.serve`: the self-host path, on
 * Postgres. This is the main barrel plus the modules a Worker cannot bundle.
 */

export * from './index.js';
// A folder's larger bytes on disk: the Bun entry's blob store.
export { createDiskBlobStore } from './log/disk-blob-store.js';
