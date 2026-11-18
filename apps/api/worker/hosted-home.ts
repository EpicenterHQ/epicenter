// Cloud-only gateway. OAuth selects the person's home; no request parameter can.
import {
	type CloudEnv,
	type OAuthScope,
	requireAccessToken,
} from '@epicenter/server';
import { sql } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { HOME_AGENT_CLIENT } from './hosted-home-config.js';
export interface HostedHomesGateway {
	owner(
		authority: string,
		principal: string,
		request: Request,
	): Promise<Response>;
}
export function homeScope(
	path: string,
	method: string,
): OAuthScope | undefined {
	if (path === '/provision' && method === 'POST') return 'home:build';
	if (/^\/agents(?:\/[^/]+)?$/.test(path) && ['GET', 'DELETE'].includes(method))
		return 'home:manage';
	if (path === '/admin/source')
		return method === 'GET'
			? 'home:read'
			: method === 'POST'
				? 'home:source'
				: undefined;
	if (path === '/admin/build' && method === 'POST') return 'home:build';
	if (
		['/admin/status', '/admin/runs', '/admin/preview', '/admin/data'].includes(
			path,
		) &&
		method === 'GET'
	)
		return 'home:read';
	const run =
		/^(?:\/tasks~[-a-zA-Z0-9]+)?\/\.runs\/tasks\/[a-zA-Z0-9.-]+\/[-a-zA-Z0-9]{1,80}(?:\/(events|cancel))?$/.exec(
			path,
		);
	if (run && method === 'GET' && run[1] !== 'cancel') return 'home:read';
	if (run && method === 'POST' && run[1] !== 'events') return 'home:run';
}
export function mountHostedHomes(
	app: Hono<CloudEnv>,
	{
		setup,
		enabled,
		resolveGateway,
	}: {
		setup: MiddlewareHandler<CloudEnv>;
		enabled(env: CloudEnv['Bindings']): boolean;
		resolveGateway(env: CloudEnv['Bindings']): HostedHomesGateway | undefined;
	},
) {
	app.use(
		'/homes/*',
		async (c, next) => {
			if (!enabled(c.env)) return c.notFound();
			try {
				return await setup(c, next);
			} catch {
				return c.json(
					{ error: 'Hosted homes are temporarily unavailable. Try again.' },
					503,
				);
			}
		},
		async (c, next) => {
			const scope = homeScope(
				new URL(c.req.url).pathname.slice('/homes'.length),
				c.req.method,
			);
			if (!scope) return c.notFound();
			return requireAccessToken({ audience: 'homes', scope })(c, next);
		},
	);
	app.get('/homes/agents', async (c) => {
		const { rows } = await c.var.db.execute(
			sql`select id,scopes,created_at,expires_at from oauth_access_token where user_id=${c.var.principal.id} and client_id=${HOME_AGENT_CLIENT} and revoked is null and expires_at > now() at time zone 'UTC' order by created_at desc`,
		);
		return c.json(rows);
	});
	app.delete('/homes/agents/:id', async (c) => {
		// Agent grants have no refresh token: revoking this access token is final.
		await c.var.db.execute(
			sql`delete from oauth_access_token where id=${c.req.param('id')} and user_id=${c.var.principal.id} and client_id=${HOME_AGENT_CLIENT}`,
		);
		return c.body(null, 204);
	});
	app.all('/homes/*', async (c) => {
		const binding = resolveGateway(c.env);
		if (!binding)
			return c.json(
				{ error: 'Hosted homes are unavailable on this deployment.' },
				503,
			);
		return binding.owner(c.var.authBaseURL, c.var.principal.id, c.req.raw);
	});
}
