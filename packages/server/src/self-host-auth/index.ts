import { createLogger, type Logger } from 'wellcrafted/logger';
import { defineErrors } from 'wellcrafted/error';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from '@simplewebauthn/server';

/** Both Bun SQLite and Durable Object SQLite execute this transaction synchronously. */
export type SelfHostAuthDatabase = {
	all<T>(sql: string, ...bindings: (string | number | null)[]): T[];
	run(sql: string, ...bindings: (string | number | null)[]): void;
	transaction<T>(operation: () => T): T;
};
type User = { id: string; name: string; revision: number };
type Grant = { user_id: string; revision: number };
type Ceremony = {
	id: string;
	grant_hash: string | null;
	user_id: string | null;
	revision: number | null;
	challenge: string;
	binding: string;
};
type Session = {
	userId: string;
	name: string;
	revision: number;
	createdAt: number;
	expiresAt: number;
};
type Handoff = {
	callback: string;
	challenge: string;
	state: string;
	source_hash: string;
};
const ceremonyLifetime = 300_000;
const sessionLifetime = 7 * 86_400_000;
const AuthError = defineErrors({
	RequestFailed: ({ causeName }: { causeName: string }) => ({
		message: 'Authentication infrastructure failed',
		causeName,
	}),
});
class AuthRefusal extends Error {
	constructor(
		message: string,
		public status = 400,
	) {
		super(message);
		this.name = 'AuthRefusal';
	}
}

