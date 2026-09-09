/**
 * The page under test: the real browser binding, nothing simulated.
 *
 * It exposes the binding's own verbs on `globalThis` so the harness can drive
 * them from outside the page and the page holds no assertions of its own.
 */

import { createBrowserDevice } from '../../../src/browser.js';

const APP_ID = 'so.epicenter.evidence';
const storage = createBrowserDevice({ appId: APP_ID });
const otherStorage = createBrowserDevice({
	appId: 'so.epicenter.other-evidence',
});

type Answer = { ok: true; value?: unknown } | { ok: false; error: string };

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
	async otherApp(sql: string): Promise<Answer> {
		return attempt(async () => {
			const opened = await otherStorage.sqlite.open('local');
			if (opened.error !== null)
				return { ok: false, error: opened.error.message };
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
			const opened = await storage.sqlite.open(name);
			if (opened.error !== null)
				return { ok: false, error: opened.error.message };
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
			const opened = await storage.sqlite.open(name);
			if (opened.error !== null)
				return { ok: false, error: opened.error.message };
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
			const opened = await storage.sqlite.open(name);
			if (opened.error !== null)
				return { ok: false, error: opened.error.message };
			const result = await opened.data.batch(statements as never);
			return result.error === null
				? { ok: true, value: result.data }
				: { ok: false, error: result.error.message };
		});
	},
	async remove(name: string): Promise<Answer> {
		return attempt(async () => {
			const gone = await storage.sqlite.delete(name);
			return gone.error === null
				? { ok: true }
				: { ok: false, error: gone.error.message };
		});
	},
});
