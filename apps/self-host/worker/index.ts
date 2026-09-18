/** Self-hosted named-user Worker. The operator owns enrollment and durable admission. */
import { asPrincipalId } from '@epicenter/principal';
import {
	createServerApp,
	GenerationsLedger,
	mountBlobsApp,
	mountInferenceApp,
	mountSessionApp,
	mountStoreSyncApp,
	mountTranscriptionApp,
	OAuthError,
	type ResolveBearerPrincipal,
	rateLimit,
	requireBearerPrincipal,
	StoreAuthority,
	type StoreAuthorityStub,
} from '@epicenter/server';
import { SelfHostAuthOwner } from '@epicenter/server/self-host-auth/worker';
import { signInPage, signInScript } from '../sign-in.js';
import { resolveSelfHostTrustedOrigins } from '../trusted-origins.js';
import { SelfHostOperator } from './operator.js';

const app = createServerApp({
	resolveOrigin: (env) => (env as Cloudflare.Env).API_PUBLIC_ORIGIN,
	resolveTrustedOrigins: (origin, env) =>
		resolveSelfHostTrustedOrigins(
			origin,
			(env as Cloudflare.Env).TRUSTED_BROWSER_ORIGINS,
		),
});
function authentication(env: Cloudflare.Env) {
	return env.SELF_HOST_AUTH.get(env.SELF_HOST_AUTH.idFromName('deployment'));
}
const resolveBearerPrincipal: ResolveBearerPrincipal = async (c, bearer) => {
	try {
		const session = await authentication(
			c.env as Cloudflare.Env,
		).resolveSession(bearer);
		return session
			? { data: { id: asPrincipalId(session.userId) }, error: null }
			: OAuthError.InvalidToken();
	} catch {
		return OAuthError.ServerError();
	}
};
const auth = requireBearerPrincipal(resolveBearerPrincipal);
app.get('/', (c) => c.json({ product: 'self-host', runtime: 'cloudflare' }));
app.get('/sign-in', () => signInPage());
app.get('/auth/sign-in.js', () => signInScript());
app.all('/auth/*', (c) =>
	authentication(c.env as Cloudflare.Env).fetch(c.req.raw),
);
mountSessionApp(app, { auth });
mountStoreSyncApp(app, {
	shared: true,
	resolveBearerPrincipal,
	resolveStore: (env) => {
		const bindings = env as Cloudflare.Env;
		return {
			authority: (name) =>
				bindings.STORE_AUTHORITY.get(
					bindings.STORE_AUTHORITY.idFromName(name),
				) as unknown as StoreAuthorityStub,
			ledger: (name) =>
				bindings.GENERATIONS_LEDGER.get(
					bindings.GENERATIONS_LEDGER.idFromName(name),
				),
		};
	},
});
mountInferenceApp(app, {
	auth,
	policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
});
mountTranscriptionApp(app, {
	auth,
	policies: [rateLimit({ requests: 120, windowSeconds: 60 })],
});
mountBlobsApp(app, { auth });
export default app;
export {
	GenerationsLedger,
	SelfHostAuthOwner,
	SelfHostOperator,
	StoreAuthority,
};
