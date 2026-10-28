/**
 * The page the browser tests drive: one repository through the browser
 * host, and the calls a test makes on it, on `globalThis.harness`.
 */
import { Type } from 'typebox';
import { openBrowserRepository, type RepositoryTab, type TabState } from '../src/browser/index.js';
import { lockName } from '../src/browser/messages.js';
import { defineApp } from '../src/define.js';
import { sha256 } from '../src/hash.js';
import type { Repository } from '../src/repository.js';

const app = defineApp({
	notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) },
	photos: { path: 'photos/{stem}.png', blob: { types: ['image/png', 'text/plain'] } },
});
type Defs = typeof app.definitions;

let tab: RepositoryTab<Defs> | null = null;
let name = '';
const writes: Promise<unknown>[] = [];
const opened = new Map<string, Awaited<ReturnType<Repository<Defs>['notes']['open']>>>();
const reads = new Map<string, NonNullable<Awaited<ReturnType<Repository<Defs>['notes']['get']>>>>();
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
/** `size` bytes that differ from one `seed` to the next, so each names its own object. */
const bytesOf = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
/** What a test compares of a blob: its size and oid, which stand for its bytes. */
const summary = async (bytes: Uint8Array | null) => (bytes === null ? null : { size: bytes.length, oid: await sha256(bytes) });
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
	/** Read a note and keep it, as a caller holding what it read; `sendBody` can start from it. */
	async read(stem: string) {
		const note = await current().notes.get({ stem });
		if (note !== null) reads.set(stem, note);
	},
	/** Send a whole-body write from the note `read` kept, or from the server's latest, and answer the verdict as plain data. */
	async sendBody(stem: string, body: string, from: 'read' | 'latest') {
		const read = from === 'read' ? (reads.get(stem) ?? 'latest') : 'latest';
		return plainResult(await current().send((b) => b.notes.write({ stem }, { body }, { from: read })));
	},
	async sendAppend(stem: string, more: string) {
		return plainResult(await current().send((b) => b.notes.append({ stem }, more, { from: 'latest' })));
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
	/** Store a blob of `size` bytes and answer its summary and the outcome, as plain data. */
	async putBlob(stem: string, size: number, seed: number, type = 'image/png') {
		const bytes = bytesOf(size, seed);
		const result = plainResult(await current().photos.put({ stem }, bytes, { type }));
		return { result, blob: await summary(bytes) };
	},
	/** Start a blob put and, in the same task, freeze the page; `settled` awaits it. */
	putBlobThenFreeze(stem: string, size: number, seed: number) {
		writes.push(current().photos.put({ stem }, bytesOf(size, seed), { type: 'image/png' }));
		document.dispatchEvent(new Event('freeze'));
		return writes.length - 1;
	},
	/** The summary of the bytes `putBlob` stores for `size` and `seed`. */
	blobSummary: (size: number, seed: number) => summary(bytesOf(size, seed)),
	blob: async (stem: string) => summary(await current().photos.get({ stem })),
	blobUrl: (stem: string) => current().photos.url({ stem }),
	/** Fetch a blob URL from this page, as an `<img>` would load it. */
	async fetchUrl(url: string) {
		try {
			const response = await fetch(url);
			const bytes = new Uint8Array(await response.arrayBuffer());
			return { fetched: true as const, type: response.headers.get('content-type'), blob: await summary(bytes) };
		} catch {
			return { fetched: false as const };
		}
	},
	/** Run one store check in a worker of its own, against this repository's blob directory. */
	async checkStore(repository: string, check: 'wrong-oid' | 'partial-temp') {
		const worker = new Worker('/blobs.js', { type: 'module' });
		const answered = message(worker);
		worker.postMessage({ name: repository, check });
		const answer = await answered;
		worker.terminate();
		return answer as Record<string, unknown>;
	},
};

export type Harness = typeof api;

declare global {
	var harness: Harness;
}
globalThis.harness = api;
