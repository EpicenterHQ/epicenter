/**
 * Canonical Epicenter billing catalog.
 *
 * One source of truth for every feature, plan, and pricing knob that
 * ships to production. The atmn product builder in
 * `apps/api/autumn.config.ts` reads this catalog and emits Autumn
 * `feature()` / `plan()` / `item()` calls; the billing service in
 * `apps/api/worker/billing/service.ts` reads the same catalog to resolve
 * plan tier semantics (rollover policy, free-tier model-cost ceiling,
 * upgrade-UI recommendation flag); the dashboard reads it through the
 * server-rendered DTOs from `contracts.ts`. Nothing else in the repo
 * holds plan or feature configuration.
 *
 * IDs in `FEATURE_IDS` and `PLAN_IDS` are durable: they appear in
 * Autumn customer subscriptions, Stripe webhooks, and historical events.
 * Renaming requires a coordinated migration. Adding new ids is safe.
 *
 * Pricing knobs (`included`, `overage.amount`, `storage.includedBytes`,
 * etc.) can change freely; they affect the next atmn push.
 */
export const FEATURE_IDS = {
	/** Per-request usage units (one entry per AI chat call). */
	aiUsage: 'ai_usage',
	/** Credit wallet that wraps `ai_usage` 1:1; what users see and buy. */
	aiCredits: 'ai_credits',
	/** Accumulator (non-consumable) feature tracking total stored bytes. */
	storageBytes: 'storage_bytes',
} as const;

export const PLAN_IDS = {
	free: 'free',
	pro: 'pro',
	ultra: 'ultra',
	max: 'max',
	creditTopUp: 'credit_top_up',
	proAnnual: 'pro_annual',
	ultraAnnual: 'ultra_annual',
	maxAnnual: 'max_annual',
} as const;

export type PlanId = (typeof PLAN_IDS)[keyof typeof PLAN_IDS];

/** Per-cycle credit grant + overage pricing. Free plan: no overage. */
type CreditPolicy =
	| {
			/** Credits granted at the start of each cycle. */
			grantedPerCycle: number;
			/** When credits reset. `null` for one-off lifetime grants. */
			reset: 'month' | null;
			/** Overage price. Null on plans where overage is not sold. */
			overage: null;
	  }
	| {
			grantedPerCycle: number;
			reset: 'month' | null;
			overage: {
				/** USD price per `billingUnits` overage credits. */
				priceUsd: number;
				billingUnits: number;
				method: 'usage_based' | 'prepaid';
			};
	  };

/** Per-cycle storage grant + per-GB overage pricing. */
type StoragePolicy = {
	includedBytes: number;
	overagePerGbUsd: number;
};

/** Plan attached via Stripe checkout. */
export type SubscriptionPlan = {
	id: PlanId;
	kind: 'subscription';
	displayName: string;
	cycle: 'monthly' | 'annual';
	/** True if this plan rolls over unused credits and the cloud should
	 *  carry over balances on upgrade. */
	rollover: boolean;
	/** Marked with a "Recommended" badge on the upgrade UI. */
	isRecommended: boolean;
	/** Auto-enable on customer creation (Autumn-side default for free). */
	autoEnable: boolean;
	/** Base price, billed on `cycle`. Free plan: null. */
	basePrice: { amountUsd: number; interval: 'month' | 'year' } | null;
	/** Free trial offered at attach time. */
	freeTrial: { days: number; cardRequired: boolean } | null;
	credits: CreditPolicy;
	storage: StoragePolicy;
};

/** One-off top-up plan. Attaches a prepaid bag of credits with no
 *  recurring price and no reset. Part of the `Plan` union; not imported by
 *  name elsewhere, so it stays module-private. */
type OneOffTopUpPlan = {
	id: PlanId;
	kind: 'oneOffTopUp';
	displayName: string;
	/** Number of credits granted per purchase. */
	creditsPerPurchase: number;
	/** USD price per purchase. */
	priceUsd: number;
};

export type Plan = SubscriptionPlan | OneOffTopUpPlan;

/** Cap on the per-call credit cost that the free tier may consume.
 *  Compared against the model's catalog `credits` at request time. */
export const FREE_TIER_MAX_CREDITS_PER_CALL = 2;

/** Credits charged per minute of transcribed audio, rounded up per call with a
 *  floor of one credit, so a two-second clip costs 1 and a 5m30s clip costs 6.
 *  A convenience rate with wide margin over the cloud STT cost; the free tier's
 *  monthly grant covers roughly this many minutes before a top-up is needed. */
export const TRANSCRIPTION_CREDITS_PER_MINUTE = 1;

