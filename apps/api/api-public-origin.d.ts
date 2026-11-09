/**
 * `API_PUBLIC_ORIGIN` is a dev-only override, not production config.
 *
 * The hosted cloud bakes `PRODUCTION_API_URL` (see worker/index.ts), so this
 * var is intentionally absent from `wrangler.jsonc` and therefore from the
 * generated `worker-configuration.d.ts`. `apps/api/scripts/dev.ts` injects it
 * for `wrangler dev` so signed cookies and the OAuth issuer match the
 * localhost host. Declared optional here so `resolveOrigin` can read it
 * without the generator clobbering the type on the next `wrangler types`.
 */
declare global {
	namespace Cloudflare {
		interface Env {
			API_PUBLIC_ORIGIN?: string;
		}
	}
}

export {};
