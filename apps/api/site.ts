/**
 * The hosted API's origins, dev ports and token audiences, and the app
 * origins it trusts and signs in. Vite loads `ui/vite.config.ts` in Node,
 * which imports this file, so it has no imports and no TypeScript-only
 * runtime syntax.
 */

/** The hosted API's public origin, baked into the Worker unless `API_PUBLIC_ORIGIN` overrides it. */
export const PRODUCTION_API_URL = 'https://api.epicenter.so';

/** Each site's dev port and production origin. */
export const APPS = {
	API: { port: 8787, url: PRODUCTION_API_URL },
	SH: { port: 5173, url: 'https://epicenter.sh' },
	WHISPERING: {
		port: 1420,
		url: 'https://whispering.epicenter.so',
		id: 'so.epicenter.whispering',
	},
	VOCAB: {
		port: 8888,
		url: 'https://vocab.epicenter.so',
		id: 'so.epicenter.vocab',
	},
	CAPTURE: { port: 5179, url: 'https://capture.epicenter.so' },
	TODOS: { port: 5186, url: 'https://todos.epicenter.so' },
	ZHONGWEN: {
		port: 5207,
		url: 'https://zhongwen.bradenwong.com',
		id: 'com.bradenwong.zhongwen',
	},
} as const;

/** The Bun entry's port when `PORT` is unset: one above the Worker's, so both can run at once. */
export const API_BUN_DEV_PORT = 8788;

/** A site's local dev origin, from its port. */
export const localUrl = <Port extends number>(app: { port: Port }) =>
	`http://localhost:${app.port}` as const;

/**
 * The token audiences of the deployment at `apiOrigin` (ADR-0549): the API
 * at the origin, and the folders at `<origin>/folders`, whose routes are
 * retired.
 */
export function resolveOAuthAudiences(apiOrigin: string): {
	/** Inference and transcription. */
	api: string;
	/** The retired folder routes. */
	folders: string;
} {
	const base = new URL(apiOrigin).origin;
	return { api: base, folders: `${base}/folders` };
}
