import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { MailConfig } from './config.ts';
import {
	type GmailLabel,
	type GmailMessage,
	GmailMessageSchema,
	type HistoryPage,
	HistoryPageSchema,
	ListLabelsResponseSchema,
	ListMessageIdsResponseSchema,
	ProfileResponseSchema,
} from './schema.ts';
import type { TokenManager, TokenManagerError } from './token-manager.js';

export const GmailApiError = defineErrors({
	Network: ({ cause }: { cause: unknown }) => ({
		message: `Network error calling the Gmail API: ${String(cause)}`,
		cause,
	}),
	Http: ({ status, body }: { status: number; body: string }) => ({
		message: `Gmail API returned ${status} (${errorReason(body) ?? 'unknown reason'}): ${body.slice(0, 500)}`,
		status,
		body,
		reason: errorReason(body),
	}),
	/** `startHistoryId` is expired or invalid; the caller must fall back to a full sync. */
	HistoryExpired: () => ({
		message:
			'Gmail history.list returned 404: startHistoryId is expired or invalid.',
	}),
	Throttled: ({
		retries,
		status,
		body,
	}: {
		retries: number;
		status: number;
		body: string;
	}) => ({
		message: `Gmail API throttled the request after ${retries} retries: ${status} (${errorReason(body) ?? 'unknown reason'}): ${body.slice(0, 500)}`,
		retries,
		status,
		body,
		reason: errorReason(body),
	}),
	InvalidResponse: ({ detail }: { detail: string }) => ({
		message: `Gmail API response was not the expected JSON shape: ${detail}`,
		detail,
	}),
});
export type GmailApiError = InferErrors<typeof GmailApiError>;

export type GmailClientError = GmailApiError | TokenManagerError;

/**
 * The public Gmail client surface. Derived from `createGmailClient` rather than
 * hand-written so the type can never drift from the factory: the returned
 * object's method signatures (and their JSDoc) are the single source of truth.
 */
export type GmailClient = ReturnType<typeof createGmailClient>;

const MAX_RETRIES = 5;
const THROTTLE_WAIT_MS = 30_000;
const RETRYABLE_403_REASONS = new Set([
	'rateLimitExceeded',
	'userRateLimitExceeded',
]);

function retryAfterMs(response: Response): number | null {
	const header = response.headers.get('retry-after');
	if (!header) return null;
	const seconds = Number(header);
	return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Best-effort scrape of Google's error-body `reason`, used to classify
 * retries and the recovery action shown by the outbox. Deliberately untyped/tolerant rather than
 * typebox-validated: a wrong-shaped or non-JSON error body should silently
 * fall through to "not retryable", never fail the request a second way.
 */
function errorReason(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as {
			error?: { errors?: { reason?: string }[] };
		};
		const reason = parsed.error?.errors?.[0]?.reason;
		return typeof reason === 'string' ? reason : null;
	} catch {
		return null;
	}
}

/**
 * Validate a parsed JSON response against its expected shape. `Value.Check`
 * is a type predicate, so `data` narrows to `Static<S>` inside the true
 * branch with no cast. The boundary-validation counterpart to `tokens.ts`'
 * `tokenSetFromGrant`, applied to every Gmail response instead of just the
 * OAuth grant.
 */
