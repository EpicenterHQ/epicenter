/**
 * The page the browser tests drive: one repository through the browser
 * host, and the calls a test makes on it, on `globalThis.harness`.
 */
import { Type } from 'typebox';
import { openBrowserRepository } from '../src/browser/index.js';
import { channelName, lockName } from '../src/browser/messages.js';
import { defineApp, type Settled } from '../src/define.js';
import type { Repository } from '../src/repository.js';

const app = defineApp({
	notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) },
});

let repo: Repository<typeof app.definitions> | null = null;
let name = '';
const writes: Promise<unknown>[] = [];
const opened = new Map<string, Awaited<ReturnType<Repository<typeof app.definitions>['notes']['open']>>>();

const current = () => {
	if (repo === null) throw new Error('No repository is open');
	return repo;
};

/** Poll `check` until it holds. */
async function until(check: () => Promise<boolean> | boolean, what: string, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const text = async (stem: string) => (await current().notes.get({ stem }))?.text ?? null;

const api = {
	async open(repository: string, server?: string) {
		name = repository;
		const result = await openBrowserRepository({
			app,
			name,
			server: server === undefined ? undefined : { url: server },
			worker: () => new Worker('/worker.js', { type: 'module' }),
		});
		if (result.error !== null) throw new Error(result.error.message);
		repo = result.data;
	},
	/** Start a write and return its index; `settled` awaits it. The write is applied locally when this returns. */
	async write(stem: string, body: string) {
		writes.push(current().notes.write({ stem }, { body }));
		await current().flush();
		return writes.length - 1;
	},
	async append(stem: string, more: string, { wait = true } = {}) {
		writes.push(current().notes.append({ stem }, more));
		if (wait) await current().flush();
		return writes.length - 1;
	},
	async setTitle(stem: string, title: string) {
		writes.push(current().notes.set({ stem }, 'title', title));
		await current().flush();
	},
	query: (sql: string) => current().query(sql),
	settled: async (index: number) => (await writes[index]) as { data: Settled | null; error: unknown },
	text,
	untilText: (stem: string, expected: string | null) => until(async () => (await text(stem)) === expected, `${stem} to read ${JSON.stringify(expected)}`),
	unsent: async () =>
		(await current().query<{ n: number }>('SELECT count(*) AS n FROM "epicenter/outbox" WHERE outcome IS NULL'))[0]?.n,
	async hold(stem: string) {
		opened.set(stem, await current().notes.open({ stem }));
	},
	heldText: (stem: string) => opened.get(stem)?.read()?.text ?? null,
	untilHeld: (stem: string, expected: string | null) =>
		until(() => (opened.get(stem)?.read()?.text ?? null) === expected, `the open ${stem} to read ${JSON.stringify(expected)}`),
	/** How many tabs hold and wait for this repository's lock. */
	async locks() {
		const state = await navigator.locks.query();
		const ours = (locks: LockInfo[] | undefined) => (locks ?? []).filter((lock) => lock.name === lockName(name)).length;
		return { held: ours(state.held), pending: ours(state.pending) };
	},
	dropSubmitAnswers() {
		new BroadcastChannel(channelName(name)).postMessage({ type: 'test:drop-submit-answers' });
	},
	flush: () => current().flush(),
};

export type Harness = typeof api;

declare global {
	var harness: Harness;
}
globalThis.harness = api;
