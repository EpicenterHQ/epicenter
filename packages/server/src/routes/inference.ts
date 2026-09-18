/**
 * `/v1/chat/completions`: the OpenAI-compatible inference gateway (ADR-0049,
 * ADR-0050). One swappable inference server speaking the OpenAI Chat Completions
 * wire. The client agent loop ({@link createOpenAiAgentEngine}) points at this by
 * base URL; pointing it elsewhere (Ollama, OpenRouter, a self-hosted gateway) is
 * configuration, not code.
 *
 * It is a pure passthrough proxy: resolve the provider from the model catalog,
 * inject the deployment's house key, forward the body to the provider's
 * OpenAI-compatible endpoint, and stream the reply straight back, bytes
 * untouched. The client owns OpenAI-SSE normalization (ADR-0054): it accumulates
 * Gemini's index-less `tool_calls` deltas itself, because custom mode reaches a
 * provider directly and bypasses this gateway, so the gateway rewrites nothing.
 * It never executes a tool and keeps no transcript: a stateless inference turn
 * (ADR-0049).
 *
 * This is library-side and billing-agnostic. Auth and any credit
 * policy are supplied by the deployment through {@link mountInferenceApp}:
 * apps/api passes its Autumn metering policy, a self-hosted instance passes none.
 * The gateway is house-key-only: it accepts no provider
 * key in the body, so it provably never receives a user's key (ADR-0054). BYOK is
 * a custom client backend (your own URL and key), never the Epicenter gateway.
 *
 * Error convention (OpenAI shape, so the client reducer keeps its branchable
 * `error.code`): every failure answers `{ error: { message, code } }`.
 *   - 400 `UnknownModel`           the model is not in the catalog.
 *   - 400 `invalid_request`        the body is malformed.
 *   - 503 `ProviderNotConfigured`  no house key configured for the provider.
 *   - 402 `InsufficientCredits`    the deployment's metering policy (apps/api).
 *   - 401 `Unauthorized`           the deployment's auth middleware.
 *   - upstream non-2xx             the provider's own OpenAI-shaped error, with
 *                                  its status, forwarded verbatim.
 *   - 502 `upstream_unreachable`   the provider could not be reached.
 * A mid-stream provider failure arrives as an error frame inside the SSE body,
 * already in the OpenAI shape; the client surfaces it as a `run-error` chunk.
 */

import {
	type AiProvider,
	MODELS_BY_ID,
	type ServableModel,
} from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describeRoute } from 'hono-openapi';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Env } from '../types.js';

/**
 * Per-provider routing facts for the gateway: the OpenAI-compatible base URL and
 * the deployment env var holding the house key. The model catalog
 * (`MODELS_BY_ID`) owns model -> provider; this owns provider -> upstream. Kept
 * local to the gateway (ADR-0050: the provider-routing fact lives here, not in a
 * shared SDK-adapter leaf).
 */
const PROVIDER_UPSTREAM = {
	openai: {
		baseURL: 'https://api.openai.com/v1',
		houseKeyEnv: 'OPENAI_API_KEY',
	},
	gemini: {
		baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
		houseKeyEnv: 'GEMINI_API_KEY',
	},
} as const satisfies Record<
	AiProvider,
	{ baseURL: string; houseKeyEnv: 'OPENAI_API_KEY' | 'GEMINI_API_KEY' }
>;

/** Build the OpenAI error envelope every gateway failure answers with. */
function openAiError(
	message: string,
	code: string,
): { error: { message: string; code: string } } {
	return { error: { message, code } };
}

/** Clamp an upstream status to a forwardable client/server error code. */
function clampStatus(status: number): ContentfulStatusCode {
	if (status >= 400 && status <= 599) return status as ContentfulStatusCode;
	return 502;
}

/**
 * Mount the OpenAI-compatible inference gateway on a deployment's server app.
 *
 * Like the other mount primitives, it bundles the deployment's auth and any
 * deployment policies (apps/api passes its Autumn metering policy; a self-hosted
 * instance passes none). The library stays billing-agnostic; policies are opaque
 * middleware that run after auth and may short-circuit (e.g. 402) before the
 * gateway streams.
 */
export function mountInferenceApp<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		auth: MiddlewareHandler<E>;
		policies?: MiddlewareHandler<E>[];
	},
): void {
	const auth = every(opts.auth, ...(opts.policies ?? []));
	app.post(
		API_ROUTES.ai.completions.pattern,
		auth,
		describeRoute({
			description: 'OpenAI-compatible Chat Completions inference gateway',
			tags: ['ai'],
		}),
		async (c: Context<Env>) => {
			const raw = await c.req.json().catch(() => null);
			if (!raw || typeof raw !== 'object') {
				return c.json(
					openAiError('Invalid request body.', 'invalid_request'),
					400,
				);
			}
			const body = raw as Record<string, unknown>;

			const model = body.model;
			if (typeof model !== 'string' || !(model in MODELS_BY_ID)) {
				return c.json(
					openAiError(`Unknown model: ${String(model)}`, 'UnknownModel'),
					400,
				);
			}
			if (!Array.isArray(body.messages) || body.messages.length === 0) {
				return c.json(
					openAiError('messages must be a non-empty array.', 'invalid_request'),
					400,
				);
			}

			const { provider } = MODELS_BY_ID[model as ServableModel];
			const upstream = PROVIDER_UPSTREAM[provider];
			// House-key-only (ADR-0054): the gateway holds the key and never reads one
			// from the body, so it provably never receives a user's provider key.
			const apiKey = c.env[upstream.houseKeyEnv];
			if (!apiKey) {
				return c.json(
					openAiError(
						`${provider} is not configured.`,
						'ProviderNotConfigured',
					),
					503,
				);
			}

			let upstreamResponse: Response;
			try {
				upstreamResponse = await fetch(`${upstream.baseURL}/chat/completions`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(body),
					signal: c.req.raw.signal,
				});
			} catch (error) {
				return c.json(
					openAiError(extractErrorMessage(error), 'upstream_unreachable'),
					502,
				);
			}

			if (!upstreamResponse.ok || !upstreamResponse.body) {
				// OpenAI and Gemini-compat answer errors in the OpenAI shape; forward the
				// provider's body verbatim with its status when it parses, else wrap it.
				const text = await upstreamResponse.text().catch(() => '');
				const status = clampStatus(upstreamResponse.status);
				let payload: unknown;
				try {
					payload = JSON.parse(text);
				} catch {
					payload = null;
				}
				if (payload && typeof payload === 'object' && 'error' in payload) {
					return c.json(payload as Record<string, unknown>, status);
				}
				return c.json(
					openAiError(
						text || `Upstream returned ${upstreamResponse.status}.`,
						'upstream_error',
					),
					status,
				);
			}

			// Pure passthrough (ADR-0054): the client normalizes provider quirks (it
			// must, for custom backends), so the gateway forwards the stream untouched.
			return new Response(upstreamResponse.body, {
				status: 200,
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
				},
			});
		},
	);
}
