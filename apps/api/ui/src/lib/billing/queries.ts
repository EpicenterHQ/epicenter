/**
 * TanStack Query bindings for billing data.
 *
 * Wraps `billingApi` with a centralized key namespace so an invalidate
 * on `billingKeys.all` clears every billing view in one call.
 */

import { type createQueryFactories, defineKeys } from 'wellcrafted/query';
import type { EventsQuery, UsageQuery } from '$api/billing/contracts';
import type { createBillingApi } from './api.js';

export const billingKeys = defineKeys({
	all: ['billing'],
	overview: ['billing', 'overview'],
	usage: (params: UsageQuery) => ['billing', 'usage', params] as const,
	events: (params: EventsQuery) => ['billing', 'events', params] as const,
	plans: ['billing', 'plans'],
	topUp: ['billing', 'top-up'],
	preview: ['billing', 'preview'],
	checkoutPlan: ['billing', 'checkout-plan'],
});

export function createBillingQueries(
	{ defineQuery, defineMutation }: ReturnType<typeof createQueryFactories>,
	billingApi: ReturnType<typeof createBillingApi>,
) {
	return {
		overview: defineQuery({
			queryKey: billingKeys.overview,
			refetchOnWindowFocus: 'always',
			queryFn: () => billingApi.overview(),
		}),

		usage(params: UsageQuery = {}) {
			return defineQuery({
				queryKey: billingKeys.usage(params),
				queryFn: () => billingApi.usage(params),
			});
		},

		events(params: EventsQuery = {}) {
			return defineQuery({
				queryKey: billingKeys.events(params),
				queryFn: () => billingApi.events(params),
			});
		},

		plans: defineQuery({
			queryKey: billingKeys.plans,
			queryFn: () => billingApi.plans(),
		}),

		topUp: defineMutation({
			mutationKey: billingKeys.topUp,
			mutationFn: (successUrl: string) =>
				billingApi.checkoutTopUp({ successUrl }),
		}),

		previewPlanChange: defineMutation({
			mutationKey: billingKeys.preview,
			mutationFn: (params: { planId: string }) =>
				billingApi.previewPlanChange(params),
		}),

		checkoutPlan: defineMutation({
			mutationKey: billingKeys.checkoutPlan,
			mutationFn: (params: { planId: string; successUrl?: string }) =>
				billingApi.checkoutPlan(params),
		}),
	};
}
