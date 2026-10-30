/**
 * @epicenter/server/bun: the Bun host surface.
 *
 * Same library, second runtime (ADR-0066). `apps/api/server.ts` composes its
 * server from here and serves it with `Bun.serve`: the self-host path, on
 * Postgres. This is the main barrel plus the modules a Worker cannot bundle.
 */

// Bare repositories on disk (clone and fetch through `git http-backend`;
// pushes and web writes through the receiver and translator), and Git LFS
// objects on disk: the Bun entry's stores.
export { createDiskGitHost } from './git-disk-store.js';
export * from './index.js';
export { createDiskLfsStore } from './lfs/disk-lfs-store.js';
