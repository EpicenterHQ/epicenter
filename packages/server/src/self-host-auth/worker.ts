import { DurableObject } from 'cloudflare:workers';
import { createSelfHostAuth, type SelfHostAuth } from './index.js';

export type SelfHostAuthEnv = {
	API_PUBLIC_ORIGIN: string;
	SELF_HOST_CALLBACKS: string;
};

/** One SQLite Durable Object owns all self-hosted users and authentication commits. */
export class SelfHostAuthOwner extends DurableObject<SelfHostAuthEnv> {
	private readonly auth: SelfHostAuth;
	constructor(ctx: DurableObjectState, env: SelfHostAuthEnv) {
		super(ctx, env);
		const callbacks: unknown = JSON.parse(env.SELF_HOST_CALLBACKS);
		if (
			!Array.isArray(callbacks) ||
			!callbacks.every((value): value is string => typeof value === 'string')
		)
			throw new Error(
				'SELF_HOST_CALLBACKS must be a JSON array of callback URLs',
			);
		this.auth = createSelfHostAuth({
			origin: env.API_PUBLIC_ORIGIN,
			callbacks,
			database: {
				all<T>(sql: string, ...bindings: (string | number | null)[]) {
					return ctx.storage.sql.exec(sql, ...bindings).toArray() as T[];
				},
				run(sql, ...bindings) {
					ctx.storage.sql.exec(sql, ...bindings);
				},
				transaction(operation) {
					return ctx.storage.transactionSync(operation);
				},
			},
		});
	}
	override fetch(request: Request) {
		return this.auth.handle(request);
	}
	admit(input: { id: string; name: string }) {
		return this.auth.admit(input);
	}
	recover(id: string) {
		return this.auth.recover(id);
	}
	remove(id: string) {
		return this.auth.remove(id);
	}
	resolveSession(token: string) {
		return this.auth.resolveSession(token);
	}
	revokeSession(token: string) {
		return this.auth.revokeSession(token);
	}
}
