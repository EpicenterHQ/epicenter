/**
 * `/v1/audio/transcriptions`: the OpenAI-compatible speech-to-text gateway
 * (ADR-0050, ADR-0056). The STT sibling of the chat gateway in `inference.ts`:
 * one swappable server speaking the OpenAI `audio/transcriptions` wire, reached
 * by an App-owned OpenAI SDK client. Selecting another connection (a Speaches box, a
 * user's own key) is configuration, not code.
 *
 * It is a multipart passthrough proxy: validate the requested model against the
 * single supported upstream, inject the deployment's house key, forward the audio to
 * the provider's OpenAI-compatible endpoint, and return the transcript JSON. It
 * forces `response_format=verbose_json` upstream so the reply carries `duration`
 * (and segments, language); the shared client reads only `text`, and a
 * deployment that meters by audio length reads `duration` from the same body.
 *
 * Library-side and billing-agnostic, exactly like the chat gateway. Auth and
 * any metering policy are supplied by the deployment through
 * {@link mountTranscriptionApp}: apps/api passes its per-audio-minute Autumn
 * policy, a self-hosted instance deployment passes none. The gateway is
 * house-key-only (ADR-0054): it never reads a provider key from the request, so
 * it provably never receives a user's key. BYOK is a custom client Connection
 * (the user's own URL and key), never the Epicenter gateway.
 *
 * Error convention (OpenAI shape, mirroring the chat gateway):
 *   - 400 `UnknownModel`           the model is not the supported STT model.
 *   - 400 `invalid_request`        no audio file in the multipart body.
 *   - 503 `ProviderNotConfigured`  no house key configured for the provider.
 *   - 402 `InsufficientCredits`    the deployment's metering policy (apps/api).
 *   - 401 `Unauthorized`           the deployment's auth middleware.
 *   - upstream non-2xx             the provider's own error, forwarded with its
 *                                  status when OpenAI-shaped, else wrapped.
 *   - 502 `upstream_unreachable`   the provider could not be reached.
 */

import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { describeRoute } from 'hono-openapi';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Env } from '../types.js';

// The gateway's upstream routing stays local: it serves the shared hosted model
// over the OpenAI-compatible base, reusing the deployment's existing
// `OPENAI_API_KEY` house key (the chat gateway
// already provisions it). `whisper-1` returns `duration` under `verbose_json`,
// which the per-minute meter reads; the `gpt-4o-transcribe` models do not support
// `verbose_json`, so do not swap to them without giving the meter another
// duration source. Held as inline constants until a real second upstream exists:
// reintroduce a per-model routing table when one does, not before.
const STT_BASE_URL = 'https://api.openai.com/v1';
const STT_HOUSE_KEY_ENV = 'OPENAI_API_KEY' as const;

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
 * Mount the OpenAI-compatible speech-to-text gateway on a deployment's server
 * app. Mirrors {@link mountInferenceApp}: it bundles the deployment's auth and
 * any deployment policies (apps/api passes its
 * per-audio-minute Autumn policy; a self-hosted instance deployment passes
 * none). The library stays billing-agnostic; policies are opaque middleware that
 * run after auth and may short-circuit (e.g. 402) before the gateway proxies.
 */
export function mountTranscriptionApp<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		auth: MiddlewareHandler<E>;
		policies?: MiddlewareHandler<E>[];
	},
): void {
	const auth = every(opts.auth, ...(opts.policies ?? []));
	app.post(
		API_ROUTES.ai.transcriptions.pattern,
		auth,
		describeRoute({
			description: 'OpenAI-compatible speech-to-text gateway',
			tags: ['ai'],
		}),
		async (c: Context<Env>) => {
			const form = await c.req.formData().catch(() => null);
			if (!form) {
				return c.json(
					openAiError('Expected a multipart form body.', 'invalid_request'),
					400,
				);
			}

			const model = form.get('model');
			if (model !== HOSTED_TRANSCRIPTION_MODEL) {
				return c.json(
					openAiError(`Unknown model: ${String(model)}`, 'UnknownModel'),
					400,
				);
			}

			const file = form.get('file');
			if (!file || typeof file === 'string') {
				return c.json(
					openAiError(
						'Expected an audio file in the `file` field.',
						'invalid_request',
					),
					400,
				);
			}

			// House-key-only (ADR-0054): the gateway holds the key and never reads one
			// from the request, so it provably never receives a user's provider key.
			const apiKey = c.env[STT_HOUSE_KEY_ENV];
			if (!apiKey) {
				return c.json(
					openAiError(`${model} is not configured.`, 'ProviderNotConfigured'),
					503,
				);
			}

			// Rebuild the upstream form: the audio, the upstream model id, and
			// `verbose_json` so the reply carries `duration` for a metering policy. The
			// optional `language` / `prompt` hints pass through; everything else (a
			// client-supplied `response_format`, stray fields) is dropped on purpose.
			const upstreamForm = new FormData();
			upstreamForm.append('file', file);
			upstreamForm.append('model', HOSTED_TRANSCRIPTION_MODEL);
			upstreamForm.append('response_format', 'verbose_json');
			const language = form.get('language');
			if (typeof language === 'string')
				upstreamForm.append('language', language);
			const prompt = form.get('prompt');
			if (typeof prompt === 'string') upstreamForm.append('prompt', prompt);

			let upstreamResponse: Response;
			try {
				upstreamResponse = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
					method: 'POST',
					// No content-type: `fetch` sets the multipart boundary itself.
					headers: { authorization: `Bearer ${apiKey}` },
					body: upstreamForm,
					signal: c.req.raw.signal,
				});
			} catch (error) {
				return c.json(
					openAiError(extractErrorMessage(error), 'upstream_unreachable'),
					502,
				);
			}

			const text = await upstreamResponse.text().catch(() => '');
			if (!upstreamResponse.ok) {
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

			// Forward the verbose_json transcript verbatim (buffered, not streamed): the
			// body is small, and a buffered JSON response is what a metering policy
			// clones to read `duration`. The client reads only `text`.
			return c.body(text, 200, { 'content-type': 'application/json' });
		},
	);
}
