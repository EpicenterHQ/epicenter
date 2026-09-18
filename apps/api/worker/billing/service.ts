/**
 * Billing service.
 *
 * Owns every billing domain operation in the cloud worker. Routes and
 * policies call into this service, which returns Epicenter DTOs from
 * `./contracts.ts` (dashboard reads), reservation objects for AI, or resolved
 * storage allowances. It never imports `autumn-js`: the Autumn SDK lives
 * behind `./autumn.ts`, which builds the client, wraps each round-trip in
 * `tryAutumn`, and translates provider throws into `BillingError`.
 *
 * Lifecycle: one service per request. Construct via
 * `createBillingService(env, { principalId, principalEmail })`. The service does
 * NOT cache the customer across calls; each public method makes the
 * Autumn calls it needs and returns its result.
 *
 * Two error shapes, on purpose. Dashboard reads (`getOverview`, `listPlans`,
 * `listUsage`, ...) call Autumn directly and let a provider failure THROW; the
 * single `onError` boundary in `routes.ts` turns it into the opaque 503. The
 * AI guard (`reserveAiChat`) instead wraps its Autumn calls in `tryAutumn` and
 * RETURNS `Result`, because it takes a reservation lock the policy must settle
 * (confirm or release) around the response via the after-response queue.
 *
 * Storage enforcement reads the active plan's allowance here but does not
 * write usage to Autumn. Physical usage is owned by the storage-observation
 * registry (ADR-0137), not the provider balance.
 */

import {
	MODELS_BY_ID,
	type ServableModel,
} from '@epicenter/constants/ai-providers';
import type { PrincipalId } from '@epicenter/principal';
import type { CloudEnv } from '@epicenter/server';
import type { Context } from 'hono';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { AiChatError } from './ai-chat-errors.js';
import { createAutumnClient, isNotFoundError, tryAutumn } from './autumn.js';
import {
	type CheckoutPlanId,
	FEATURE_IDS,
	FREE_TIER_MAX_CREDITS_PER_CALL,
	getPlan,
	PLAN_IDS,
	PLANS,
	type PlanId,
	TRANSCRIPTION_CREDITS_PER_MINUTE,
	VISIBLE_SUBSCRIPTION_PLAN_IDS,
} from './catalog.js';
import type {
	BillingEvent,
	BillingEventsPage,
	BillingOverview,
	BillingPlanCard,
	BillingPlansView,
	CheckoutResult,
	EventsQuery,
	PlanChangePreview,
	PortalSession,
	UsageQuery,
	UsageSeries,
} from './contracts.js';
import type { BillingError } from './errors.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Identity = {
	principalId: PrincipalId;
	/** Principal.email is always a string (Better Auth guarantee); no
	 *  null coercion needed at the boundary. */
	principalEmail: string;
};

// ---------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------

/** How long a reservation lock holds the balance before Autumn auto-releases
 *  it. If the worker dies before finalizing, the hold expires here, so a failed
 *  request never permanently consumes credits or quota. */
const LOCK_TTL_MS = 15 * 60_000;

/**
 * A held reservation taken by `reserveAiChat`. The `lockId` is captured in the
 * closure and never escapes the service: the policy commits with `confirm()`
 * on success or rolls back with `release()` on failure, so the lock action
 * can't be mispaired.
 */
type Reservation = {
	confirm(): Promise<Result<void, BillingError>>;
	release(): Promise<Result<void, BillingError>>;
};

type LockedCheck = {
	allowed: boolean;
	balance: unknown;
	reservation: Reservation;
};

/**
 * Construct a request-scoped billing service from the Hono context. The one
 * place routes and policies turn `c.var.principal` into a billing service:
 * billing is cloud-only, so `AUTUMN_SECRET_KEY` is read off this deployment's
 * own `Cloudflare.Env` (not the portable `ServerBindings`, ADR-0066) through the
 * same edge cast the runtime-port resolvers use, and a principal with no email
 * cannot be billed.
 */
export function billingServiceFor(c: Context<CloudEnv>) {
	if (c.var.principal.email === undefined) {
		throw new Error('Billing requires a principal email.');
	}
	return createBillingService(c.env as Cloudflare.Env, {
		principalId: c.var.principal.id,
		principalEmail: c.var.principal.email,
	});
}

