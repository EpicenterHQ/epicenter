/**
 * The page under test: the real browser binding, nothing simulated.
 *
 * It exposes the binding's own verbs on `globalThis` so the harness can drive
 * them from outside the page and the page holds no assertions of its own.
 */

import { asPrincipalId } from '@epicenter/principal';
import { createBrowserSqliteOwner } from '../../../src/browser.js';
import type { SqliteLifetime } from '../../../src/owner.js';

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
function openStorage(id: string) {
	return owner.acquire(id, account);
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
			errorName:
				typeof cause === 'object' && cause !== null && 'name' in cause
					? String(cause.name)
					: undefined,
		};
	}
}

Object.assign(globalThis, {
	// Deliberately bypass the page's Web Lock to test real VFS contention and
	// retry, rather than stopping at the cooperative claim layer.
	async rawOpen(): Promise<Answer> {
		return attempt(async () => {
			await (await storage).close();
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
			await (await storage).close();
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
			const retained = await (await storage).open('local');
			await (await storage).close();
			const stale = await retained.all('SELECT 1');
			if (!stale.error)
				return { ok: false, error: 'Closed connection accepted a statement.' };
			storage = openStorage(APP_ID);
			await (await storage).open('local');
			return { ok: true };
		});
	},
	async duplicateOwner(): Promise<Answer> {
		try {
			const duplicate = await openStorage(APP_ID);
			await duplicate.close();
			return { ok: false, error: 'Duplicate lifetime opened.' };
		} catch {
			return { ok: true };
		}
	},
	async otherApp(sql: string): Promise<Answer> {
		return attempt(async () => {
			const opened = await (await otherStorage).open('local');
			const result = await opened.all(sql);
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
			const opened = await (await storage).open(name);
			const result = await opened.run(sql, parameters as never);
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
			const opened = await (await storage).open(name);
			const result = await opened.all(sql, parameters as never);
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
			const opened = await (await storage).open(name);
			const result = await opened.batch(statements as never);
			return result.error === null
				? { ok: true, value: result.data }
				: { ok: false, error: result.error.message };
		});
	},
	async remove(name: string): Promise<Answer> {
		return attempt(async () => {
			const retained = await (await storage).open(name);
			await (await storage).delete(name);
			if (!(await retained.all('SELECT 1')).error)
				return { ok: false, error: 'Deleted handle accepted a statement.' };
			return { ok: true };
		});
	},
});
