/**
 * Map the Epicenter catalog onto Autumn product builders.
 *
 * The atmn CLI imports the entry points here from `apps/api/autumn.config.ts`
 * and pushes them to Autumn. Every value is derived from
 * `./catalog.ts`: there is no second source of pricing truth.
 * Subscription plans become recurring `plan()` definitions;
 * the credit top-up plan becomes a one-off `addOn: true` plan whose
 * single item is `interval: 'one_off'` with a prepaid billing method.
 */

import { feature, item, type PlanItem, plan } from 'atmn';
import {
	FEATURE_IDS,
	PLAN_IDS,
	PLANS,
	type SubscriptionPlan,
} from './catalog.js';

// ---------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------

export const aiUsage = feature({
	id: FEATURE_IDS.aiUsage,
	name: 'AI Usage',
	type: 'metered',
	consumable: true,
});

export const aiCredits = feature({
	id: FEATURE_IDS.aiCredits,
	name: 'AI Credits',
	type: 'credit_system',
	creditSchema: [{ meteredFeatureId: aiUsage.id, creditCost: 1 }],
});

export const storageBytes = feature({
	id: FEATURE_IDS.storageBytes,
	name: 'Storage',
	type: 'metered',
	consumable: false,
});

// ---------------------------------------------------------------------
// Subscription plans
// ---------------------------------------------------------------------

function buildCreditsItem(p: SubscriptionPlan): PlanItem {
	if (p.credits.overage === null) {
		if (p.credits.reset === null) {
			return item({
				featureId: aiCredits.id,
				included: p.credits.grantedPerCycle,
			});
		}
		return item({
			featureId: aiCredits.id,
			included: p.credits.grantedPerCycle,
			reset: { interval: p.credits.reset },
		});
	}
	// Paid tiers: included grant + per-cycle overage price on the
	// credit wallet. Overage bills monthly even on annual plans.
	const overageInterval = p.credits.reset ?? 'month';
	if (p.rollover) {
		return item({
			featureId: aiCredits.id,
			included: p.credits.grantedPerCycle,
			price: {
				amount: p.credits.overage.priceUsd,
				billingUnits: p.credits.overage.billingUnits,
				billingMethod: p.credits.overage.method,
				interval: overageInterval,
			},
			rollover: { max: null, expiryDurationType: 'forever' },
		});
	}
	return item({
		featureId: aiCredits.id,
		included: p.credits.grantedPerCycle,
		price: {
			amount: p.credits.overage.priceUsd,
			billingUnits: p.credits.overage.billingUnits,
			billingMethod: p.credits.overage.method,
			interval: overageInterval,
		},
	});
}

function buildStorageItem(p: SubscriptionPlan): PlanItem {
	if (p.storage.overagePerGbUsd === 0) {
		return item({
			featureId: storageBytes.id,
			included: p.storage.includedBytes,
		});
	}
	return item({
		featureId: storageBytes.id,
		included: p.storage.includedBytes,
		price: {
			amount: p.storage.overagePerGbUsd,
			billingUnits: 1_000_000_000,
			billingMethod: 'usage_based',
			interval: 'month',
		},
	});
}

function subscriptionPlan(p: SubscriptionPlan) {
	return plan({
		id: p.id,
		name: p.displayName,
		// All Epicenter subscription plans share one mutual-exclusion
		// group at the Autumn level. Top-ups are add-ons (no group).
		group: 'main',
		autoEnable: p.autoEnable,
		...(p.basePrice
			? {
					price: {
						amount: p.basePrice.amountUsd,
						interval: p.basePrice.interval,
					},
				}
			: {}),
		...(p.freeTrial
			? {
					freeTrial: {
						durationLength: p.freeTrial.days,
						durationType: 'day',
						cardRequired: p.freeTrial.cardRequired,
					},
				}
			: {}),
		items: [buildCreditsItem(p), buildStorageItem(p)],
	});
}

// `as const satisfies` in catalog.ts preserves the precise `kind`
// literal on each entry, so TS already knows these are subscription
// plans / one-off plans by id.
export const free = subscriptionPlan(PLANS[PLAN_IDS.free]);
export const pro = subscriptionPlan(PLANS[PLAN_IDS.pro]);
export const ultra = subscriptionPlan(PLANS[PLAN_IDS.ultra]);
export const max = subscriptionPlan(PLANS[PLAN_IDS.max]);
export const proAnnual = subscriptionPlan(PLANS[PLAN_IDS.proAnnual]);
export const ultraAnnual = subscriptionPlan(PLANS[PLAN_IDS.ultraAnnual]);
export const maxAnnual = subscriptionPlan(PLANS[PLAN_IDS.maxAnnual]);

// ---------------------------------------------------------------------
// One-off credit top-up
// ---------------------------------------------------------------------

const topUpPlan = PLANS[PLAN_IDS.creditTopUp];

export const creditTopUp = plan({
	id: topUpPlan.id,
	name: topUpPlan.displayName,
	addOn: true,
	items: [
		item({
			featureId: aiCredits.id,
			// Lifetime grant: no reset, no recurring billing. Stripe
			// charges once per purchase via the prepaid one-off item.
			price: {
				amount: topUpPlan.priceUsd,
				billingUnits: topUpPlan.creditsPerPurchase,
				billingMethod: 'prepaid',
				interval: 'one_off',
			},
		}),
	],
});
