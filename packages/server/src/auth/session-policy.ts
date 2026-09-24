import type { Session, User } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';

export const SESSION_FRESH_AGE_SECONDS = 600;
export const SESSION_POLICY = {
	expiresIn: 30 * 86400,
	updateAge: 86400,
	freshAge: SESSION_FRESH_AGE_SECONDS,
	cookieCache: { enabled: false },
};
const managementPaths = new Set([
	'/link-social',
	'/unlink-account',
	'/passkey/generate-register-options',
	'/passkey/verify-registration',
	'/passkey/delete-passkey',
	'/passkey/update-passkey',
]);

/**
 * Resolve the invoking credential through the public session endpoint before
 * any management endpoint caches an ambient identity. The nested /get-session
 * call bypasses this path guard and runs Better Auth's bearer normalization.
 */
export function requireAccountSession(
	resolveSession: (
		headers: Headers,
	) => Promise<{ session: Session; user: User } | null>,
) {
	return createAuthMiddleware(async (ctx) => {
		if (!managementPaths.has(ctx.path)) return;
		const headers = new Headers();
		const authorization = ctx.headers?.get('authorization');
		if (ctx.headers?.has('authorization'))
			headers.set('authorization', authorization ?? '');
		else if (ctx.headers?.has('cookie'))
			headers.set('cookie', ctx.headers.get('cookie') ?? '');
		let session: { session: Session; user: User } | null;
		try {
			session = await resolveSession(headers);
		} catch (cause) {
			if (cause instanceof APIError && cause.statusCode === 401) throw cause;
			throw new APIError('SERVICE_UNAVAILABLE', {
				message: 'Session database unavailable',
				code: 'SESSION_UNAVAILABLE',
			});
		}
		if (!session || session.session.expiresAt.getTime() <= Date.now())
			throw new APIError('UNAUTHORIZED', {
				message: 'Session required',
				code: 'UNAUTHORIZED',
			});
		if (ctx.headers?.get('x-epicenter-principal') !== session.user.id)
			throw new APIError('FORBIDDEN', {
				message: 'Account changed',
				code: 'PRINCIPAL_MISMATCH',
			});
		if (
			Date.now() - session.session.createdAt.getTime() >=
			SESSION_FRESH_AGE_SECONDS * 1000
		)
			throw new APIError('FORBIDDEN', {
				message: 'Sign in again to change your login methods.',
				code: 'SESSION_NOT_FRESH',
			});
		ctx.context.session = session;
	});
}
