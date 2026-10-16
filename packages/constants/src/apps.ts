/**
 * Single source of truth for all Epicenter app URLs and ports.
 *
 * Each app declares its dev `port` and its one production `url`. Vite prod
 * builds, trusted origins, and sign-in callbacks all read `url`; the dev
 * origin is derived from `port` by {@link localUrl}.
 *
 * To add an app: add an entry here. TypeScript enforces that every
 * consumer picks it up automatically.
 */

/**
 * Canonical production origin for the Epicenter API. Single source of truth
 * for the hosted cloud's public origin: the `API` entry below, the fallback
 * for {@link EPICENTER_API_URL}, and the baked default the hosted worker uses
 * when no `API_PUBLIC_ORIGIN` override is present (apps/api/worker/index.ts).
 * The hosted origin never changes per deploy, so it lives here in TypeScript
 * rather than being duplicated into apps/api's wrangler.jsonc vars.
 *
 * The dashboard SPA is served at `api.epicenter.so/dashboard` (same origin as
 * the API) so it does not get its own APPS entry; its dev port lives inline in
 * `apps/api/ui/vite.config.ts`.
 */
export const PRODUCTION_API_URL = 'https://api.epicenter.so';

export const APPS = {
	API: { port: 8787, url: PRODUCTION_API_URL },
	SH: { port: 5173, url: 'https://epicenter.sh' },
	WHISPERING: {
		port: 1420,
		url: 'https://whispering.epicenter.so',
	},
	HONEYCRISP: {
		port: 5175,
		url: 'https://honeycrisp.epicenter.so',
	},
	VOCAB: {
		port: 8888,
		url: 'https://vocab.epicenter.so',
		id: 'so.epicenter.vocab',
	},
	CAPTURE: {
		port: 5179,
		url: 'https://capture.epicenter.so',
	},
	TODOS: {
		port: 5186,
		url: 'https://todos.epicenter.so',
	},
	ZHONGWEN: {
		port: 5207,
		url: 'https://zhongwen.bradenwong.com',
		id: 'com.bradenwong.zhongwen',
	},
} as const;

/**
 * A key into {@link APPS}, which is not an app id.
 *
 * `AppKey` rather than `AppId`, because the two name different things and the
 * old name claimed the wrong one. These are catalog keys, and two of them are
 * not applications with an id at all: `API` is the hosted server and `SH` is the
 * marketing site, so neither carries `id`. An app id is the
 * reverse-domain string an application stores under (`so.epicenter.vocab`),
 * validated by `isAppId` in `@epicenter/constants/app-id` and spent by
 * `appDataDir` as the app's data directory and by `createBrowserOAuth` as the
 * app's OAuth client id. A reader who met `AppId` here and grepped for it
 * found the wrong concept.
 *
 * A row carries an id only for an app that names itself from it. An installed
 * app (Todos, Capture, Whispering, Honeycrisp) reads its id from its own
 * `epicenter.app.json` instead (ADR-0560).
 */
export type AppKey = keyof typeof APPS;

/**
 * Dev listen port for the apps/api Bun runtime (`apps/api/server.ts`,
 * ADR-0066): the off-Cloudflare twin of the wrangler dev server on
 * {@link APPS.API.port} (8787), one apart so both can run at once. An
 * operator overrides it with `PORT`; this is only the unset-`PORT` default.
 * It is not an app origin (never a CORS or sign-in target), so it lives
 * beside {@link APPS} rather than as a field inside it.
 */
export const API_BUN_DEV_PORT = 8788;

/**
 * Local dev URL for an app, derived from its `port`. Single owner for the
 * `http://localhost:<port>` shape: the dev-server origin override, approved
 * sign-in callbacks, the Vite dev build, and the CSRF test all read this.
 *
 * The `Port` generic preserves the literal port through the template so
 * `localUrl(APPS.API)` infers `"http://localhost:8787"`, not `string`.
 * Consumers that hand the result to Better Auth (e.g. `trustedOrigins`)
 * widen to `string` at that boundary on purpose; see
 * `packages/server/src/trusted-origins.ts`.
 */
export const localUrl = <Port extends number>(app: { port: Port }) =>
	`http://localhost:${app.port}` as const;

/**
 * Default API base URL for Node consumers (CLI, daemon, tests). The constant
 * resolves to `process.env.EPICENTER_API_URL` when set, else
 * {@link PRODUCTION_API_URL}. Browsers and Workers lack `process.env`, so
 * they fall through to the production default automatically.
 */
export const EPICENTER_API_URL =
	(typeof process !== 'undefined' && process.env?.EPICENTER_API_URL) ||
	PRODUCTION_API_URL;

/**
 * The token audiences of the deployment at `apiOrigin` (ADR-0549): the
 * resource identifiers its authorization server issues access tokens for.
 * The deployment names the authority (ADR-0326). The hosted cloud's are
 * `api` and `git.epicenter.so`; any other deployment (local dev, self-host)
 * serves both from its own origin, Git at `/git`. The API seeds and checks
 * these; the `epicenter` CLI requests and presents them, and its Git
 * credential helper answers for the `git` one.
 */
export function resolveOAuthAudiences(apiOrigin: string): {
	/** Inference and transcription. */
	api: string;
	/** Git smart HTTP and LFS. */
	git: string;
} {
	const base = new URL(apiOrigin).origin;
	if (base === PRODUCTION_API_URL)
		return {
			api: PRODUCTION_API_URL,
			git: 'https://git.epicenter.so',
		};
	return { api: base, git: `${base}/git` };
}
