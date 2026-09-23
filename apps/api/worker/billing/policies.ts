/**
 * Cloud-only deployment policies that wrap `@epicenter/server` mount
 * primitives with Autumn-backed billing.
 *
 * Each policy is a thin shell around the billing service. The service owns
 * the Autumn round-trips and the AI reservation lock (the `lockId` never
 * leaves it); policies own only HTTP shape: pulling fields off the request,
 * forwarding the guard's typed error to `c.json`, and pushing after-response
 * settlement/sync work onto the queue from `@epicenter/server`. Those ops
 * return a `Result` (they never reject) and the adapter logs any provider
 * failure at its source, so a failed finalize is recorded
 * rather than silently swallowed by the queue's `Promise.allSettled`, with no
 * separate settlement wrapper needed.
 *
 *   chargeOpenAiCreditsWithAutumn  Around `/v1/chat/completions` (the
 *                                  OpenAI-compatible gateway). Reserves credits
 *                                  (a lock) before the call, then confirms on
 *                                  success or releases on a pre-stream failure.
 *                                  The gateway is house-key-only, so every call
 *                                  is metered (ADR-0054): no BYOK bypass.
 *
 *   chargeOpenAiTranscriptionCredits  Around `/v1/audio/transcriptions` (the STT
 *                                  gateway). Meters by audio duration: a cheap
 *                                  pre-gate denies an empty wallet, then on a 200
 *                                  the per-minute charge is tracked from the
 *                                  returned `duration`. Settle-after, so the cost
 *                                  is known (no reservation lock). House-key-only.
 *
 * AI reservations use Autumn's lock + `balances.finalize` rather than
 * deduct-then-refund: if the worker dies before finalizing, Autumn
 * auto-releases the hold at its TTL, so a failed request can never silently
 * overcharge. When the provider is unreachable the guard returns a structured
 * `BillingError` (fail closed), so the surface answers with a billing envelope
 * instead of a naked 500.
 *
 * The opaque-id blob store is unmetered in v1 (no storage policy here):
 * Autumn `check()` denies by default with no plan attached, so deferred quota
 * means not calling it. When blob storage is billed (deleted spec
 * 20260623T220000 decision 10, recoverable via git history; kernel is
 * ADR-0089), a `syncBlobStorageWithAutumn` policy lands here together with the
 * Hosted blob billing needs a policy seam on the authority route.
 *
 * The library remains billing-agnostic; everything here is cloud-only.
 */

import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/constants/ai-providers';
import type { CloudEnv } from '@epicenter/server';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AiChatError, AiChatErrorStatus } from './ai-chat-errors.js';
import type { BillingError } from './errors.js';
import { billingServiceFor } from './service.js';

/**
 * Around `/v1/chat/completions` (the OpenAI-compatible gateway, the only metered
 * inference path). A fixed-per-model reservation: reserve a credit lock before
 * the call, confirm on success or release on a pre-stream failure (>= 400). Once
 * the SSE stream starts the status is already 200, so a mid-stream provider
 * failure commits by design (those provider tokens were consumed and are
 * non-refundable); a failed finalize is logged at the adapter and self-heals via
 * the lock TTL. The model is read from the OpenAI body shape (top-level `model`)
 * and a guard failure answers in the OpenAI error shape
 * (`{ error: { message, code } }`) so the client engine keeps its branchable
 * `error.code`. The gateway is house-key-only (ADR-0054), so every call is
 * metered; there is no BYOK bypass.
 */
export const chargeOpenAiCreditsWithAutumn = createMiddleware<CloudEnv>(
	async (c, next) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			model?: string;
		};

		const billing = billingServiceFor(c);
		const { data: reservation, error: guardError } =
			await billing.reserveAiChat({ model: body.model ?? '' });
		if (guardError) {
			return c.json(toOpenAiError(guardError), aiGuardStatus(guardError));
		}

		await next();

		c.var.afterResponseQueue.push(
			c.res.status >= 400 ? reservation.release() : reservation.confirm(),
		);
	},
);

// The gateway pins one upstream provider. Never trust request fields as billing metadata.
const HOSTED_STT_PROVIDER = 'openai';

/**
 * Around `/v1/audio/transcriptions` (the OpenAI-compatible STT gateway). Meters
 * by audio duration, settled after the call: a cheap pre-gate denies the request
 * when the wallet is empty (fail closed, answered in the OpenAI error shape so
 * the client keeps a branchable `error.code`), then on a 200 the actual
 * per-minute charge is tracked off the after-response queue from the `duration`
 * the gateway returns. No reservation lock, because the cost is unknown until the
 * call returns; the charge settles after the call, so concurrent requests can each
 * pass the gate before any usage posts. Overspend is bounded by both the largest
 * single call (a long recording can over-tip a near-empty wallet on its own) and
 * the number of in-flight calls; the deferred remedy is an input duration ceiling,
 * not a reservation lock (see ADR-0100). House-key-only (ADR-0054): every call is
 * metered, no BYOK bypass.
 */
export const chargeOpenAiTranscriptionCredits = createMiddleware<CloudEnv>(
	async (c, next) => {
		const billing = billingServiceFor(c);

		const { data: gate, error: gateError } = await billing.checkAiCredits();
		if (gateError) {
			return c.json(toOpenAiError(gateError), aiGuardStatus(gateError));
		}
		if (!gate.allowed) {
			const { error: denial } = AiChatError.InsufficientCredits({
				balance: gate.balance,
			});
			return c.json(toOpenAiError(denial), aiGuardStatus(denial));
		}

		await next();

		if (c.res.status !== 200) return;
		const seconds = await readTranscriptionSeconds(c.res);
		c.var.afterResponseQueue.push(
			billing.trackAiTranscription({
				seconds,
				model: HOSTED_TRANSCRIPTION_MODEL,
				provider: HOSTED_STT_PROVIDER,
			}),
		);
	},
);

/**
 * Read the audio `duration` (seconds) off the gateway's verbose_json response
 * without disturbing the body streamed to the client (clone + parse, best
 * effort). Missing or malformed duration yields 0, which the service floors to a
 * one-credit charge for the otherwise successful call.
 */
async function readTranscriptionSeconds(res: Response): Promise<number> {
	const body = await res
		.clone()
		.json()
		.catch(() => null);
	if (body && typeof body === 'object' && 'duration' in body) {
		const { duration } = body as { duration: unknown };
		if (typeof duration === 'number') return duration;
	}
	return 0;
}

/**
 * Render a guard failure as the OpenAI error envelope. The variant `name`
 * (`InsufficientCredits`, `ModelRequiresPaidPlan`, ...) becomes `error.code`, so
 * the client reducer can branch on a stable code rather than a message string.
 */
function toOpenAiError(error: AiChatError | BillingError): {
	error: { message: string; code: string };
} {
	return { error: { message: error.message, code: error.name } };
}

/**
 * Resolve the HTTP status for an AI guard failure. A `BillingError` means the
 * provider call failed and we fail closed, so it answers with a fixed 503
 * (entitlement unverifiable -> service unavailable); the actionable
 * `AiChatError` variants map through the sibling status table. 503 is a trusted
 * literal, so no cast on an untrusted provider value.
 */
function aiGuardStatus(
	error: AiChatError | BillingError,
): ContentfulStatusCode {
	if (error.name === 'ProviderRequestFailed') return 503;
	return AiChatErrorStatus[error.name];
}
