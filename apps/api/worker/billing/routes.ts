/**
 * `/api/billing/*` routes for the dashboard.
 *
 * Every handler is a one-line delegate to the billing service. The
 * service owns Autumn round-trips and DTO mapping; routes own HTTP
 * shape, body validation, and the Autumn-error translation layer.
 * Auth is bundled into {@link mountBillingApi} so the data plane can't
 * be mounted without it.
 */

import type { CloudEnv } from '@epicenter/server';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono, type MiddlewareHandler } from 'hono';
import { isProviderError, mapAutumnError } from './autumn.js';
import { CHECKOUT_PLAN_IDS } from './catalog.js';
import { eventsQuerySchema, usageQuerySchema } from './contracts.js';
import { billingServiceFor } from './service.js';

/** Hosted-only URL prefix; the feature owns its routes and error handler. */
const BILLING_PREFIX = '/api/billing';

/**
 * Mount the cloud billing data plane on the server app.
 *
 * Bundles session-bearer auth and the route mount into one
 * call. Lives in apps/api, not @epicenter/server, because Autumn is
 * cloud-only deployment policy.
 */
export function mountBillingApi(
	app: Hono<CloudEnv>,
	opts: { auth: MiddlewareHandler<CloudEnv> },
): void {
	const billingRoutes = new Hono<CloudEnv>();

	// A thrown provider failure becomes the opaque billing envelope at a fixed 503
	// (data unverifiable -> service unavailable). `isProviderError` covers both an
	// HTTP non-2xx (AutumnError) and a network/transport failure (HTTPClientError),
	// so an unreachable provider on a dashboard read fails closed to 503, the same
	// as the guard path. Anything that is NOT a provider failure (a programming bug
	// in a handler) rethrows to the parent app's default handler for a real 500,
	// rather than masquerading as "provider unreachable." mapAutumnError logs the
	// full original error for operators before reducing it.
	billingRoutes.onError((err, c) => {
		if (!isProviderError(err)) throw err;
		return c.json(mapAutumnError(err), 503);
	});

	const previewPlanSchema = type({ planId: 'string' });

	const checkoutPlanSchema = type({
		planId: type.enumerated(...CHECKOUT_PLAN_IDS),
		'successUrl?': 'string | undefined',
	});

	const checkoutTopUpSchema = type({
		'successUrl?': 'string | undefined',
	});

	billingRoutes.get('/overview', opts.auth, async (c) =>
		c.json(await billingServiceFor(c).getOverview()),
	);

	billingRoutes.post(
		'/usage',
		opts.auth,
		sValidator('json', usageQuerySchema),
		async (c) =>
			c.json(await billingServiceFor(c).listUsage(c.req.valid('json'))),
	);

	billingRoutes.post(
		'/events',
		opts.auth,
		sValidator('json', eventsQuerySchema),
		async (c) =>
			c.json(await billingServiceFor(c).listEvents(c.req.valid('json'))),
	);

	billingRoutes.get('/plans', opts.auth, async (c) =>
		c.json(await billingServiceFor(c).listPlans()),
	);

	billingRoutes.post(
		'/preview',
		opts.auth,
		sValidator('json', previewPlanSchema),
		async (c) =>
			c.json(await billingServiceFor(c).previewPlanChange(c.req.valid('json'))),
	);

	billingRoutes.post(
		'/checkout/plan',
		opts.auth,
		sValidator('json', checkoutPlanSchema),
		async (c) =>
			c.json(await billingServiceFor(c).checkoutPlan(c.req.valid('json'))),
	);

	billingRoutes.post(
		'/checkout/top-up',
		opts.auth,
		sValidator('json', checkoutTopUpSchema),
		async (c) =>
			c.json(await billingServiceFor(c).checkoutTopUp(c.req.valid('json'))),
	);

	billingRoutes.get('/portal', opts.auth, async (c) => {
		const returnUrl =
			c.req.query('returnUrl') ?? new URL('/dashboard', c.req.url).toString();
		return c.json(await billingServiceFor(c).openPortal({ returnUrl }));
	});

	app.route(BILLING_PREFIX, billingRoutes);
}