/** One durable owner commits admission, credentials, sessions, and handoffs. */
export function createSelfHostAuth({
	database: db,
	origin,
	callbacks,
	rpName = 'Epicenter',
	log = createLogger('self-host-auth'),
}: {
	database: SelfHostAuthDatabase;
	origin: string;
	callbacks: readonly string[];
	rpName?: string;
	log?: Logger;
}) {
	const url = new URL(origin);
	if (
		url.origin !== origin ||
		(url.protocol !== 'https:' &&
			!(url.protocol === 'http:' && url.hostname === 'localhost'))
	)
		throw new AuthRefusal(
			'Authentication requires an HTTPS origin or localhost',
		);
	const rpID = url.hostname;
	const prefix = url.protocol === 'https:' ? '__Host-' : '';
	const cookieName = `${prefix}epicenter_session`;
	const bindingCookie = `${prefix}epicenter_ceremony`;
	const allowedCallbacks = new Set(callbacks);
	for (const callback of allowedCallbacks) {
		const destination = new URL(callback);
		if (
			!(
				destination.protocol === 'https:' ||
				(destination.protocol === 'http:' &&
					['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)) ||
				callback === 'epicenter://auth/callback'
			) ||
			destination.hash ||
			destination.search ||
			destination.username ||
			destination.password
		)
			throw new AuthRefusal(
				'Callback must be an exact URL without query, fragment, or credentials',
			);
	}
	for (const statement of [
		'CREATE TABLE IF NOT EXISTS auth_rate (id INTEGER PRIMARY KEY CHECK (id = 1), window INTEGER NOT NULL, count INTEGER NOT NULL)',
		'CREATE TABLE IF NOT EXISTS auth_user (id TEXT PRIMARY KEY, name TEXT NOT NULL, admitted INTEGER NOT NULL, revision INTEGER NOT NULL)',
		'CREATE TABLE IF NOT EXISTS auth_grant (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL)',
		'CREATE TABLE IF NOT EXISTS auth_ceremony (id TEXT PRIMARY KEY, grant_hash TEXT, user_id TEXT, revision INTEGER, challenge TEXT NOT NULL, binding TEXT NOT NULL, expires INTEGER NOT NULL)',
		'CREATE TABLE IF NOT EXISTS auth_credential (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL)',
		'CREATE TABLE IF NOT EXISTS auth_session (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)',
		'CREATE TABLE IF NOT EXISTS auth_handoff (hash TEXT PRIMARY KEY, callback TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT NOT NULL, source_hash TEXT NOT NULL, expires INTEGER NOT NULL)',
	])
		db.run(statement);
	function user(id: string) {
		const row = db.all<User>(
			'SELECT id, name, revision FROM auth_user WHERE id = ? AND admitted = 1',
			id,
		)[0];
		if (!row) throw new AuthRefusal('User is not admitted');
		return row;
	}
	function grant(hash: string) {
		const row = db.all<Grant>(
			'SELECT g.user_id, g.revision FROM auth_grant g JOIN auth_user u ON u.id = g.user_id WHERE g.hash = ? AND g.expires > ? AND u.admitted = 1 AND u.revision = g.revision',
			hash,
			Date.now(),
		)[0];
		if (!row) throw new AuthRefusal('Enrollment authorization is invalid');
		return row;
	}
	function session(hash: string) {
		return (
			db.all<Session>(
				'SELECT s.user_id AS userId, u.name, s.revision, s.created AS createdAt, s.expires AS expiresAt FROM auth_session s JOIN auth_user u ON u.id = s.user_id WHERE s.hash = ? AND s.expires > ? AND u.admitted = 1 AND u.revision = s.revision',
				hash,
				Date.now(),
			)[0] ?? null
		);
	}
	function revoke(id: string) {
		db.run(
			'DELETE FROM auth_handoff WHERE source_hash IN (SELECT hash FROM auth_session WHERE user_id = ?)',
			id,
		);
		for (const table of [
			'auth_grant',
			'auth_ceremony',
			'auth_credential',
			'auth_session',
		])
			db.run(`DELETE FROM ${table} WHERE user_id = ?`, id);
	}
	function insertSession(
		hash: string,
		id: string,
		revision: number,
		created = Date.now(),
	) {
		db.run(
			'INSERT INTO auth_session VALUES (?, ?, ?, ?, ?)',
			hash,
			id,
			revision,
			created,
			Date.now() + sessionLifetime,
		);
	}
	function ceremony(id: string, binding: string) {
		const row = db.all<Ceremony>(
			'SELECT * FROM auth_ceremony WHERE id = ? AND binding = ? AND expires > ?',
			id,
			binding,
			Date.now(),
		)[0];
		if (!row) throw new AuthRefusal('Passkey ceremony is invalid');
		return row;
	}
	function cookie(name: string, token: string, maxAge: number) {
		return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;
	}
	function requestCookie(request: Request, name: string) {
		return request.headers
			.get('cookie')
			?.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${name}=`))
			?.slice(name.length + 1);
	}
	function requireBrowser(request: Request) {
		if (
			request.headers.has('authorization') ||
			request.headers.get('origin') !== origin
		)
			throw new AuthRefusal('Same-origin browser ceremony required');
	}
	function limitCeremonies() {
		// A durable deployment-wide ceiling needs no attacker-controlled client identity.
		db.transaction(() => {
			const window = Math.floor(Date.now() / 60_000);
			db.run(
				'INSERT INTO auth_rate VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET window = excluded.window, count = 0 WHERE auth_rate.window != excluded.window',
				window,
			);
			const row = db.all<{ count: number }>(
				'SELECT count FROM auth_rate WHERE id = 1',
			)[0];
			if (!row) throw new Error('Missing rate limit row');
			if (row.count >= 60) throw new AuthRefusal('Ceremony rate exceeded', 429);
			db.run('UPDATE auth_rate SET count = count + 1 WHERE id = 1');
		});
	}
	function prune() {
		const now = Date.now();
		for (const table of [
			'auth_grant',
			'auth_ceremony',
			'auth_session',
			'auth_handoff',
		])
			db.run(`DELETE FROM ${table} WHERE expires <= ?`, now);
	}
	return {
		/** Internal operator command. Deliver the returned grant privately. */
		async admit({ id, name }: { id: string; name: string }) {
			if (
				id === 'instance' ||
				!/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
				!name.trim() ||
				name.length > 200
			)
				throw new AuthRefusal('Invalid user identity');
			const token = randomToken();
			const hash = await digest(token);
			db.transaction(() => {
				db.run('INSERT INTO auth_user VALUES (?, ?, 1, 1)', id, name);
				db.run(
					'INSERT INTO auth_grant VALUES (?, ?, 1, ?)',
					hash,
					id,
					Date.now() + ceremonyLifetime,
				);
			});
			return { userId: id, token, expiresAt: Date.now() + ceremonyLifetime };
		},
		/** Recovery preserves identity and invalidates all prior access before issuing replacement authorization. */
		async recover(id: string) {
			const token = randomToken();
			const hash = await digest(token);
			db.transaction(() => {
				const current = user(id);
				revoke(id);
				db.run('UPDATE auth_user SET revision = revision + 1 WHERE id = ?', id);
				db.run(
					'INSERT INTO auth_grant VALUES (?, ?, ?, ?)',
					hash,
					id,
					current.revision + 1,
					Date.now() + ceremonyLifetime,
				);
			});
			return { userId: id, token, expiresAt: Date.now() + ceremonyLifetime };
		},
		remove(id: string) {
			db.transaction(() => {
				user(id);
				revoke(id);
				db.run(
					'UPDATE auth_user SET admitted = 0, revision = revision + 1 WHERE id = ?',
					id,
				);
			});
		},
		async resolveSession(token: string) {
			return session(await digest(token));
		},
		async revokeSession(token: string) {
			const hash = await digest(token);
			db.transaction(() => {
				db.run('DELETE FROM auth_handoff WHERE source_hash = ?', hash);
				db.run('DELETE FROM auth_session WHERE hash = ?', hash);
			});
		},
		/** Public HTTP surface. No operator commands are exposed here. */
		async handle(request: Request): Promise<Response> {
			const headers = new Headers({
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
			});
			const json = (body: unknown, status = 200) =>
				Response.json(body, { status, headers });
			const path = new URL(request.url).pathname;
			try {
				prune();
				if (path === '/auth/get-session' && request.method === 'GET') {
					const token = requestCookie(request, cookieName);
					const current = token ? session(await digest(token)) : null;
					return json(
						current
							? {
									user: { id: current.userId, name: current.name },
									session: {
										createdAt: new Date(current.createdAt),
										expiresAt: new Date(current.expiresAt),
									},
								}
							: null,
					);
				}
				if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
				if (path !== '/auth/session/redeem' && path !== '/auth/sign-out')
					requireBrowser(request);
				if (path === '/auth/sign-out') {
					const authorization = request.headers.get('authorization');
					if (!authorization) requireBrowser(request);
					if (
						authorization &&
						(request.headers.has('cookie') ||
							!authorization.startsWith('Bearer '))
					)
						throw new AuthRefusal('Invalid bearer sign-out');
					const token =
						authorization?.slice(7) ?? requestCookie(request, cookieName);
					if (token) await this.revokeSession(token);
					headers.append('Set-Cookie', cookie(cookieName, '', 0));
					return json({ success: true });
				}
				if (
					!request.headers.get('content-type')?.startsWith('application/json')
				)
					return json({ error: 'JSON required' }, 415);
				const body: unknown = await readJson(request);
				if (!body || typeof body !== 'object' || Array.isArray(body))
					throw new AuthRefusal('Invalid request');
				const input = body as Record<string, unknown>;
				const field = (name: string) => {
					const value = input[name];
					if (typeof value !== 'string' || value.length > 2048)
						throw new AuthRefusal('Invalid request');
					return value;
				};
				if (
					path === '/auth/passkey/registration-options' ||
					path === '/auth/passkey/authentication-options'
				) {
					limitCeremonies();
					const binding = randomToken();
					const bindingHash = await digest(binding);
					const id = randomToken();
					headers.append(
						'Set-Cookie',
						cookie(bindingCookie, binding, ceremonyLifetime / 1000),
					);
					if (path === '/auth/passkey/registration-options') {
						const hash = await digest(field('token'));
						const authorized = grant(hash);
						const owner = user(authorized.user_id);
						const options = await generateRegistrationOptions({
							rpID,
							rpName,
							userID: new TextEncoder().encode(owner.id),
							userName: owner.name,
							attestationType: 'none',
							authenticatorSelection: {
								residentKey: 'required',
								userVerification: 'required',
							},
						});
						db.transaction(() => {
							const current = grant(hash);
							if (current.revision !== authorized.revision)
								throw new AuthRefusal('Authorization changed');
							db.run(
								'INSERT INTO auth_ceremony VALUES (?, ?, ?, ?, ?, ?, ?)',
								id,
								hash,
								owner.id,
								owner.revision,
								options.challenge,
								bindingHash,
								Date.now() + ceremonyLifetime,
							);
						});
						return json({ id, options });
					}
					const options = await generateAuthenticationOptions({
						rpID,
						userVerification: 'required',
					});
					db.run(
						'INSERT INTO auth_ceremony VALUES (?, NULL, NULL, NULL, ?, ?, ?)',
						id,
						options.challenge,
						bindingHash,
						Date.now() + ceremonyLifetime,
					);
					return json({ id, options });
				}
				if (
					path === '/auth/passkey/register' ||
					path === '/auth/passkey/authenticate'
				) {
					const binding = requestCookie(request, bindingCookie);
					if (!binding) throw new AuthRefusal('Missing browser binding');
					const bindingHash = await digest(binding);
					const id = field('id');
					const pending = ceremony(id, bindingHash);
					const token = randomToken();
					const hash = await digest(token);
					if (path === '/auth/passkey/register') {
						if (!pending.grant_hash || !pending.user_id)
							throw new AuthRefusal('Invalid registration ceremony');
						const verified = await verifyRegistrationResponse({
							response: input.response as RegistrationResponseJSON,
							expectedChallenge: pending.challenge,
							expectedOrigin: origin,
							expectedRPID: rpID,
							requireUserVerification: true,
						}).catch(() => {
							throw new AuthRefusal('Passkey verification failed');
						});
						if (!verified.verified || !verified.registrationInfo)
							throw new AuthRefusal('Passkey verification failed');
						const credential = verified.registrationInfo.credential;
						db.transaction(() => {
							const current = ceremony(id, bindingHash);
							const authorized = grant(pending.grant_hash!);
							if (
								current.grant_hash !== pending.grant_hash ||
								authorized.user_id !== pending.user_id ||
								authorized.revision !== pending.revision
							)
								throw new AuthRefusal('Enrollment authorization changed');
							db.run(
								'DELETE FROM auth_grant WHERE hash = ?',
								pending.grant_hash,
							);
							db.run(
								'DELETE FROM auth_ceremony WHERE grant_hash = ?',
								pending.grant_hash,
							);
							db.run(
								'INSERT INTO auth_credential VALUES (?, ?, ?, ?)',
								credential.id,
								authorized.user_id,
								encode(credential.publicKey),
								credential.counter,
							);
							insertSession(hash, authorized.user_id, authorized.revision);
						});
					} else {
						if (pending.grant_hash !== null)
							throw new AuthRefusal('Invalid authentication ceremony');
						const response = input.response as AuthenticationResponseJSON;
						if (
							!response ||
							typeof response.id !== 'string' ||
							!response.response ||
							typeof response.response !== 'object'
						)
							throw new AuthRefusal('Invalid passkey response');
						const stored = db.all<{
							user_id: string;
							public_key: string;
							counter: number;
						}>('SELECT * FROM auth_credential WHERE id = ?', response.id)[0];
						if (!stored) throw new AuthRefusal('Passkey not found');
						const owner = user(stored.user_id);
						if (
							response.response.userHandle &&
							response.response.userHandle !==
								encode(new TextEncoder().encode(owner.id))
						)
							throw new AuthRefusal('Passkey user handle mismatch');
						const verified = await verifyAuthenticationResponse({
							response,
							expectedChallenge: pending.challenge,
							expectedOrigin: origin,
							expectedRPID: rpID,
							requireUserVerification: true,
							credential: {
								id: response.id,
								publicKey: decode(stored.public_key),
								counter: stored.counter,
							},
						}).catch(() => {
							throw new AuthRefusal('Passkey verification failed');
						});
						if (!verified.verified)
							throw new AuthRefusal('Passkey verification failed');
						db.transaction(() => {
							ceremony(id, bindingHash);
							if (user(owner.id).revision !== owner.revision)
								throw new AuthRefusal('Authentication revision changed');
							const current = db.all<{ public_key: string; counter: number }>(
								'SELECT public_key, counter FROM auth_credential WHERE id = ? AND user_id = ?',
								response.id,
								owner.id,
							)[0];
							if (
								current?.public_key !== stored.public_key ||
								current.counter !== stored.counter
							)
								throw new AuthRefusal('Passkey changed');
							db.run('DELETE FROM auth_ceremony WHERE id = ?', id);
							db.run(
								'UPDATE auth_credential SET counter = ? WHERE id = ?',
								verified.authenticationInfo.newCounter,
								response.id,
							);
							insertSession(hash, owner.id, owner.revision);
						});
					}
					headers.append(
						'Set-Cookie',
						cookie(cookieName, token, sessionLifetime / 1000),
					);
					headers.append('Set-Cookie', cookie(bindingCookie, '', 0));
					return json({ success: true });
				}
				if (path === '/auth/session/authorize') {
					const callback = field('callback');
					const challenge = field('challenge');
					const state = field('state');
					if (
						!allowedCallbacks.has(callback) ||
						!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
						!/^[A-Za-z0-9_-]{32,128}$/.test(state)
					)
						throw new AuthRefusal('Invalid handoff binding');
					const sourceToken = requestCookie(request, cookieName);
					if (!sourceToken) return json({ error: 'Sign in first' }, 401);
					const sourceHash = await digest(sourceToken);
					const code = randomToken();
					const hash = await digest(code);
					db.transaction(() => {
						if (!session(sourceHash)) throw new AuthRefusal('Login expired');
						db.run(
							'INSERT INTO auth_handoff VALUES (?, ?, ?, ?, ?, ?)',
							hash,
							callback,
							challenge,
							state,
							sourceHash,
							Date.now() + 120_000,
						);
					});
					const destination = new URL(callback);
					destination.searchParams.set('code', code);
					destination.searchParams.set('state', state);
					return json({ url: destination.href });
				}
				if (path === '/auth/session/redeem') {
					const callback = field('callback');
					const verifier = field('verifier');
					const state = field('state');
					const code = field('code');
					const requestOrigin = request.headers.get('origin');
					if (
						request.headers.has('cookie') ||
						request.headers.has('authorization') ||
						!allowedCallbacks.has(callback) ||
						(requestOrigin && requestOrigin !== new URL(callback).origin) ||
						!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
						code.length > 128
					)
						throw new AuthRefusal('Invalid handoff');
					const hash = await digest(code);
					const challenge = await digest(verifier);
					const token = randomToken();
					const tokenHash = await digest(token);
					// Consume outside issuance transaction: incorrect binding burns the code.
					const handoff = db.all<Handoff>(
						'DELETE FROM auth_handoff WHERE hash = ? AND expires > ? RETURNING *',
						hash,
						Date.now(),
					)[0];
					if (
						!handoff ||
						handoff.callback !== callback ||
						handoff.state !== state ||
						handoff.challenge !== challenge
					)
						throw new AuthRefusal('Invalid handoff');
					db.transaction(() => {
						const source = session(handoff.source_hash);
						if (!source) throw new AuthRefusal('Login expired');
						insertSession(
							tokenHash,
							source.userId,
							source.revision,
							source.createdAt,
						);
					});
					return json({ token });
				}
				return json({ error: 'Not found' }, 404);
			} catch (cause) {
				if (cause instanceof AuthRefusal) {
					if (cause.status === 429) headers.set('Retry-After', '60');
					return json(
						{
							error:
								cause.status === 429
									? 'Too many authentication ceremonies. Try again shortly.'
									: 'Authentication request rejected',
						},
						cause.status,
					);
				}
				log.error(
					AuthError.RequestFailed({
						causeName:
							cause instanceof Error &&
							[
								'Error',
								'TypeError',
								'RangeError',
								'SQLiteError',
								'DOMException',
							].includes(cause.name)
								? cause.name
								: 'UnknownError',
					}),
				);
				return json({ error: 'Authentication temporarily unavailable' }, 503);
			}
		},
	};
}
export type SelfHostAuth = ReturnType<typeof createSelfHostAuth>;
function encode(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}
function decode(value: string) {
	return Uint8Array.from(
		atob(value.replaceAll('-', '+').replaceAll('_', '/')),
		(char) => char.charCodeAt(0),
	);
}
function randomToken() {
	return encode(crypto.getRandomValues(new Uint8Array(32)));
}
async function digest(value: string) {
	return encode(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
		),
	);
}

async function readJson(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new AuthRefusal('JSON body required');
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 256 * 1024) {
				await reader.cancel();
				throw new AuthRefusal('Request body too large', 413);
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new AuthRefusal('Invalid JSON');
	}
}
