/**
 * The page the browser tests drive: one repository through the browser
 * host, and the calls a test makes on it, on `globalThis.harness`.
 */
import { Type } from 'typebox';
import { openBrowserRepository, type RepositoryTab, type TabState } from '../src/browser/index.js';
import { lockName } from '../src/browser/messages.js';
import { defineApp } from '../src/define.js';
import type { Repository } from '../src/repository.js';

const app = defineApp({
	notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) },
});
type Defs = typeof app.definitions;

let tab: RepositoryTab<Defs> | null = null;
let name = '';
const writes: Promise<unknown>[] = [];
const opened = new Map<string, Awaited<ReturnType<Repository<Defs>['notes']['open']>>>();
/** What stands in for an old owner tab that has not let go: its lock request and a worker holding the storage. */
let stale: { holder: Worker; releaseLock(): void } | null = null;

const state = (): TabState<Defs> => {
	if (tab === null) throw new Error('No repository is open');
	return tab.state();
};
const current = () => {
	const now = state();
	if (now.status !== 'open') throw new Error(`The repository is ${now.status} in this tab`);
	return now.repository;
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
const untilStatus = (status: TabState<Defs>['status'], timeout?: number) =>
	until(() => state().status === status, `the tab to be ${status} (it is ${tab?.state().status})`, timeout);
const message = (worker: Worker) => new Promise((resolve) => worker.addEventListener('message', (event) => resolve(event.data), { once: true }));
const plainResult = <T>(result: T) => JSON.parse(JSON.stringify(result)) as T;
const heldLocks = async () => ((await navigator.locks.query()).held ?? []).filter((lock) => lock.name === lockName(name)).length;

const api = {
	/** Open the repository and wait until this tab owns it or another tab does. */
	async open(repository: string, server?: string) {
		name = repository;
		tab = openBrowserRepository({
			app,
			name,
			server: server === undefined ? undefined : { url: server },
			worker: () => new Worker('/worker.js', { type: 'module' }),
		});
		await until(() => ['open', 'elsewhere', 'unavailable'].includes(state().status), 'the repository to open');
		const now = state();
		if (now.status === 'unavailable') throw new Error(now.error.message);
		return now.status;
	},
	status: () => state().status,
	untilStatus,
	useHere() {
		const now = state();
		if (now.status !== 'elsewhere' && now.status !== 'moved') throw new Error(`Use here is not offered while ${now.status}`);
		now.useHere();
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
	/** Write and, in the same task, freeze the page, as a browser freezing a background tab right after a keystroke. */
	writeThenFreeze(stem: string, body: string) {
		writes.push(current().notes.write({ stem }, { body }));
		document.dispatchEvent(new Event('freeze'));
	},
	resume: () => document.dispatchEvent(new Event('resume')),
	/** The server version of the note as this tab shows it. */
	version: async (stem: string) => (await current().notes.get({ stem }))?.version ?? null,
	/** Send a whole-body write, from `base` if given, and answer the verdict as plain data. */
	async sendBody(stem: string, body: string, base?: string | null) {
		return plainResult(await current().send((b) => b.notes.write({ stem }, { body }, { base })));
	},
	async sendAppend(stem: string, more: string) {
		return plainResult(await current().send((b) => b.notes.append({ stem }, more)));
	},
	query: (sql: string) => current().query(sql),
	/** Run a read and say whether it ran or was refused, as plain data. */
	async tryQuery(sql: string): Promise<{ ran: true; rows: number } | { ran: false; reason: string }> {
		try {
			return { ran: true, rows: (await current().query(sql)).length };
		} catch (cause) {
			return { ran: false, reason: String(cause) };
		}
	},
	settled: async (index: number) => (await writes[index]) as { data: undefined; error: { name: string } | null },
	text,
	untilText: (stem: string, expected: string | null) => until(async () => (await text(stem)) === expected, `${stem} to read ${JSON.stringify(expected)}`),
	unsent: async () => (await current().query<{ n: number }>('SELECT count(*) AS n FROM "epicenter/outbox"'))[0]?.n,
	async hold(stem: string) {
		opened.set(stem, await current().notes.open({ stem }));
	},
	heldText: (stem: string) => opened.get(stem)?.read()?.text ?? null,
	/** Wait until no tab of this origin holds the repository's lock. */
	untilReleased: () => until(async () => (await heldLocks()) === 0, 'the lock to be released'),
	/**
	 * Hold the repository's lock and its storage without opening it, as a
	 * frozen owner tab whose worker has not let go. `name` is the repository.
	 */
	async holdAsStaleOwner(repository: string) {
		name = repository;
		const holder = new Worker('/holder.js', { type: 'module' });
		const held = message(holder);
		holder.postMessage({ type: 'hold', name });
		await held;
		let releaseLock = () => {};
		const locked = new Promise<void>((resolve) => {
			// A steal rejects this request; the holder keeps the storage regardless.
			navigator.locks
				.request(lockName(name), () => {
					resolve();
					return new Promise<void>((release) => {
						releaseLock = release;
					});
				})
				.catch(() => {});
		});
		await locked;
		stale = { holder, releaseLock };
	},
	async releaseStorage() {
		if (stale === null) return;
		const released = message(stale.holder);
		stale.holder.postMessage({ type: 'release' });
		await released;
		stale.releaseLock();
	},
	flush: () => current().flush(),
};

export type Harness = typeof api;

declare global {
	var harness: Harness;
}
globalThis.harness = api;
