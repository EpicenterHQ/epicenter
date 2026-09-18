/**
 * Typed fetch client for the `/api/billing/*` surface.
 *
 * Responses come back as Epicenter DTOs from `$api/billing/contracts`
 * (sibling Worker code); the dashboard never imports `autumn-js` or sees
 * its wire shapes. Each method returns `Result<T, BillingApiError>` so
 * consumers destructure `{ data, error }` instead of try/catch.
 *
 * Each factory captures one Account's fetch for its entire lifetime.
 */

import type { Account } from '@epicenter/auth';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
import type {
	BillingEventsPage,
	BillingOverview,
	BillingPlansView,
	CheckoutResult,
	EventsQuery,
	PlanChangePreview,
	PortalSession,
	UsageQuery,
	UsageSeries,
} from '../../../../worker/billing/contracts.js';
import { BillingError } from '../../../../worker/billing/errors.js';

/** Tagged error for the billing API boundary, split by what actually failed. */
export const BillingApiError = defineErrors({
	/** No response we could read: `fetch` threw (offline, DNS, CORS) or the OK
	 *  body failed to parse. `cause` is the genuine thrown value. */
	RequestFailed: ({
		endpoint,
		cause,
	}: {
		endpoint: string;
		cause: unknown;
	}) => ({
		message: `Request to ${endpoint} failed: ${extractErrorMessage(cause)}`,
		endpoint,
		cause,
	}),
	/** The request completed with a non-OK status that is not the billing
	 *  routes' structured 503. The status is known, so we carry it as typed
	 *  data rather than fabricating an Error to feed a message extractor. */
	UnexpectedStatus: ({
		endpoint,
		status,
		statusText,
	}: {
		endpoint: string;
		status: number;
		statusText: string;
	}) => ({
		message: `Request to ${endpoint} returned ${status} ${statusText}.`,
		endpoint,
		status,
		statusText,
	}),
});
export type BillingApiError = import('wellcrafted/error').InferErrors<
	typeof BillingApiError
>;

/** Either boundary error: a local fetch/parse failure or the server's own
 *  structured billing error. */
type BillingResult<T> = Result<T, BillingApiError | BillingError>;

/**
 * Interpret a billing response. The wire contract is the status code, not the
 * body shape: the billing routes fail closed to a fixed 503 for any provider
 * failure (every actionable billing state lives on the AI/asset surfaces with
 * its own status), so we rebuild the canonical `BillingError` from the 503
 * alone. Any other non-OK status is an unexpected boundary failure we surface
 * with its status. The body is parsed only on the OK path.
 */
async function readResponse<TResponse>(
	endpoint: string,
	res: Response,
): Promise<BillingResult<TResponse>> {
	if (!res.ok) {
		if (res.status === 503) return BillingError.ProviderRequestFailed();
		return BillingApiError.UnexpectedStatus({
			endpoint,
			status: res.status,
			statusText: res.statusText,
		});
	}

	return tryAsync({
		try: () => res.json() as Promise<TResponse>,
		catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
	});
}

export function createBillingApi(account: Account) {
	async function get<TResponse>(
		endpoint: string,
	): Promise<BillingResult<TResponse>> {
		const { data: res, error } = await tryAsync({
			try: () => account.fetch(endpoint),
			catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
		});
		if (error) return Err(error);
		return readResponse<TResponse>(endpoint, res);
	}

	async function post<TBody, TResponse>(
		endpoint: string,
		body: TBody,
	): Promise<BillingResult<TResponse>> {
		const { data: res, error } = await tryAsync({
			try: () =>
				account.fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
			catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
		});
		if (error) return Err(error);
		return readResponse<TResponse>(endpoint, res);
	}

	return {
		overview: () => get<BillingOverview>('/api/billing/overview'),

		usage: (params: UsageQuery) =>
			post<UsageQuery, UsageSeries>('/api/billing/usage', params),

		events: (params: EventsQuery = {}) =>
			post<EventsQuery, BillingEventsPage>('/api/billing/events', params),

		plans: () => get<BillingPlansView>('/api/billing/plans'),

		previewPlanChange: (params: { planId: string }) =>
			post<{ planId: string }, PlanChangePreview>(
				'/api/billing/preview',
				params,
			),

		checkoutPlan: (params: { planId: string; successUrl?: string }) =>
			post<typeof params, CheckoutResult>('/api/billing/checkout/plan', params),

		checkoutTopUp: (params: { successUrl?: string } = {}) =>
			post<typeof params, CheckoutResult>(
				'/api/billing/checkout/top-up',
				params,
			),

		portal: (returnUrl: string) =>
			get<PortalSession>(
				`/api/billing/portal?${new URLSearchParams({ returnUrl })}`,
			),
	};
}
