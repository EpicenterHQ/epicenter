/**
 * The page under test: the real browser binding, nothing simulated.
 *
 * It exposes the binding's own verbs on `globalThis` so the harness can drive
 * them from outside the page and the page holds no assertions of its own.
 */

import { asPrincipalId } from '@epicenter/principal';
import { claimApp } from '../../../src/app-claim.js';
import { createBrowserSqliteOwner } from '../../../src/browser.js';
import { createAppSqlite, type SqliteLifetime } from '../../../src/owner.js';

let workersStarted = 0;
const BrowserWorker = globalThis.Worker;
globalThis.Worker = class extends BrowserWorker {
	constructor(...args: ConstructorParameters<typeof BrowserWorker>) {
		super(...args);
		workersStarted++;
	}
};

const parameters = new URL(location.href).searchParams;
const APP_ID = parameters.get('appId') ?? 'so.epicenter.evidence';
const person = parameters.get('person');
const account =
	person === null
		? undefined
		: {
				authorityId: parameters.get('authority') ?? 'evidence',
				principalId: asPrincipalId(person),
			};
const owner = createBrowserSqliteOwner();
// This standalone SQL fixture owns the same admission boundary as an App.
function openStorage(appId: string) {
	const sqlite = createAppSqlite(owner, appId, { account });
	let admission: ReturnType<typeof claimApp> | undefined;
	const acquire = () => (admission ??= claimApp(appId, account));
	return {
		value: {
			async open(name: string) {
				const claim = await acquire();
				return claim.error ? claim : sqlite.value.open(name);
			},
			async delete(name: string) {
				const claim = await acquire();
				return claim.error ? claim : sqlite.value.delete(name);
			},
		},
		async close() {
			await sqlite.close();
			if (admission) (await admission).data?.release();
		},
	};
}
let storage = openStorage(APP_ID);
const otherStorage = openStorage('so.epicenter.other-evidence');
let rawStorage: SqliteLifetime | undefined;

type Answer =
	| { ok: true; value?: unknown }
	| { ok: false; error: string; errorName?: string };

async function attempt(run: () => Promise<Answer>): Promise<Answer> {
	try {
		return await run();
	} catch (cause) {
		return {
			ok: false,
			error: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

Object.assign(globalThis, {
	// Deliberately bypass the page's Web Lock to test real VFS contention and
	// retry, rather than stopping at the cooperative claim layer.
	async rawOpen(): Promise<Answer> {
		return attempt(async () => {
			rawStorage = await owner.acquire(APP_ID, account);
			const database = await rawStorage.open('local');
			const result = await database.all('SELECT 1');
			return result.error
				? { ok: false, error: result.error.message }
				: { ok: true };
		});
	},
	async rawClose(): Promise<Answer> {
		return attempt(async () => {
			await rawStorage?.close();
			rawStorage = undefined;
			return { ok: true };
		});
	},
	async closeStorage(): Promise<Answer> {
		return attempt(async () => {
			await storage.close();
			return { ok: true };
		});
	},
	resetStorage() {
		storage = openStorage(APP_ID);
	},
	workerCount() {
		return workersStarted;
	},
	async closeAndReopen(): Promise<Answer> {
		return attempt(async () => {
			const retained = await storage.value.open('local');
			if (retained.error) return { ok: false, error: retained.error.message };
			await storage.close();
			const stale = await retained.data.all('SELECT 1');
			if (!stale.error)
				return { ok: false, error: 'Closed connection accepted a statement.' };
			storage = openStorage(APP_ID);
			const reopened = await storage.value.open('local');
			return reopened.error
				? { ok: false, error: reopened.error.message }
				: { ok: true };
		});
	},
	async duplicateOwner(): Promise<Answer> {
		const duplicate = openStorage(APP_ID);
		const result = await duplicate.value.open('local');
		await duplicate.close();
		return result.error
			? { ok: true }
			: { ok: false, error: 'Duplicate lifetime opened.' };
	},
	async otherApp(sql: string): Promise<Answer> {
		return attempt(async () => {
			const opened = await otherStorage.value.open('local');
			if (opened.error !== null)
				return {
					ok: false,
					error: opened.error.message,
					errorName: opened.error.name,
				};
			const result = await opened.data.all(sql);
			return result.error === null
				? { ok: true, value: result.data }
				: { ok: false, error: result.error.message };
		});
	},
	async run(
		name: string,
		sql: string,
		parameters: unknown[] = [],
	): Promise<Answer> {
		return attempt(async () => {
			const opened = await storage.value.open(name);
			if (opened.error !== null)
				return {
					ok: false,
					error: opened.error.message,
					errorName: opened.error.name,
				};
			const result = await opened.data.run(sql, parameters as never);
			return result.error === null
				? { ok: true, value: result.data }
				: { ok: false, error: result.error.message };
		});
	},
	async all(
		name: string,
		sql: string,
		parameters: unknown[] = [],
	): Promise<Answer> {
		return attempt(async () => {
			const opened = await storage.value.open(name);
			if (opened.error !== null)
				return {
					ok: false,
					error: opened.error.message,
					errorName: opened.error.name,
				};
			const result = await opened.data.all(sql, parameters as never);
			return result.error === null
				? { ok: true, value: result.data }
				: { ok: false, error: result.error.message };
		});
	},
	async batch(
		name: string,
		statements: { sql: string; parameters?: unknown[] }[],
	): Promise<Answer> {
		return attempt(async () => {
			const opened = await storage.value.open(name);
			if (opened.error !== null)
				return {
					ok: false,
					error: opened.error.message,
					errorName: opened.error.name,
				};
			const result = await opened.data.batch(statements as never);
			return result.error === null
				? { ok: true, value: result.data }
				: { ok: false, error: result.error.message };
		});
	},
	async remove(name: string): Promise<Answer> {
		return attempt(async () => {
			const retained = await storage.value.open(name);
			if (retained.error) return { ok: false, error: retained.error.message };
			const gone = await storage.value.delete(name);
			if (!gone.error && !(await retained.data.all('SELECT 1')).error)
				return { ok: false, error: 'Deleted handle accepted a statement.' };
			return gone.error === null
				? { ok: true }
				: { ok: false, error: gone.error.message };
		});
	},
});
