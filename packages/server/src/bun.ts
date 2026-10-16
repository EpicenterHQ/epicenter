/**
 * @epicenter/server/bun: the Bun host surface.
 *
 * Same library, second runtime (ADR-0066). `apps/api/server.ts` composes its
 * server from here and serves it with `Bun.serve`: the self-host path, on
 * Postgres. This is the main barrel plus the modules a Worker cannot bundle.
 */

// Resolve-once, address-pinned CIMD transport for a Node or Bun host.
export { fetchClientMetadataResource as nodeClientMetadataFetch } from '@better-auth/cimd/node';
// Bare repositories on disk behind `git http-backend`, the Bun entry's store.
export { createDiskGitHost } from './git-disk-store.js';
export * from './index.js';
