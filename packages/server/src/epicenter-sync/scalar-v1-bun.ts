import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
	SCALAR_SYNC_V1_LIMITS,
	SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Hono, MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import { mountScalarV1App } from './scalar-v1-route.js';

function encodePathComponent(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

function authorityPath(dir: string, principalId: PrincipalId): string {
	const principalDir = join(
		dir,
		'principals',
		encodePathComponent(principalId),
	);
	mkdirSync(principalDir, { recursive: true });
	return join(principalDir, 'data-v1.sqlite');
}

/** Open a principal-partitioned Bun owner for one Data V1 authority file. */
export function createBunScalarV1Runtime({ dir }: { dir: string }) {
	mkdirSync(dir, { recursive: true });
	const authorities = new Map<
		PrincipalId,
		{ raw: Database; authority: DataAuthorityV1 }
	>();
	let closed = false;

	function load(principalId: PrincipalId): DataAuthorityV1 {
		if (closed) throw new Error('Bun scalar V1 runtime is closed');
		const existing = authorities.get(principalId);
		if (existing !== undefined) return existing.authority;

		const raw = new Database(authorityPath(dir, principalId), {
			create: true,
			strict: true,
		});
		try {
			raw.run('PRAGMA journal_mode = WAL');
			const authority = openScalarAuthorityV1({
				database: createBunSqliteAdapter(raw),
				limits: SCALAR_SYNC_V1_LIMITS,
				initialize: { authorityLifetime: crypto.randomUUID() },
			});
			authorities.set(principalId, { raw, authority });
			return authority;
		} catch (cause) {
			raw.close();
			throw cause;
		}
	}

	return {
		locateAuthority: load,
		close(): void {
			if (closed) return;
			closed = true;
			for (const opened of authorities.values()) opened.raw.close();
			authorities.clear();
		},
	};
}

export type BunScalarV1Runtime = ReturnType<typeof createBunScalarV1Runtime>;

/** Mount the two authenticated scalar V1 routes on a Bun deployment. */
export function mountBunScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		runtime,
	}: { auth: MiddlewareHandler<E>; runtime: BunScalarV1Runtime },
): void {
	mountScalarV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		rawSubmissionBytes: SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
		locateAuthority: runtime.locateAuthority,
	});
}
