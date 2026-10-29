/**
 * The page the replica host tests drive: one replica through the browser
 * host, and the calls a test makes on it, on `globalThis.replicas`. Results
 * cross to the test as plain data.
 */
import {
	type BrowserReplicaOptions,
	createBrowserReplica,
	estimateStorage,
	listReplicas,
	openBrowserReplica,
	type ReplicaTab,
	type ReplicaTabState,
	storagePersistence,
	type Syncing,
} from '../src/hosts/browser/index.js';
import { replicaDirectory, replicaLock, replicasDirectory } from '../src/hosts/browser/layout.js';
import { entriesOf } from '../src/hosts/browser/opfs.js';
import { compileTemplate } from '../src/core/templates.js';
import { unwrap } from 'wellcrafted/result';

const NOTES = [
	{
		name: 'notes',
		view: `CREATE TEMP VIEW notes AS SELECT path, text FROM "epicenter/files" WHERE path LIKE 'notes/%' AND text IS NOT NULL`,
		template: unwrap(compileTemplate('notes/{stem}.md')),
		memory: false,
	},
];

let tab: ReplicaTab | null = null;
/** A File read from the replica, kept by the page as an `<img>` would keep it. */
const kept = new Map<string, File>();
let stale: { holder: Worker; releaseLock(): void } | null = null;
/** What a click on `#save` writes. */
let armed: { path: string; text: string } | null = null;
const clicked: Promise<unknown>[] = [];

const state = (): ReplicaTabState => {
	if (tab === null) throw new Error('No replica is open');
	return tab.state();
};
const current = () => {
	const now = state();
	if (now.status !== 'open') throw new Error(`The replica is ${now.status} in this tab`);
	return now.replica;
};