export function createBillingService(
	env: { AUTUMN_SECRET_KEY: string },
	identity: Identity,
) {
	const autumn = createAutumnClient(env);

	// ----- AI guard -----------------------------------------------------

	/**
	 * Reserve AI credits for one chat call. On success returns a reservation the
	 * policy commits or releases around the downstream handler; on failure
	 * returns a typed reason (unknown model, free-tier ceiling, insufficient
	 * balance, or a fail-closed provider outage).
	 */
	async function reserveAiChat(input: {
		model: string;
	}): Promise<Result<Reservation, AiChatError | BillingError>> {
		// One catalog lookup yields both the price and the provider. The catalog
		// owns the model -> provider mapping, so the provider lands on the usage
		// event (the dashboard groups spend by it) without the client asserting
		// it. An unknown id is the only failure mode.
		const entry = MODELS_BY_ID[input.model as ServableModel];
		if (!entry) {
			return AiChatError.UnknownModel({ model: input.model });
		}
		const { credits, provider } = entry;

		// Resolve the active plan from a single customer fetch. A billing-provider
		// outage fails closed: entitlement cannot be verified, so deny.
		const { data: customer, error: customerError } = await tryAutumn(() =>
			loadCustomer(),
		);
		if (customerError) return Err(customerError);

		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const planId = mainSub?.planId ?? PLAN_IDS.free;

		// Free tier rejects models above the per-call ceiling.
		if (planId === PLAN_IDS.free && credits > FREE_TIER_MAX_CREDITS_PER_CALL) {
			return AiChatError.ModelRequiresPaidPlan({ model: input.model, credits });
		}

		// Reserve the credits with a lock instead of an immediate deduct: the lock
		// holds the balance (concurrent calls can't double-spend) and the returned
		// reservation commits on success or releases on a pre-stream failure. If
		// the worker dies before finalizing, Autumn auto-releases at `expiresAt`,
		// so a failed call never permanently consumes credits.
		const { data: check, error: checkError } = await reserveAiCreditsWithLock({
			credits,
			properties: { model: input.model, provider },
		});
		if (checkError) return Err(checkError);
		if (!check.allowed) {
			return AiChatError.InsufficientCredits({ balance: check.balance });
		}

		return Ok(check.reservation);
	}

	/**
	 * Cheap entitlement gate for one transcription: does the customer have at
	 * least one AI credit available? Returns the allow decision plus the current
	 * balance (for the denial payload). No lock and no reservation, because the
	 * real cost is audio duration, known only after the call: this only fails
	 * closed on an empty wallet (or a provider outage hiding the balance), and
	 * {@link trackAiTranscription} settles the actual per-minute charge after.
	 */
	async function checkAiCredits(): Promise<
		Result<{ allowed: boolean; balance: unknown }, BillingError>
	> {
		return tryAutumn(async () => {
			const check = await autumn.check({
				customerId: identity.principalId,
				featureId: FEATURE_IDS.aiUsage,
				requiredBalance: 1,
			});
			return { allowed: check.allowed, balance: check.balance };
		});
	}

	/**
	 * Settle one finished transcription: charge credits for the audio duration
	 * (per minute, rounded up, floor of one credit per successful call) and record
	 * the usage event with `model` and `provider` so the dashboard groups STT
	 * spend alongside chat (`listUsage` / `listEvents` already group by those
	 * properties). Called after the gateway answered 200, off the after-response
	 * queue. The pre-call `checkAiCredits` gate only proves the wallet is non-empty,
	 * so a bounded overspend is possible: a single long recording can settle a charge
	 * larger than the balance, and concurrent calls can each pass the gate before any
	 * usage posts (see ADR-0100).
	 *
	 * Enqueued with `async: true`: Autumn records the event and returns 202 with
	 * no `balances` in the body. SDK response validation still runs, but with no
	 * balance map there is nothing for it to reject, so this post-success path
	 * cannot throw on the null-balance drift the `autumn-js` bump also fixes.
	 * Fire-and-forget matches the settle-after contract: the user's transcription
	 * already succeeded, and a metering enqueue failure is logged at the adapter,
	 * never surfaced to the client.
	 */
	async function trackAiTranscription(input: {
		seconds: number;
		model: string;
		provider: string;
	}): Promise<Result<void, BillingError>> {
		const seconds =
			Number.isFinite(input.seconds) && input.seconds > 0 ? input.seconds : 0;
		const credits = Math.max(
			1,
			Math.ceil(seconds / 60) * TRANSCRIPTION_CREDITS_PER_MINUTE,
		);
		return tryAutumn(async () => {
			await autumn.track({
				customerId: identity.principalId,
				featureId: FEATURE_IDS.aiUsage,
				value: credits,
				async: true,
				properties: {
					model: input.model,
					provider: input.provider,
					seconds,
				},
			});
		});
	}

	// ----- Dashboard data plane -----------------------------------------

	/** Resolve the active subscription's included physical storage bytes. */
	async function getStorageIncludedBytes(): Promise<number> {
		const customer = await loadCustomer();
		const mainSubscription =
			customer.subscriptions.find((subscription) => !subscription.addOn) ??
			null;
		const planId = (mainSubscription?.planId ?? PLAN_IDS.free) as PlanId;
		const plan = getPlan(planId);
		if (!plan || plan.kind !== 'subscription') {
			throw new Error(
				`Active subscription plan '${planId}' is not in the catalog`,
			);
		}
		return plan.storage.includedBytes;
	}

	async function getOverview(): Promise<BillingOverview> {
		const customer = await loadCustomer();
		const mainSub = customer.subscriptions.find((s) => !s.addOn) ?? null;
		const planId = mainSub?.planId ?? PLAN_IDS.free;
		const catalogPlan = getPlan(planId);
		const planDisplayName =
			mainSub?.plan?.name ?? (catalogPlan ? catalogPlan.displayName : planId);

		const creditsBalance = customer.balances?.[FEATURE_IDS.aiCredits];
		const monthlyEntry = creditsBalance?.breakdown?.find(
			(e) => e.reset?.interval === 'month',
		);
		const rolloverEntry = creditsBalance?.rollovers?.[0];
		const storageBalance = customer.balances?.[FEATURE_IDS.storageBytes];
		const storageIncluded =
			catalogPlan && catalogPlan.kind === 'subscription'
				? catalogPlan.storage.includedBytes
				: 0;

		const trial =
			mainSub?.trialEndsAt != null
				? {
						endsAtMs: mainSub.trialEndsAt,
						daysLeft: Math.max(
							0,
							Math.ceil((mainSub.trialEndsAt - Date.now()) / 86_400_000),
						),
					}
				: null;

		return {
			planDisplayName,
			trial,
			credits: {
				remaining: creditsBalance?.remaining ?? 0,
				granted: creditsBalance?.granted ?? 0,
				monthlyRemaining: monthlyEntry?.remaining ?? 0,
				rolloverRemaining: rolloverEntry?.balance ?? 0,
				nextResetAtMs: creditsBalance?.nextResetAt ?? null,
			},
			storage: {
				usedBytes: storageBalance?.usage ?? 0,
				includedBytes: storageBalance?.granted ?? storageIncluded,
			},
		};
	}

	async function listPlans(): Promise<BillingPlansView> {
		// Seed the customer (so plans.list reflects the auto-enabled free plan
		// and any active subscription), then read per-plan eligibility. Autumn
		// owns the customer's relationship to each plan; the card no longer
		// compares plan ids client-side.
		const [, autumnPlans] = await Promise.all([
			autumn.customers.getOrCreate({
				customerId: identity.principalId,
				email: identity.principalEmail,
			}),
			autumn.plans.list({ customerId: identity.principalId }),
		]);

		const eligibilityByPlanId = new Map(
			(autumnPlans.list ?? []).map(
				(p) => [p.id, p.customerEligibility] as const,
			),
		);

		function renderCard(planId: PlanId): BillingPlanCard {
			const plan = PLANS[planId];
			// Runtime guard, not a type-level proof: VISIBLE_SUBSCRIPTION_PLAN_IDS
			// is hand-maintained, so nothing in the type system stops the top-up
			// id from being added there. This throw catches that mistake.
			if (plan.kind !== 'subscription') {
				throw new Error(`Plan ${planId} is not a subscription plan`);
			}
			const price = plan.basePrice;
			const displayedPrice = price
				? `$${price.amountUsd.toLocaleString()}/${
						price.interval === 'month' ? 'mo' : 'yr'
					}`
				: 'Free';
			const displayedPricePerMonth =
				price && price.interval === 'year'
					? `$${Math.round(price.amountUsd / 12)}/mo`
					: displayedPrice;

			const displayedCreditsPerCycle = `${plan.credits.grantedPerCycle.toLocaleString()} credits/mo`;
			const displayedOverage = plan.credits.overage
				? `$${formatUsd(plan.credits.overage.priceUsd)}/${plan.credits.overage.billingUnits} overage`
				: null;

			const eligibility = eligibilityByPlanId.get(planId);

			return {
				id: plan.id,
				displayName: plan.displayName.replace(' (Annual)', ''),
				displayedPrice,
				displayedPricePerMonth,
				displayedCreditsPerCycle,
				displayedOverage,
				rollover: plan.rollover,
				isRecommended: plan.isRecommended,
				cta: resolveCta(eligibility?.attachAction, eligibility?.status),
				isTrialing: eligibility?.trialing ?? false,
			};
		}

		const topUp = PLANS[PLAN_IDS.creditTopUp];

		return {
			cards: {
				monthly: VISIBLE_SUBSCRIPTION_PLAN_IDS.monthly.map(renderCard),
				annual: VISIBLE_SUBSCRIPTION_PLAN_IDS.annual.map(renderCard),
			},
			topUp: {
				creditsPerPurchase: topUp.creditsPerPurchase,
				priceUsd: topUp.priceUsd,
			},
		};
	}

	async function listUsage(query: UsageQuery): Promise<UsageSeries> {
		const result = await autumn.events.aggregate({
			customerId: identity.principalId,
			featureId: FEATURE_IDS.aiUsage,
			range: query.range,
			binSize: query.binSize,
			groupBy:
				query.groupBy === 'model'
					? 'properties.model'
					: query.groupBy === 'provider'
						? 'properties.provider'
						: undefined,
			maxGroups: query.maxGroups,
		});

		const total = result.total?.[FEATURE_IDS.aiUsage];
		return {
			totalCredits: total?.sum ?? 0,
			totalCalls: total?.count ?? 0,
			buckets: (result.list ?? []).map((period) => ({
				periodIso: new Date(period.period).toISOString(),
				groupedCredits: period.groupedValues?.[FEATURE_IDS.aiUsage] ?? {},
			})),
		};
	}

	async function listEvents(query: EventsQuery): Promise<BillingEventsPage> {
		const result = await autumn.events.list({
			customerId: identity.principalId,
			featureId: FEATURE_IDS.aiUsage,
			limit: query.limit,
		});

		const events: BillingEvent[] = (result.list ?? []).map((e) => {
			const props = (e.properties ?? {}) as Record<string, unknown>;
			return {
				id: e.id,
				timestampMs: e.timestamp,
				// Both are best-effort historical ids read off the persisted Autumn
				// event, not validated against the live catalog: an id this deploy
				// no longer serves (or does not yet know) still renders, resolved to
				// a label at the dashboard edge. Missing metadata (refunds, older
				// provider-less events) is null.
				model: typeof props.model === 'string' ? props.model : null,
				provider: typeof props.provider === 'string' ? props.provider : null,
				credits: e.value,
			};
		});

		return { events };
	}

	async function previewPlanChange(input: {
		planId: string;
	}): Promise<PlanChangePreview> {
		const preview = await autumn.billing.previewAttach({
			customerId: identity.principalId,
			planId: input.planId,
		});
		// Autumn returns `total` in cents.
		const prorationAmountUsd = (preview.total ?? 0) / 100;
		const displayedSummary =
			prorationAmountUsd > 0
				? `You will be charged $${formatUsd(prorationAmountUsd)} today (prorated).`
				: 'No charge today. Plan changes take effect at the next renewal.';
		return { displayedSummary };
	}

	async function checkoutPlan(input: {
		planId: CheckoutPlanId;
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		// Rollover plans carry the credit wallet across the upgrade. The
		// catalog answers "is this a rollover plan" so route handlers
		// don't ship hard-coded plan-id lists.
		const target = getPlan(input.planId);
		const carry =
			target && target.kind === 'subscription' && target.rollover
				? { enabled: true, featureIds: [FEATURE_IDS.aiCredits] }
				: undefined;

		const result = await autumn.billing.attach({
			customerId: identity.principalId,
			planId: input.planId,
			successUrl: input.successUrl,
			...(carry ? { carryOverBalances: carry } : {}),
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async function checkoutTopUp(input: {
		successUrl?: string | undefined;
	}): Promise<CheckoutResult> {
		const result = await autumn.billing.attach({
			customerId: identity.principalId,
			planId: PLAN_IDS.creditTopUp,
			featureQuantities: [
				{
					featureId: FEATURE_IDS.aiCredits,
					quantity: PLANS[PLAN_IDS.creditTopUp].creditsPerPurchase,
				},
			],
			successUrl: input.successUrl,
		});
		return { checkoutUrl: result.paymentUrl };
	}

	async function openPortal(input: {
		returnUrl: string;
	}): Promise<PortalSession> {
		const result = await autumn.billing.openCustomerPortal({
			customerId: identity.principalId,
			returnUrl: input.returnUrl,
		});
		return { portalUrl: result.url };
	}

	// ----- Private helpers (closed over `autumn`/`identity`) ------------

	/**
	 * Reserve held AI credits with Autumn and hide the lock id behind the
	 * reservation. The caller maps denied access to the AI domain error.
	 */
	function reserveAiCreditsWithLock(input: {
		credits: number;
		properties: Record<string, unknown>;
	}): Promise<Result<LockedCheck, BillingError>> {
		const lockId = crypto.randomUUID();
		return tryAutumn(async () => {
			const check = await autumn.check({
				customerId: identity.principalId,
				featureId: FEATURE_IDS.aiUsage,
				requiredBalance: input.credits,
				lock: {
					lockId,
					enabled: true,
					expiresAt: Date.now() + LOCK_TTL_MS,
				},
				properties: input.properties,
			});

			return {
				allowed: check.allowed,
				balance: check.balance,
				reservation: {
					confirm: () => finalizeLock(lockId, 'confirm'),
					release: () => finalizeLock(lockId, 'release'),
				},
			};
		});
	}

	/** Finalize a held AI credit lock. */
	function finalizeLock(
		lockId: string,
		action: 'confirm' | 'release',
	): Promise<Result<void, BillingError>> {
		return tryAutumn(async () => {
			await autumn.balances.finalize({ lockId, action });
		});
	}

	/** Load Autumn customer with subscriptions + balances expanded. */
	async function loadCustomer() {
		return autumn.customers.getOrCreate({
			customerId: identity.principalId,
			email: identity.principalEmail,
			expand: ['subscriptions.plan', 'balances.feature'],
		});
	}

	/**
	 * Delete this account's Autumn customer and its Stripe counterpart during
	 * account deletion. Idempotent: a customer Autumn does not know (never
	 * created, or already removed by an earlier partial attempt) is success,
	 * so the deletion coordinator can retry across cross-system failures.
	 */
	async function deleteCustomer(): Promise<Result<void, BillingError>> {
		return tryAutumn(async () => {
			try {
				await autumn.customers.delete({
					customerId: identity.principalId,
					deleteInStripe: true,
				});
			} catch (error) {
				if (!isNotFoundError(error)) throw error;
			}
		});
	}

	return {
		reserveAiChat,
		checkAiCredits,
		trackAiTranscription,
		getStorageIncludedBytes,
		getOverview,
		listPlans,
		listUsage,
		listEvents,
		previewPlanChange,
		checkoutPlan,
		checkoutTopUp,
		openPortal,
		deleteCustomer,
	};
}

function formatUsd(amount: number): string {
	return Number.isInteger(amount) ? `${amount}` : amount.toFixed(2);
}

/**
 * Map Autumn's per-plan eligibility to a dashboard CTA. Autumn is the single
 * owner of the customer's relationship to a plan: `attachAction` says what
 * attaching would do, and the inert `none` case splits on `status` (the active
 * plan vs a scheduled change to it). `attachAction` is an open enum, so an
 * unrecognized value falls back to the generic actionable 'Switch' rather than
 * silently masquerading as 'Current'.
 */
function resolveCta(
	attachAction: string | undefined,
	status: string | undefined,
): BillingPlanCard['cta'] {
	switch (attachAction) {
		case 'none':
			return status === 'scheduled' ? 'Scheduled' : 'Current';
		case 'upgrade':
			return 'Upgrade';
		case 'downgrade':
			return 'Downgrade';
		default:
			return 'Switch';
	}
}
