/**
 * The operator's device-grant admin surface (ADR-0115): mint, list, and
 * revoke the per-device attach grants a {@link DeviceGrantStore} holds.
 *
 * This is the "desktop approves a device" surface of ADR-0115 clause 3, realized
 * on a single-partition instance as the operator administering their own box: it
 * is gated by the operator token (`INSTANCE_TOKEN` via the deployment's
 * `requireBearerPrincipal`), NOT by an attach grant. So the two attach credentials
 * split cleanly: the operator token administers the allowlist, and a device grant
 * only connects. There is no fallback path where one credential does both.
 *
 * ## Not a relay surface
 *
 * These are plain HTTP management routes for the account and device layer, the
 * layer ADR-0115 keeps ABOVE the relay. They carry `deviceId` and `label` only:
 * a `deviceId` is an addressing id the relay already knows, and a `label` is the
 * operator's own note for their list (the directory ADR-0115 clause 3 allows
 * carries a label too). They add no route name, capability, action, or topic to
 * the relay wire; the relay coordinator never sees them.
 */

import { type } from 'arktype';
import { Hono, type MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { Env } from '../types.js';
import type { DeviceGrantStore } from './device-grants.js';
import { GrantError } from './grant-errors.js';

/** The mint request body: which device to pair, with an optional operator label. */
const GrantMintRequest = type({
	deviceId: 'string > 0',
	'label?': 'string',
});

/**
 * Mount the device-grant admin surface on a deployment's server app.
 *
 * The deployment supplies its ordinary operator bearer middleware: minting and
 * revoking grants is an operator action, so it rides the operator token, never
 * a device grant. Bundles that auth and the three management routes into one
 * call, the same shape `mountSessionApp` uses.
 */
export function mountAttachGrantsApp<E extends Env = Env>(
	app: Hono<E>,
	opts: { auth: MiddlewareHandler<E>; grants: DeviceGrantStore },
): void {
	const grantsApp = new Hono<E>()
		.post(
			'/attach/grants',
			describeRoute({
				description: 'Mint a per-device attach grant (returns its secret once)',
				tags: ['attach-relay'],
			}),
			async (c) => {
				const body = await c.req.json().catch(() => null);
				const parsed = GrantMintRequest(body);
				if (parsed instanceof type.errors) {
					const err = GrantError.InvalidMintRequest({
						summary: parsed.summary,
					});
					return c.json(err, err.error.status);
				}
				// The secret is in the response ONCE; the store keeps only its hash.
				// The operator hands it to the device out of band (QR or paste).
				return c.json(await opts.grants.mint(parsed), 201);
			},
		)
		.get(
			'/attach/grants',
			describeRoute({
				description: 'List live per-device attach grants (no secrets)',
				tags: ['attach-relay'],
			}),
			(c) => c.json({ grants: opts.grants.list() }),
		)
		.delete(
			'/attach/grants/:id',
			describeRoute({
				description: 'Revoke a device grant; its next attach connect fails',
				tags: ['attach-relay'],
			}),
			(c) => {
				const id = c.req.param('id');
				if (opts.grants.revoke(id)) return c.body(null, 204);
				const err = GrantError.NotFound({ id });
				return c.json(err, err.error.status);
			},
		);

	// Gate every management route on the operator token. `/attach/grants` does not
	// collide with the `/attach` upgrade's own middleware: Hono's `use('/attach')`
	// matches that exact path only, never the `/attach/grants` segment beneath it.
	app.use('/attach/grants', opts.auth);
	app.use('/attach/grants/*', opts.auth);
	app.route('/', grantsApp);
}
