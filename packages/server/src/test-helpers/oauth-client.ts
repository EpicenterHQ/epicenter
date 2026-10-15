/**
 * Test-only OAuth client for the authorization server. It speaks HTTP through
 * a fetch function, so the same flows run in process (`app.fetch`), against
 * the Bun entry, and against `wrangler dev`. A browser session on the
 * authorization server is minted straight into Postgres and signed with the
 * deployment secret, because sign-in is a social provider the tests cannot
 * reach.
 */
import { makeSignature } from 'better-auth/crypto';
import type { Client, Pool } from 'pg';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Queryable = Pick<Client | Pool, 'query'>;

export type TokenResponse = {
	access_token: string;
	refresh_token?: string;
	scope?: string;
	expires_in?: number;
	error?: string;
};

function base64url(bytes: Uint8Array) {
	return Buffer.from(bytes).toString('base64url');
}

export async function pkce() {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
		),
	);
	return { verifier, challenge };
}

export type Person = {
	id: string;
	email: string;
	cookie: string;
	sessionId: string;
	/** The personal namespace the account trigger made. */
	personal: string;
};

export class OAuthTestClient {
	constructor(
		readonly origin: string,
		readonly db: Queryable,
		readonly secret: string,
		readonly send: Fetch = (url, init) => fetch(url, init),
	) {}

	get cookieName() {
		return new URL(this.origin).protocol === 'https:'
			? '__Secure-better-auth.session_token'
			: 'better-auth.session_token';
	}