function checkedResult<S extends TSchema>(
	schema: S,
	data: unknown,
	context: string,
): Result<Static<S>, GmailApiError> {
	if (Value.Check(schema, data)) return Ok(data);
	const [first] = Value.Errors(schema, data);
	const detail = first
		? `${first.message} at ${first.instancePath || '/'}`
		: 'unexpected shape';
	return GmailApiError.InvalidResponse({ detail: `${context}: ${detail}` });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Gmail REST API client: `messages.list`/`messages.get` for full pulls,
 * `history.list` for incremental refresh, `labels.list`, and `getProfile` for
 * the pre-full-pull `historyId` baseline. Same job as `apps/local-books`'
 * `qb-client.ts`: bearer auth from the token manager, one-shot refresh on 401,
 * backoff on throttling.
 *
 * The returned methods (not a hand-written interface) define the public
 * `GmailClient` type; `test-support/check-gmail-discovery.ts` diffs the
 * methods and field paths they rely on against Gmail's live Discovery document.
 *
 * Grounded against Gmail API docs (2026-06-30/07-01):
 * - 429 and 403 `rateLimitExceeded`/`userRateLimitExceeded` back off.
 *   `dailyLimitExceeded` is a configured project quota cap, so it returns
 *   immediately along with other non-retryable 403s. Verified 2026-09-08.
 *   https://developers.google.com/gmail/api/guides/handle-errors
 * - `history.list` 404s when `startHistoryId` is expired/invalid ("typically
 *   available for at least one week and often longer"); the caller must fall
 *   back to a full sync. https://developers.google.com/gmail/api/guides/sync
 */
export function createGmailClient(deps: {
	config: MailConfig;
	tokens: TokenManager;
	log?: (message: string) => void;
}) {
	const { config, tokens } = deps;
	const log = deps.log ?? (() => {});
	const backoffMs = (attempt: number) =>
		Math.min(THROTTLE_WAIT_MS, 1000 * 2 ** attempt);

	async function requestJson<S extends TSchema>({
		schema,
		operation,
		path,
		params = {},
		method = 'GET',
		body: requestBody,
	}: {
		schema: S;
		operation: string;
		path: string;
		params?: Record<string, string>;
		method?: 'GET' | 'POST';
		body?: unknown;
	}): Promise<Result<Static<S>, GmailClientError>> {
		const url = new URL(`${config.apiBase}/gmail/v1/users/me/${path}`);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		let attempt = 0;
		let refreshed = false;

		while (true) {
			const token = await tokens.getValidAccessToken();
			if (token.error) return token;

			let response: Response;
			try {
				response = await fetch(url.toString(), {
					method,
					headers: {
						Authorization: `Bearer ${token.data}`,
						Accept: 'application/json',
						...(requestBody === undefined
							? {}
							: { 'Content-Type': 'application/json' }),
					},
					...(requestBody === undefined
						? {}
						: { body: JSON.stringify(requestBody) }),
				});
			} catch (cause) {
				if (attempt < MAX_RETRIES) {
					attempt += 1;
					await sleep(backoffMs(attempt));
					continue;
				}
				return GmailApiError.Network({ cause });
			}

			if (response.ok) {
				// Validate at the transport boundary: `schema` is required, so no
				// caller ever receives an unvalidated Gmail response. A non-object or
				// malformed body fails `Value.Check` here and surfaces as an
				// InvalidResponse, so there is no separate "is it a JSON object" guard.
				const json = await response.json().catch(() => null);
				return checkedResult(schema, json, operation);
			}

			if (response.status === 401 && !refreshed) {
				refreshed = true;
				const forced = await tokens.forceRefresh();
				if (forced.error) return forced;
				continue;
			}

			// `history.list`'s expired-cursor signal is a bare 404, distinct from
			// a throttle or a hard error; the sync engine decides to fall back to
			// FULL, not this client.
			if (response.status === 404 && path === 'history') {
				return GmailApiError.HistoryExpired();
			}

			const body = await response.text().catch(() => '');
			const retryableThrottle =
				response.status === 429 ||
				(response.status === 403 &&
					RETRYABLE_403_REASONS.has(errorReason(body) ?? ''));

			if (retryableThrottle || response.status >= 500) {
				if (attempt >= MAX_RETRIES) {
					return retryableThrottle
						? GmailApiError.Throttled({
								retries: attempt,
								status: response.status,
								body,
							})
						: GmailApiError.Http({ status: response.status, body });
				}
				attempt += 1;
				const wait = retryableThrottle
					? (retryAfterMs(response) ?? backoffMs(attempt))
					: backoffMs(attempt);
				log(
					`Gmail API ${response.status}; waiting ${wait}ms before retry ${attempt}/${MAX_RETRIES}.`,
				);
				await sleep(wait);
				continue;
			}

			return GmailApiError.Http({ status: response.status, body });
		}
	}

	return {
		/** Page through `messages.list`, returning just the message ids plus the
		 * cursor for the next page. Full content is fetched separately per id via
		 * `getMessage`; this is the id spine a FULL pull paginates. */
		async listMessageIds(
			pageToken?: string,
		): Promise<
			Result<{ ids: string[]; nextPageToken?: string }, GmailClientError>
		> {
			const { data, error } = await requestJson({
				schema: ListMessageIdsResponseSchema,
				operation: 'messages.list',
				path: 'messages',
				params: {
					includeSpamTrash: 'true',
					maxResults: String(config.pageSize),
					...(pageToken ? { pageToken } : {}),
				},
			});
			if (error) return { data: null, error };
			return Ok({
				ids: (data.messages ?? []).map((m) => m.id),
				nextPageToken: data.nextPageToken,
			});
		},

		/** Fetch one full message resource (`messages.get`, `format=full`): the
		 * headers, payload, and label state a FULL pull or an incremental upsert
		 * stores verbatim. */
		async getMessage(
			id: string,
		): Promise<Result<GmailMessage, GmailClientError>> {
			return requestJson({
				schema: GmailMessageSchema,
				operation: 'messages.get',
				path: `messages/${id}`,
				params: { format: 'full' },
			});
		},

		/** Add and remove labels on one message (`messages.modify`). Gmail returns
		 * the updated resource with its new `labelIds`, which the caller folds into
		 * the mirror. */
		async modifyMessage(
			id: string,
			body: { addLabelIds: string[]; removeLabelIds: string[] },
		): Promise<Result<GmailMessage, GmailClientError>> {
			return requestJson({
				schema: GmailMessageSchema,
				operation: 'messages.modify',
				path: `messages/${id}/modify`,
				method: 'POST',
				body,
			});
		},

		/** Move a message to Trash (`messages.trash`). Adds the `TRASH` label and
		 * drops it from `INBOX`; the returned resource carries the new `labelIds`.
		 * Needs only the `gmail.modify` scope, unlike the permanent `messages.delete`
		 * (`https://mail.google.com/`), which this client deliberately never calls. */
		async trashMessage(
			id: string,
		): Promise<Result<GmailMessage, GmailClientError>> {
			// No request body: `messages.trash` takes an empty POST, so `requestJson`
			// sends no Content-Type and Gmail returns the updated message resource.
			return requestJson({
				schema: GmailMessageSchema,
				operation: 'messages.trash',
				path: `messages/${id}/trash`,
				method: 'POST',
			});
		},

		/** Restore a message from Trash (`messages.untrash`): the inverse of
		 * `trashMessage`, and the write behind the UI's Undo. */
		async untrashMessage(
			id: string,
		): Promise<Result<GmailMessage, GmailClientError>> {
			return requestJson({
				schema: GmailMessageSchema,
				operation: 'messages.untrash',
				path: `messages/${id}/untrash`,
				method: 'POST',
			});
		},

		/** Page through `history.list` from `startHistoryId`: the change feed an
		 * incremental refresh folds. A `HistoryExpired` (bare 404) error means the
		 * cursor aged out and the caller must fall back to a FULL pull. */
		async listHistory(
			startHistoryId: string,
			pageToken?: string,
		): Promise<Result<HistoryPage, GmailClientError>> {
			return requestJson({
				schema: HistoryPageSchema,
				operation: 'history.list',
				path: 'history',
				params: {
					startHistoryId,
					...(pageToken ? { pageToken } : {}),
				},
			});
		},

		/** List every label in the mailbox (`labels.list`), used to resolve label
		 * names to ids and to mirror the label set. */
		async listLabels(): Promise<Result<GmailLabel[], GmailClientError>> {
			const { data, error } = await requestJson({
				schema: ListLabelsResponseSchema,
				operation: 'labels.list',
				path: 'labels',
			});
			if (error) return { data: null, error };
			return Ok(data.labels ?? []);
		},

		/** Current mailbox `historyId`, used as the baseline right before a full pull. */
		async getProfile(): Promise<
			Result<{ historyId: string; emailAddress?: string }, GmailClientError>
		> {
			return requestJson({
				schema: ProfileResponseSchema,
				operation: 'getProfile',
				path: 'profile',
			});
		},
	};
}
