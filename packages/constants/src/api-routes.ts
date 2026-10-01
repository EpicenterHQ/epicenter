/**
 * Wire URL paths and Hono route patterns for the Epicenter API.
 *
 * The shared home for API route contracts whose domain has no dedicated shared
 * package of its own: the session projection
 * and the OpenAI-compatible `/v1` inference gateways. This is not a registry of
 * every route in the repo. A route whose domain already owns a shared package
 * lives there instead, beside the protocol it belongs to.
 * These leaves live here only because their two sides (server and the client
 * SDK) share nothing else they could hang the path on.
 *
 * Each leaf exposes some of:
 *
 *   - `pattern`        Hono-style route string (`/api/.../:param{regex}`)
 *                      consumed by `subApp.get(...)` declarations and
 *                      deployment `.use(...)` / `.on(...)` mounts. Server-side.
 *   - `prefixPattern`  Wildcard variant (`/api/.../*`) for prefix-scoped
 *                      `.use(...)` middleware. A server mount helper, not a
 *                      client contract: it lives beside the bare `pattern` only
 *                      so the shared path literal stays in one place and cannot
 *                      drift from it. Present only where the surface has
 *                      subpaths the bare pattern misses; no client reads it.
 *   - `url(...)`       Builder that produces a concrete absolute URL from typed
 *                      inputs, all path parameters `encodeURIComponent`-encoded.
 *                      Client-side; the URL a client fetches is the public
 *                      contract.
 *
 * @example
 * ```ts
 * // Server route declaration
 * import { API_ROUTES } from '@epicenter/constants/api-routes';
 * const sessionApp = new Hono<Env>()
 *   .get(API_ROUTES.session.pattern, handler);
 *
 * // Deployment middleware (server-only prefixPattern)
 * app.use(API_ROUTES.ai.completions.prefixPattern, requireBearerPrincipal);
 *
 * // Client fetch (the url() output is the public contract)
 * const res = await fetch(API_ROUTES.session.url(baseURL));
 * ```
 */

const stripTrailing = (s: string) => s.replace(/\/+$/, '');

export const API_ROUTES = {
	session: {
		pattern: '/api/session',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/api/session`,
	},
	ai: {
		/**
		 * The `<origin>/v1` Connection base shared by both AI gateways. Lives at the
		 * root `/v1` (the de-facto OpenAI path) so any OpenAI-compatible client points
		 * at `<origin>/v1` and works unchanged: chat appends `/chat/completions` and
		 * STT appends `/audio/transcriptions`, so one Connection drives both. This is
		 * what the client engine and `transcribe()` are configured with; the per-gateway
		 * entries below carry only their own path + middleware scope, never a second
		 * copy of this base.
		 */
		baseUrl: (baseURL: string) => `${stripTrailing(baseURL)}/v1`,
		/**
		 * The OpenAI-compatible inference gateway (ADR-0050). `prefixPattern` is scoped
		 * to `/v1/chat/*`, not the whole `/v1/*` tree, so the chat auth + metering
		 * middleware does not also wrap the sibling `/v1/audio/transcriptions` gateway
		 * (which carries its own, different metering).
		 */
		completions: {
			pattern: '/v1/chat/completions',
			prefixPattern: '/v1/chat/*',
			url: (baseURL: string) => `${stripTrailing(baseURL)}/v1/chat/completions`,
		},
		/**
		 * The OpenAI-compatible speech-to-text gateway (ADR-0050/0056). The STT
		 * sibling of the chat gateway, on the same `ai.baseUrl` Connection base:
		 * `transcribe()` appends `/audio/transcriptions`. Scoped middleware lives
		 * under `/v1/audio/*` so its metering never crosses into chat.
		 */
		transcriptions: {
			pattern: '/v1/audio/transcriptions',
			prefixPattern: '/v1/audio/*',
			url: (baseURL: string) =>
				`${stripTrailing(baseURL)}/v1/audio/transcriptions`,
		},
	},
} as const;
// The billing prefix (`/api/billing`) lives in apps/api/worker/billing/routes.ts:
// it is hosted-only and the self-hosted single-partition instance never mounts it.
