/** Test-only durable commit candidate. Not reachable through a production route. */
import { DurableObject } from 'cloudflare:workers';
import {
	generateRegistrationOptions,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	type AuthenticationResponseJSON,
	verifyRegistrationResponse,
	type RegistrationResponseJSON,
} from '@simplewebauthn/server';

const origin = 'https://enrollment.example.test';
const rpID = new URL(origin).hostname;

export class EnrollmentAdmission extends DurableObject<Cloudflare.Env> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS person (id TEXT PRIMARY KEY, admitted INTEGER NOT NULL, revision INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS grant_token (hash TEXT PRIMARY KEY, person TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS ceremony (id TEXT PRIMARY KEY, hash TEXT NOT NULL, person TEXT NOT NULL, revision INTEGER NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS authentication_ceremony (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, person TEXT NOT NULL, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS session_token (hash TEXT PRIMARY KEY, person TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL);
		`);
	}
	async admit(id: string) {
		const token = crypto.randomUUID();
		const hash = await digest(token);
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec('INSERT INTO person VALUES (?, 1, 1)', id);
			this.ctx.storage.sql.exec(
				'INSERT INTO grant_token VALUES (?, ?, 1, ?)',
				hash,
				id,
				Date.now() + 300_000,
			);
		});
		return token;
	}
	async begin(token: string) {
		return this.grant(await digest(token));
	}
	async registrationOptions(token: string) {
		const hash = await digest(token);
		const grant = this.grant(hash);
		const options = await generateRegistrationOptions({
			rpID,
			rpName: 'Enrollment evidence',
			userName: grant.person,
			userID: new TextEncoder().encode(grant.person),
			attestationType: 'none',
			authenticatorSelection: {
				residentKey: 'required',
				userVerification: 'required',
			},
		});
		const id = crypto.randomUUID();
		this.ctx.storage.transactionSync(() => {
			const current = this.grant(hash);
			if (current.revision !== grant.revision) throw new Error('Grant changed');
			this.ctx.storage.sql.exec(
				'INSERT INTO ceremony VALUES (?, ?, ?, ?, ?, ?)',
				id,
				hash,
				grant.person,
				grant.revision,
				options.challenge,
				Date.now() + 300_000,
			);
		});
		return { id, options };
	}
	async register(id: string, response: RegistrationResponseJSON) {
		const ceremony = this.ctx.storage.sql
			.exec<{
				hash: string;
				person: string;
				revision: number;
				challenge: string;
			}>('SELECT * FROM ceremony WHERE id = ? AND expires > ?', id, Date.now())
			.toArray()[0];
		if (!ceremony) throw new Error('Ceremony is invalid');
		const verified = await verifyRegistrationResponse({
			response,
			expectedChallenge: ceremony.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true,
		});
		if (!verified.verified || !verified.registrationInfo)
			throw new Error('Verification failed');
		const credential = verified.registrationInfo.credential;
		const session = crypto.randomUUID();
		const sessionHash = await digest(session);
		this.ctx.storage.transactionSync(() => {
			if (
				!this.ctx.storage.sql
					.exec(
						'SELECT id FROM ceremony WHERE id = ? AND expires > ?',
						id,
						Date.now(),
					)
					.toArray()[0]
			)
				throw new Error('Ceremony is invalid');
			this.commit(
				ceremony.hash,
				ceremony,
				{
					id: credential.id,
					publicKey: btoa(String.fromCharCode(...credential.publicKey)),
					counter: credential.counter,
				},
				sessionHash,
			);
		});
		return session;
	}

	async authenticationOptions() {
		const options = await generateAuthenticationOptions({
			rpID,
			userVerification: 'required',
		});
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			'INSERT INTO authentication_ceremony VALUES (?, ?, ?)',
			id,
			options.challenge,
			Date.now() + 300_000,
		);
		return { id, options };
	}
	async authenticate(id: string, response: AuthenticationResponseJSON) {
		const ceremony = this.ctx.storage.sql
			.exec<{ challenge: string }>(
				'SELECT challenge FROM authentication_ceremony WHERE id = ? AND expires > ?',
				id,
				Date.now(),
			)
			.toArray()[0];
		const row = this.ctx.storage.sql
			.exec<{ person: string; value: string }>(
				'SELECT person, value FROM credential WHERE id = ?',
				response.id,
			)
			.toArray()[0];
		if (!ceremony || !row) throw new Error('Authentication is invalid');
		const person = this.person(row.person);
		const stored = JSON.parse(row.value) as {
			id: string;
			publicKey: string;
			counter: number;
		};
		const verified = await verifyAuthenticationResponse({
			response,
			expectedChallenge: ceremony.challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true,
			credential: {
				...stored,
				publicKey: Uint8Array.from(atob(stored.publicKey), (char) =>
					char.charCodeAt(0),
				),
			},
		});
		if (!verified.verified) throw new Error('Authentication failed');
		const session = crypto.randomUUID();
		const sessionHash = await digest(session);
		this.ctx.storage.transactionSync(() => {
			if (this.person(row.person).revision !== person.revision)
				throw new Error('Authentication revision changed');
			const current = this.ctx.storage.sql
				.exec<{ value: string }>(
					'SELECT value FROM credential WHERE id = ? AND person = ?',
					response.id,
					row.person,
				)
				.toArray()[0];
			if (current?.value !== row.value) throw new Error('Credential changed');
			if (
				!this.ctx.storage.sql
					.exec(
						'DELETE FROM authentication_ceremony WHERE id = ? AND expires > ? RETURNING id',
						id,
						Date.now(),
					)
					.toArray()[0]
			)
				throw new Error('Authentication ceremony is invalid');
			this.ctx.storage.sql.exec(
				'UPDATE credential SET value = ? WHERE id = ?',
				JSON.stringify({
					...stored,
					counter: verified.authenticationInfo.newCounter,
				}),
				response.id,
			);
			this.ctx.storage.sql.exec(
				'INSERT INTO session_token VALUES (?, ?, ?, ?)',
				sessionHash,
				row.person,
				person.revision,
				Date.now() + 3_600_000,
			);
		});
		return session;
	}

	async recover(id: string) {
		const token = crypto.randomUUID();
		const hash = await digest(token);
		this.ctx.storage.transactionSync(() => {
			const person = this.person(id);
			this.revoke(id);
			this.ctx.storage.sql.exec(
				'UPDATE person SET revision = revision + 1 WHERE id = ?',
				id,
			);
			this.ctx.storage.sql.exec(
				'INSERT INTO grant_token VALUES (?, ?, ?, ?)',
				hash,
				id,
				person.revision + 1,
				Date.now() + 300_000,
			);
		});
		return token;
	}
	remove(id: string) {
		this.ctx.storage.transactionSync(() => {
			this.person(id);
			this.revoke(id);
			this.ctx.storage.sql.exec(
				'UPDATE person SET admitted = 0, revision = revision + 1 WHERE id = ?',
				id,
			);
		});
	}
	/** Caller supplies already-verified ceremony data; tests also exercise this with synthetic keys. */
	async complete(
		token: string,
		ceremony: { person: string; revision: number },
		credential: { id: string; publicKey: string; counter: number },
		failAfter?: 'grant' | 'credential' | 'session',
	) {
		const hash = await digest(token);
		const session = crypto.randomUUID();
		const sessionHash = await digest(session);
		this.ctx.storage.transactionSync(() =>
			this.commit(hash, ceremony, credential, sessionHash, failAfter),
		);
		return session;
	}
	private commit(
		hash: string,
		ceremony: { person: string; revision: number },
		credential: { id: string; publicKey: string; counter: number },
		sessionHash: string,
		failAfter?: 'grant' | 'credential' | 'session',
	) {
		const grant = this.grant(hash);
		if (
			grant.person !== ceremony.person ||
			grant.revision !== ceremony.revision
		)
			throw new Error('Ceremony owner changed');
		this.ctx.storage.sql.exec('DELETE FROM grant_token WHERE hash = ?', hash);
		this.ctx.storage.sql.exec('DELETE FROM ceremony WHERE hash = ?', hash);
		if (failAfter === 'grant') throw new Error('Injected after grant');
		this.ctx.storage.sql.exec(
			'INSERT INTO credential VALUES (?, ?, ?)',
			credential.id,
			grant.person,
			JSON.stringify(credential),
		);
		if (failAfter === 'credential')
			throw new Error('Injected after credential');
		this.ctx.storage.sql.exec(
			'INSERT INTO session_token VALUES (?, ?, ?, ?)',
			sessionHash,
			grant.person,
			grant.revision,
			Date.now() + 3_600_000,
		);
		if (failAfter === 'session') throw new Error('Injected after session');
	}

	async authorize(token: string) {
		const hash = await digest(token);
		const rows = this.ctx.storage.sql
			.exec<{ person: string }>(
				`SELECT s.person FROM session_token s JOIN person p ON p.id = s.person
			WHERE s.hash = ? AND s.expires > ? AND p.admitted = 1 AND p.revision = s.revision`,
				hash,
				Date.now(),
			)
			.toArray();
		return rows[0]?.person ?? null;
	}
	inspect(id: string) {
		return {
			person: this.ctx.storage.sql
				.exec('SELECT * FROM person WHERE id = ?', id)
				.toArray(),
			credentials: this.ctx.storage.sql
				.exec('SELECT * FROM credential WHERE person = ?', id)
				.toArray(),
			sessions: this.ctx.storage.sql
				.exec('SELECT * FROM session_token WHERE person = ?', id)
				.toArray(),
			grants: this.ctx.storage.sql
				.exec('SELECT * FROM grant_token WHERE person = ?', id)
				.toArray(),
		};
	}
	private person(id: string) {
		const row = this.ctx.storage.sql
			.exec<{ revision: number }>(
				'SELECT revision FROM person WHERE id = ? AND admitted = 1',
				id,
			)
			.toArray()[0];
		if (!row) throw new Error('Person is not admitted');
		return row;
	}
	private grant(hash: string) {
		const row = this.ctx.storage.sql
			.exec<{ person: string; revision: number }>(
				`SELECT g.person, g.revision FROM grant_token g JOIN person p ON p.id = g.person
			WHERE g.hash = ? AND g.expires > ? AND p.admitted = 1 AND p.revision = g.revision`,
				hash,
				Date.now(),
			)
			.toArray()[0];
		if (!row) throw new Error('Grant is invalid');
		return row;
	}
	private revoke(id: string) {
		this.ctx.storage.sql.exec('DELETE FROM grant_token WHERE person = ?', id);
		this.ctx.storage.sql.exec('DELETE FROM ceremony WHERE person = ?', id);
		this.ctx.storage.sql.exec('DELETE FROM credential WHERE person = ?', id);
		this.ctx.storage.sql.exec('DELETE FROM session_token WHERE person = ?', id);
	}
}
async function digest(token: string) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
		),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
}
export default {
	fetch() {
		return new Response('Test-only admission candidate', { status: 404 });
	},
};
