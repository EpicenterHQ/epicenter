/** Production auth owner and session projection under workerd; operator RPC is test-only. */
import { Hono } from 'hono';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { OAuthError } from '../../src/auth/oauth-errors.js';
import { requireBearerPrincipal } from '../../src/middleware/require-auth.js';
import { mountSessionApp } from '../../src/routes/session.js';
import type { Env } from '../../src/types.js';
import { SelfHostAuthOwner } from '../../src/self-host-auth/worker.js';
export { SelfHostAuthOwner };

type Bindings = { SELF_HOST_AUTH: DurableObjectNamespace<SelfHostAuthOwner> };
function owner(env: unknown) {
	const binding = (env as Bindings).SELF_HOST_AUTH;
	return binding.get(binding.idFromName('deployment'));
}
const app = new Hono<Env>();
app.all('/auth/*', (c) => owner(c.env).fetch(c.req.raw));
mountSessionApp(app, {
	auth: requireBearerPrincipal(async (c, bearer) => {
		const session = await owner(c.env).resolveSession(bearer);
		return session
			? Ok({ id: asPrincipalId(session.userId) })
			: OAuthError.InvalidToken();
	}),
});
export default { fetch: app.fetch };
