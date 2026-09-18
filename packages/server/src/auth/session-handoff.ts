import { type } from 'arktype';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { generateRandomString, makeSignature } from 'better-auth/crypto';

const authorizeBody = type({
	callback: 'string',
	challenge: 'string',
	state: 'string',
});
const redeemBody = type({
	callback: 'string',
	code: 'string',
	verifier: 'string',
	state: 'string',
});
const storedHandoff = type({
	callback: 'string',
	challenge: 'string',
	state: 'string',
	sourceToken: 'string',
	principalId: 'string',
});

async function hash(value: string) {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

/**
 * Independent client-session issuance through an exact callback and PKCE binding.
 *
 * Better Auth owns both session rows and atomic verification consumption. The
 * client owns state/verifier generation and cancellation. No session is set in
 * the hosted browser when a client redeems its code.
 */
export function sessionHandoff({
	origin,
	callbacks,
}: {
	origin: string;
	callbacks: readonly string[];
}) {
	const allowedCallbacks = new Set(callbacks);
	return {
		id: 'session-handoff',
		endpoints: {
			authorizeClientSession: createAuthEndpoint(
				'/session/authorize',
				{
					method: 'POST',
					body: authorizeBody,
				},
				async (ctx) => {
					// This endpoint is a hosted browser ceremony, even with bearer() enabled.
					if (
						ctx.headers?.has('authorization') ||
						ctx.headers?.get('origin') !== origin
					)
						throw ctx.error('FORBIDDEN', {
							message: 'Hosted browser ceremony required',
						});
					const { callback, challenge, state } = ctx.body;
					if (
						!allowedCallbacks.has(callback) ||
						!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
						!/^[A-Za-z0-9_-]{32,128}$/.test(state)
					)
						throw ctx.error('BAD_REQUEST', {
							message: 'Invalid handoff binding',
						});
					const sourceToken = await ctx.getSignedCookie(
						ctx.context.authCookies.sessionToken.name,
						ctx.context.secret,
					);
					const source = sourceToken
						? await ctx.context.internalAdapter.findSession(sourceToken)
						: null;
					if (!source || source.session.expiresAt.getTime() <= Date.now())
						throw ctx.error('UNAUTHORIZED', { message: 'Sign in first' });
					const code = generateRandomString(48);
					await ctx.context.internalAdapter.createVerificationValue({
						identifier: `client-session:${await hash(code)}`,
						value: JSON.stringify({
							callback,
							challenge,
							state,
							sourceToken: source.session.token,
							principalId: source.user.id,
						}),
						expiresAt: new Date(Date.now() + 120_000),
					});
					const destination = new URL(callback);
					destination.searchParams.set('code', code);
					destination.searchParams.set('state', state);
					ctx.setHeader('Cache-Control', 'no-store');
					ctx.setHeader('Referrer-Policy', 'no-referrer');
					return ctx.json({ url: destination.href });
				},
			),
			redeemClientSession: createAuthEndpoint(
				'/session/redeem',
				{
					method: 'POST',
					body: redeemBody,
				},
				async (ctx) => {
					const { callback, code, verifier, state } = ctx.body;
					const requestOrigin = ctx.headers?.get('origin');
					if (
						ctx.headers?.has('cookie') ||
						ctx.headers?.has('authorization') ||
						!allowedCallbacks.has(callback) ||
						(requestOrigin && requestOrigin !== new URL(callback).origin) ||
						!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
						code.length > 128
					)
						throw ctx.error('BAD_REQUEST', { message: 'Invalid handoff' });
					// consumeOne is DELETE RETURNING in the installed Postgres adapter.
					// A wrong verifier burns the code but can never mint a session.
					const record =
						await ctx.context.internalAdapter.consumeVerificationValue(
							`client-session:${await hash(code)}`,
						);
					const binding = storedHandoff(
						record && record.expiresAt.getTime() > Date.now()
							? JSON.parse(record.value)
							: null,
					);
					if (
						binding instanceof type.errors ||
						binding.callback !== callback ||
						binding.state !== state ||
						binding.challenge !== (await hash(verifier))
					)
						throw ctx.error('BAD_REQUEST', { message: 'Invalid handoff' });
					const source = await ctx.context.internalAdapter.findSession(
						binding.sourceToken,
					);
					if (
						!source ||
						source.user.id !== binding.principalId ||
						source.session.expiresAt.getTime() <= Date.now()
					)
						throw ctx.error('UNAUTHORIZED', {
							message: 'Hosted login expired',
						});
					const session = await ctx.context.internalAdapter.createSession(
						source.user.id,
						false,
						{ createdAt: source.session.createdAt },
						true,
					);
					if (!session)
						throw ctx.error('INTERNAL_SERVER_ERROR', {
							message: 'Session creation failed',
						});
					const signature = await makeSignature(
						session.token,
						ctx.context.secret,
					);
					ctx.setHeader('Cache-Control', 'no-store');
					return ctx.json({ token: `${session.token}.${signature}` });
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