/** Poll `check` until it holds. */
async function until(check: () => Promise<boolean> | boolean, what: string, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const plain = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
const bytesOf = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251);
async function summary(blob: Blob | null) {
	if (blob === null) return null;
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
	return { size: blob.size, oid: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') };
}
const message = (worker: Worker) => new Promise<unknown>((resolve) => worker.addEventListener('message', (event) => resolve(event.data), { once: true }));
const options = (token?: string): BrowserReplicaOptions => ({
	collections: NOTES,
	headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
	worker: () => new Worker('/replica-worker.js', { type: 'module' }),
});

/** Wait until this tab owns the replica, another tab does, or it cannot open; answers which. */
async function settle() {
	await until(() => ['open', 'elsewhere', 'unavailable'].includes(state().status), 'the replica to open');
	const now = state();
	return now.status === 'unavailable' ? { status: now.status, error: now.error.name } : { status: now.status };
}

const api = {
	/** Make a replica of `repository` and open it here; answers its id. */
	async create(repository: string, { token, ...syncing }: Syncing & { token?: string } = { account: null, url: null }) {
		const created = await createBrowserReplica({ owner: null, repository, name: repository, ...syncing, ...options(token) });
		if (created.error !== null) return { error: created.error.name, replica: null };
		tab = created.data;
		await settle();
		return { error: null, replica: tab.replica };
	},
	async open(replica: string, { token }: { token?: string } = {}) {
		tab = openBrowserReplica({ replica, ...options(token) });
		return settle();
	},
	status: () => state().status,
	untilStatus: (status: ReplicaTabState['status'], timeout?: number) => until(() => state().status === status, `the tab to be ${status} (it is ${tab?.state().status})`, timeout),
	useHere() {
		const now = state();
		if (now.status !== 'elsewhere' && now.status !== 'moved') throw new Error(`Use here is not offered while ${now.status}`);
		now.useHere();
	},
	close: () => tab?.close(),
	/** Close the replica and, in the same task, open it again in this page. */
	reopen(replica: string, { token }: { token?: string } = {}) {
		tab?.close();
		tab = openBrowserReplica({ replica, ...options(token) });
		return settle();
	},
	manifest: () => current().manifest,
	write: async (path: string, text: string | null) => plain(await current().change([{ kind: 'write', path, text }])),
	read: (path: string) => current().read(path),
	untilText: (path: string, text: string | null) => until(async () => (await current().read(path)) === text, `${path} to read ${JSON.stringify(text)}`),
	unsent: () => current().unsent(),
	untilSynced: () => until(async () => !(await current().busy()) && (await current().unsent()).length === 0, 'the replica to sync'),
	query: (sql: string) => current().query(sql),
	/** Write and, in the same task, freeze the page, as a browser freezing a background tab right after a keystroke. */
	writeThenFreeze(path: string, text: string) {
		clicked.push(current().change([{ kind: 'write', path, text }]));
		document.dispatchEvent(new Event('freeze'));
		return clicked.length - 1;
	},
	settled: async (index: number) => plain(await clicked[index]),
	resume: () => document.dispatchEvent(new Event('resume')),
	/** Make the next click on `#save` write `text` to `path`, from the click itself. */
	arm(path: string, text: string) {
		armed = { path, text };
	},
	persistence: () => storagePersistence.get(),
	estimate: () => estimateStorage(),
	list: async () => plain(await listReplicas()),
	async remove(discardUnsent = false) {
		return plain(await current().remove({ discardUnsent }));
	},
	/** What the replica's directories hold. */
	async layout(replica: string) {
		const root = await replicaDirectory(replica);
		if (root === null) return null;
		const at = async (name: string) => {
			const entries = await entriesOf(root);
			return entries.some(([entry]) => entry === name) ? (await entriesOf(await root.getDirectoryHandle(name))).map(([entry]) => entry) : null;
		};
		return { root: (await entriesOf(root)).map(([name, kind]) => `${name}${kind === 'directory' ? '/' : ''}`), sqlite: await at('sqlite'), objects: await at('objects') };
	},
	replicaDirectories: async () => (await entriesOf(await replicasDirectory())).map(([name]) => name),
	/**
	 * Cut a removal short, as a tab closed midway would leave it: marked,
	 * its database deleted, its manifest and objects still there.
	 */
	async interruptRemoval(replica: string) {
		const root = await replicaDirectory(replica);
		if (root === null) throw new Error(`No replica ${replica}`);
		await root.getFileHandle('removing', { create: true });
		await root.removeEntry('sqlite', { recursive: true });
	},
	/** Put a file where the replica's `sqlite/` directory goes, so its pool cannot open for a reason waiting will not fix. */
	async breakDatabase(replica: string) {
		const root = await replicaDirectory(replica);
		if (root === null) throw new Error(`No replica ${replica}`);
		await root.removeEntry('sqlite', { recursive: true });
		await root.getFileHandle('sqlite', { create: true });
	},
	async seal(size: number, seed: number) {
		const result = plain(await current().seal(new Blob([bytesOf(size, seed)])));
		return { result, expected: await summary(new Blob([bytesOf(size, seed)])) };
	},
	blob: async (oid: string) => summary(await current().blob(oid)),
	/** Read a blob as a File and keep it in the page. */
	async keep(oid: string) {
		const file = await current().blob(oid);
		if (file === null) return false;
		kept.set(oid, file);
		return true;
	},
	/** Read a kept File now, through an object URL as an `<img>` would, and directly. */
	async readKept(oid: string) {
		const file = kept.get(oid);
		if (file === undefined) return null;
		const url = URL.createObjectURL(file);
		try {
			const fetched = await (await fetch(url)).blob();
			return { direct: await summary(file), viaUrl: await summary(fetched) };
		} finally {
			URL.revokeObjectURL(url);
		}
	},
	/** Run the blob store's conformance checks against OPFS, in a worker of their own. */
	async checkObjects() {
		const worker = new Worker('/objects.js', { type: 'module' });
		const answered = message(worker);
		worker.postMessage('run');
		const results = (await answered) as Record<string, string>;
		worker.terminate();
		return results;
	},
	/**
	 * Hold the replica's lock and its database without opening it, as a
	 * frozen owner tab whose worker has not let go.
	 */
	async holdAsStaleOwner(replica: string) {
		const holder = new Worker('/replica-holder.js', { type: 'module' });
		const held = message(holder);
		holder.postMessage({ type: 'hold', replica });
		await held;
		let releaseLock = () => {};
		await new Promise<void>((resolve) => {
			// A steal rejects this request; the holder keeps the storage regardless.
			navigator.locks
				.request(replicaLock(replica), () => {
					resolve();
					return new Promise<void>((release) => {
						releaseLock = release;
					});
				})
				.catch(() => {});
		});
		stale = { holder, releaseLock };
	},
	async releaseStorage() {
		if (stale === null) return;
		const released = message(stale.holder);
		stale.holder.postMessage({ type: 'release' });
		await released;
		stale.releaseLock();
	},
	/** Wait until no tab of this origin holds the replica's lock. */
	untilReleased: (replica: string) =>
		until(async () => ((await navigator.locks.query()).held ?? []).every((lock) => lock.name !== replicaLock(replica)), 'the lock to be released'),
};

const button = document.createElement('button');
button.id = 'save';
button.textContent = 'Save';
button.addEventListener('click', () => {
	if (armed !== null) clicked.push(current().change([{ kind: 'write', path: armed.path, text: armed.text }]));
});
document.body.append(button);

export type ReplicaHarness = typeof api;

declare global {
	var replicas: ReplicaHarness;
}
globalThis.replicas = api;