	async request(
		path: string,
		init: {
			method?: string;
			form?: Record<string, string | string[]>;
			json?: unknown;
			cookie?: string;
			headers?: Record<string, string>;
		} = {},
	) {
		const headers = new Headers(init.headers);
		let body: string | undefined;
		if (init.form) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(init.form))
				for (const item of [value].flat()) params.append(key, item);
			body = params.toString();
			headers.set('content-type', 'application/x-www-form-urlencoded');
		}
		if (init.json !== undefined) {
			body = JSON.stringify(init.json);
			headers.set('content-type', 'application/json');
		}
		if (init.cookie) headers.set('cookie', init.cookie);
		if (!headers.has('origin')) headers.set('origin', this.origin);
		return this.send(this.origin + path, {
			method: init.method ?? (body === undefined ? 'GET' : 'POST'),
			headers,
			body,
			redirect: 'manual',
		});
	}

	async json<T = Record<string, unknown>>(response: Response): Promise<T> {
		const text = await response.text();
		try {
			return JSON.parse(text) as T;
		} catch {
			return { text } as T;
		}
	}

	/** An account and a signed-in browser session on the authorization server. */
	async person(label: string): Promise<Person> {
		const id = `${label}-${crypto.randomUUID()}`;
		const email = `${id}@example.test`;
		const sessionId = crypto.randomUUID();
		const token = base64url(crypto.getRandomValues(new Uint8Array(24)));
		const now = new Date();
		await this.db.query(
			'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, $4, $4)',
			[id, label, email, now],
		);
		await this.db.query(
			'insert into session (id, token, user_id, expires_at, created_at, updated_at) values ($1, $2, $3, $4, $5, $5)',
			[sessionId, token, id, new Date(Date.now() + 86_400_000), now],
		);
		const { rows } = await this.db.query<{ id: string }>(
			'select id from namespace where personal_account_id = $1',
			[id],
		);
		const personal = rows[0]?.id;
		if (!personal) throw new Error('the account has no personal namespace');
		const signed = `${token}.${await makeSignature(token, this.secret)}`;
		return {
			id,
			email,
			sessionId,
			personal,
			cookie: `${this.cookieName}=${encodeURIComponent(signed)}`,
		};
	}

	/** A group the person belongs to with `role`. */
	async group(person: Person, title: string, role: 'owner' | 'member') {
		const id = base64url(crypto.getRandomValues(new Uint8Array(9)))
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '0')
			.slice(0, 12)
			.padEnd(12, '0');
		await this.db.query('insert into namespace (id, title) values ($1, $2)', [
			id,
			title,
		]);
		await this.db.query(
			'insert into namespace_member (namespace_id, account_id, role) values ($1, $2, $3)',
			[id, person.id, role],
		);
		return id;
	}

	async authorize(o: {
		clientId: string;
		redirectUri: string;
		challenge: string;
		cookie?: string;
		scope?: string;
		resource?: string[];
		prompt?: string;
	}) {
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: o.clientId,
			redirect_uri: o.redirectUri,
			scope: o.scope ?? 'offline_access folders:read folders:write',
			state: `state-${crypto.randomUUID()}`,
			code_challenge: o.challenge,
			code_challenge_method: 'S256',
		});
		for (const resource of o.resource ?? []) query.append('resource', resource);
		if (o.prompt) query.set('prompt', o.prompt);
		const response = await this.request(`/auth/oauth2/authorize?${query}`, {
			cookie: o.cookie,
		});
		return {
			status: response.status,
			location: response.headers.get('location') ?? '',
			body:
				response.status >= 300 && response.status < 400
					? ''
					: await response.text(),
		};
	}

	async token(form: Record<string, string | string[]>) {
		const response = await this.request('/auth/oauth2/token', { form });
		return {
			status: response.status,
			body: await this.json<TokenResponse>(response),
		};
	}

	/** The code grant end to end for a client that skips consent. */
	async codeGrant(o: {
		clientId: string;
		redirectUri: string;
		cookie: string;
		scope?: string;
		resource: string[];
	}) {
		const { verifier, challenge } = await pkce();
		const authorized = await this.authorize({ ...o, challenge });
		const code = new URL(authorized.location, this.origin).searchParams.get(
			'code',
		);
		if (!code)
			throw new Error(
				`authorize gave no code: ${authorized.status} ${authorized.location} ${authorized.body}`,
			);
		return this.exchange({ ...o, code, verifier });
	}

	async exchange(o: {
		clientId: string;
		redirectUri: string;
		code: string;
		verifier: string;
		resource: string[];
	}) {
		const issued = await this.token({
			grant_type: 'authorization_code',
			client_id: o.clientId,
			code: o.code,
			code_verifier: o.verifier,
			redirect_uri: o.redirectUri,
			resource: o.resource,
		});
		if (issued.status !== 200)
			throw new Error(
				`code exchange ${issued.status} ${JSON.stringify(issued.body)}`,
			);
		return issued.body;
	}

	refresh(clientId: string, refreshToken: string) {
		return this.token({
			grant_type: 'refresh_token',
			client_id: clientId,
			refresh_token: refreshToken,
		});
	}

	/** Stage a target for one app's consent or one device code's approval. */
	async selectTarget(
		cookie: string,
		target: string,
		forRequest: { clientId: string } | { userCode: string },
	) {
		const response = await this.request('/auth/grant-target/select', {
			cookie,
			json: {
				target,
				...('clientId' in forRequest
					? { client_id: forRequest.clientId }
					: { user_code: forRequest.userCode }),
			},
		});
		return { status: response.status, body: await this.json(response) };
	}

	async consent(cookie: string, oauthQuery: string) {
		const response = await this.request('/auth/oauth2/consent', {
			cookie,
			json: { accept: true, oauth_query: oauthQuery },
		});
		return {
			status: response.status,
			body: await this.json<{ url?: string; redirect_uri?: string }>(response),
		};
	}

	/** The device grant: request, open, choose a target, approve, redeem. */
	async deviceGrant(o: {
		clientId: string;
		cookie: string;
		target?: string;
		scope?: string;
		resource: string[];
	}) {
		const started = await this.request('/auth/device/code', {
			form: {
				client_id: o.clientId,
				scope: o.scope ?? 'offline_access folders:read folders:write',
				resource: o.resource,
			},
		});
		const device = await this.json<{
			device_code: string;
			user_code: string;
		}>(started);
		if (!started.ok)
			throw new Error(
				`device/code ${started.status} ${JSON.stringify(device)}`,
			);
		// Opening the code on the approval page claims it for this person.
		const opened = await this.request(
			`/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
			{ cookie: o.cookie },
		);
		if (!opened.ok) throw new Error(`device ${opened.status}`);
		if (o.target) {
			const selected = await this.selectTarget(o.cookie, o.target, {
				userCode: device.user_code,
			});
			if (selected.status !== 200)
				throw new Error(
					`select ${selected.status} ${JSON.stringify(selected.body)}`,
				);
		}
		const approved = await this.request('/auth/device/approve', {
			cookie: o.cookie,
			json: { userCode: device.user_code },
		});
		if (!approved.ok)
			return {
				approval: { status: approved.status, body: await this.json(approved) },
			};
		const issued = await this.token({
			grant_type: DEVICE_GRANT,
			client_id: o.clientId,
			device_code: device.device_code,
		});
		if (issued.status !== 200)
			throw new Error(
				`device token ${issued.status} ${JSON.stringify(issued.body)}`,
			);
		return { tokens: issued.body };
	}

	async revoke(clientId: string, token: string, hint: string) {
		const response = await this.request('/auth/oauth2/revoke', {
			form: { client_id: clientId, token, token_type_hint: hint },
		});
		return response.status;
	}
}
