/**
 * Dev-only Bun entrypoint: the apps/api server with the `Bearer dev:<principalId>`
 * resolver injected, so the runtime-parity smoke (and CI) can drive the authed
 * surfaces without Google OAuth or a forged session.
 *
 * It boots the SAME {@link startBunApiServer} production uses, passing only the
 * dev `resolveBearerPrincipal`. This is the ONLY file that imports the credential bypass
 * ({@link resolveDevPrincipal}); the production entrypoints (`worker/index.ts`,
 * `server.ts`) never do, so the bypass cannot ship. Run it explicitly
 * (`bun server.dev.ts`, or `bun run dev:bun:devauth`); never wire it into a
 * production process.
 *
 * Migration trigger: when the first shipped headless consumer needs a real
 * machine credential (a better-auth apiKey or a PAT), the smoke moves to that
 * revocable token and this entry plus `dev-auth.ts` are deleted.
 */

import { resolveDevPrincipal } from './dev-auth.js';
import { startBunApiServer } from './server.js';

console.warn(
	'apps/api (Bun) DEV AUTH: Bearer dev:<principalId> resolves a synthetic principal on localhost. Never run this in production.',
);

await startBunApiServer({ resolveBearerPrincipal: resolveDevPrincipal });