export const PLANS = {
	[PLAN_IDS.free]: {
		id: PLAN_IDS.free,
		kind: 'subscription',
		displayName: 'Free',
		cycle: 'monthly',
		rollover: false,
		isRecommended: false,
		autoEnable: true,
		basePrice: null,
		freeTrial: null,
		credits: { grantedPerCycle: 50, reset: 'month', overage: null },
		// Permanent no-card hosted storage (ADR-0137): included bytes are
		// mutable catalog data, never an ADR constant. Scalar V1 does not yet
		// enforce this account-lifetime allowance.
		storage: { includedBytes: 100_000_000, overagePerGbUsd: 0 },
	},
	[PLAN_IDS.pro]: {
		id: PLAN_IDS.pro,
		kind: 'subscription',
		displayName: 'Pro',
		cycle: 'monthly',
		rollover: false,
		isRecommended: false,
		autoEnable: false,
		basePrice: { amountUsd: 20, interval: 'month' },
		freeTrial: null,
		credits: {
			grantedPerCycle: 2500,
			reset: 'month',
			overage: { priceUsd: 1, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 5_000_000_000, overagePerGbUsd: 1 },
	},
	[PLAN_IDS.ultra]: {
		id: PLAN_IDS.ultra,
		kind: 'subscription',
		displayName: 'Ultra',
		cycle: 'monthly',
		rollover: true,
		isRecommended: true,
		autoEnable: false,
		basePrice: { amountUsd: 60, interval: 'month' },
		freeTrial: { days: 14, cardRequired: false },
		credits: {
			grantedPerCycle: 10_000,
			reset: 'month',
			overage: { priceUsd: 0.75, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 10_000_000_000, overagePerGbUsd: 0.75 },
	},
	[PLAN_IDS.max]: {
		id: PLAN_IDS.max,
		kind: 'subscription',
		displayName: 'Max',
		cycle: 'monthly',
		rollover: true,
		isRecommended: false,
		autoEnable: false,
		basePrice: { amountUsd: 200, interval: 'month' },
		freeTrial: null,
		credits: {
			grantedPerCycle: 50_000,
			reset: 'month',
			overage: { priceUsd: 0.5, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 50_000_000_000, overagePerGbUsd: 0.5 },
	},
	[PLAN_IDS.proAnnual]: {
		id: PLAN_IDS.proAnnual,
		kind: 'subscription',
		displayName: 'Pro (Annual)',
		cycle: 'annual',
		rollover: false,
		isRecommended: false,
		autoEnable: false,
		basePrice: { amountUsd: 200, interval: 'year' },
		freeTrial: null,
		credits: {
			grantedPerCycle: 2500,
			reset: 'month',
			overage: { priceUsd: 1, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 5_000_000_000, overagePerGbUsd: 1 },
	},
	[PLAN_IDS.ultraAnnual]: {
		id: PLAN_IDS.ultraAnnual,
		kind: 'subscription',
		displayName: 'Ultra (Annual)',
		cycle: 'annual',
		rollover: true,
		isRecommended: true,
		autoEnable: false,
		basePrice: { amountUsd: 600, interval: 'year' },
		freeTrial: null,
		credits: {
			grantedPerCycle: 10_000,
			reset: 'month',
			overage: { priceUsd: 0.75, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 10_000_000_000, overagePerGbUsd: 0.75 },
	},
	[PLAN_IDS.maxAnnual]: {
		id: PLAN_IDS.maxAnnual,
		kind: 'subscription',
		displayName: 'Max (Annual)',
		cycle: 'annual',
		rollover: true,
		isRecommended: false,
		autoEnable: false,
		basePrice: { amountUsd: 2000, interval: 'year' },
		freeTrial: null,
		credits: {
			grantedPerCycle: 50_000,
			reset: 'month',
			overage: { priceUsd: 0.5, billingUnits: 100, method: 'usage_based' },
		},
		storage: { includedBytes: 50_000_000_000, overagePerGbUsd: 0.5 },
	},
	[PLAN_IDS.creditTopUp]: {
		id: PLAN_IDS.creditTopUp,
		kind: 'oneOffTopUp',
		displayName: 'Credit Top-Up',
		creditsPerPurchase: 500,
		priceUsd: 5,
	},
} as const satisfies Record<PlanId, Plan>;

/** Ordered list of subscription plans shown on the Upgrade UI.
 *  Free is intentionally excluded; it is the no-op fallback, not a
 *  card the user picks. */
export const VISIBLE_SUBSCRIPTION_PLAN_IDS = {
	monthly: [PLAN_IDS.pro, PLAN_IDS.ultra, PLAN_IDS.max],
	annual: [PLAN_IDS.proAnnual, PLAN_IDS.ultraAnnual, PLAN_IDS.maxAnnual],
} as const;

/** Plan ids a customer may attach through `/api/billing/checkout/plan`: the
 *  flat union of every visible subscription card. The checkout route validates
 *  its `planId` against this list, so the auto-enable free plan, the top-up
 *  add-on, and retired ids can never be attached through the subscription
 *  endpoint. Single source: derived from the visible cards, never hand-listed. */
export const CHECKOUT_PLAN_IDS = [
	...VISIBLE_SUBSCRIPTION_PLAN_IDS.monthly,
	...VISIBLE_SUBSCRIPTION_PLAN_IDS.annual,
] as const;

export type CheckoutPlanId = (typeof CHECKOUT_PLAN_IDS)[number];

/** Resolve a Plan by id. Returns undefined for unknown ids
 *  (e.g. legacy plans that have been retired). */
export function getPlan(id: string): Plan | undefined {
	return (PLANS as Record<string, Plan>)[id];
}
