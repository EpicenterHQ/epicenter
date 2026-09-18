/**
 * Single source of truth for all Epicenter app URLs and ports.
 *
 * Each app declares its dev `port` and canonical production `url`. Apps
 * reachable at more than one domain add `aliases`. The canonical `url` is
 * used by Vite prod builds; `url` plus `aliases` together are included in
 * CORS and trusted origins (see {@link appOrigins}).
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
export const DASHBOARD_APP_ID = 'so.epicenter.dashboard';

export const APPS = {
	API: { port: 8787, url: PRODUCTION_API_URL },
	SH: { port: 5173, url: 'https://epicenter.sh' },
	WHISPERING: {
		port: 1420,
		url: 'https://whispering.epicenter.so',
		id: 'so.epicenter.whispering',
	},
	HONEYCRISP: {
		port: 5175,
		url: 'https://honeycrisp.epicenter.so',
		id: 'so.epicenter.honeycrisp',
	},
	VOCAB: {
		port: 8888,
		url: 'https://vocab.epicenter.so',
		id: 'so.epicenter.vocab',
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
 * validated by `isAppId` in `#app-id` and spent by `defineApp` and
 * `createHostedBrowserRedirectAuth`. A reader who met `AppId` here and grepped
 * for it found the wrong concept.
 *
 * The three application rows carry an id, so one row is everything a build needs
 * to name itself. `apps/local-mail` is deliberately absent: it has no hosted
 * origin, so it keeps its id beside its storage.
 */
export type AppKey = keyof typeof APPS;

/**
 * Dev listen port for the apps/api Bun runtime (`apps/api/server.ts`,
 * ADR-0066): the off-Cloudflare twin of the wrangler dev server on
 * {@link APPS.API.port} (8787). The two are deliberately one apart so the
 * runtime-parity smoke can run both backends at once (`apps/api/scripts/smoke.ts`
 * targets :8788 and :8787). An operator overrides it with `PORT`; this is only
 * the unset-`PORT` default. It is not an app origin (never a CORS or sign-in
 * target), so it lives beside {@link APPS} rather than as a field inside it.
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
 * Every origin an app answers on: its dev origin ({@link localUrl}) plus the
 * canonical `url` and any `aliases`. Single owner for the every-origin list
 * both CORS trusted origins and sign-in callbacks want. Only apps reachable
 * at more than one domain declare `aliases`; for everyone else this is the dev
 * origin plus the one canonical url. No app declares `aliases` today.
 */
export const appOrigins = (app: {
	port: number;
	url: string;
	aliases?: readonly string[];
}): readonly string[] => [localUrl(app), app.url, ...(app.aliases ?? [])];

/**
 * An app's production origins: its canonical `url` plus any `aliases`, without
 * the localhost dev origin. The typed parameter (with optional `aliases`) is
 * what lets `trusted-origins.ts` read `aliases` off `Object.values(APPS)`
 * without an `as` cast: the union members carry it as `readonly string[] |
 * undefined` here.
 */
export const prodOrigins = (app: {
	url: string;
	aliases?: readonly string[];
}): readonly string[] => [app.url, ...(app.aliases ?? [])];

/**
 * Default API base URL for Node consumers (CLI, daemon, tests). The constant
 * resolves to `process.env.EPICENTER_API_URL` when set, else
 * {@link PRODUCTION_API_URL}. Browsers and Workers lack `process.env`, so
 * they fall through to the production default automatically.
 */
export const EPICENTER_API_URL =
	(typeof process !== 'undefined' && process.env?.EPICENTER_API_URL) ||
	PRODUCTION_API_URL;
