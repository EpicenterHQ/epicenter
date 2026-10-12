/**
 * Automatic Commit Request Tests
 *
 * Each save this handle published asks for an automatic commit. Requests not yet answered are one obligation, carried by at most
 * one worker that waits for the backend's protection. These tests pin what
 * that promises and what it does not.
 *
 * Key behaviors:
 * - One published save makes one commit; its subject and count come from the
 *   committed tree
 * - Held protection (another tab's Web Lock, this handle's pull, path
 *   listing, or running commit) delays the request: once it frees, one
 *   checkpoint commits the latest files without another save, however many
 *   saves asked meanwhile, and at most one wait is outstanding
 * - A whole-folder checkpoint answers every request made before it started;
 *   an automatic one left with nothing to answer records nothing
 * - A write nobody published through this handle, and `noteEdit` alone, ask
 *   for nothing
 * - A failed checkpoint, or a refused request to enter the protection,
 *   records the error and is not retried; a newer save asks again
 * - Automatic commits and `commit()` stay local; a caller that stopped waiting
 *   on `commitAndPush` starts no push later
 * - Closing refuses a request still waiting for the protection without moving
 *   the branch, waits for work already inside it, and makes no last commit
 * - Two tabs, real Git locks, and many callers leave a branch that only ever
 *   moved by compare-and-swap
 *
 * See also:
 * - `history-ordering.test.ts` for capture ordering inside the Git lock
 * - `native-safety.test.ts` and `browser.test.ts` for partial and refused saves
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	rawBrowserFolder,
	type TestStorage,
} from '../browser-storage.test-support.js';
import { hashBytes } from '../capture.js';
import { defineFolder, field } from '../contract.js';
import { openNativeFolder } from '../directory.test-support.js';
import { GIT_ENV, git, scratch } from '../git-http.test-support.js';
import type { OpfsLocks } from '../opfs-store.js';
import { installWebLocks, useWebLocks } from '../web-locks.test-support.js';
import type { GitBackend } from './backend.js';
import { createHistory } from './history.js';
import { commitTree, readBlob, readTreeFiles } from './objects.js';

const author = { name: 'History', email: 'history@example.test' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {},
});

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function until(condition: () => boolean) {
	for (let index = 0; index < 200 && !condition(); index++) await Bun.sleep(2);
	expect(condition()).toBe(true);
}

/**
 * One browser tab's history over the shared store named `name`.
 * `probe.hold` stops the next commit after it captured and wrote its commit,
 * just before the branch moves. `holds` stop the named backend call.
 */
async function tab(environment: TestStorage, name: string) {
	const raw = await rawBrowserFolder({ id: name, storage: environment });
	const base = raw.boundary;
	const holds: {
		pathStatus?: ReturnType<typeof gate>;
		readRemoteTracking?: ReturnType<typeof gate>;
		/** Holds a capture after it read the folder, before it returns. */
		captured?: ReturnType<typeof gate>;
		/** Holds a push or fetch inside its transport. */
		transport?: ReturnType<typeof gate>;
	} = {};
	const entered = gate();
	async function heldAt(key: keyof typeof holds) {
		const hold = holds[key];
		holds[key] = undefined;
		if (hold === undefined) return;
		entered.open();
		await hold.opened;
	}
	const real = await raw.backend();
	const probe = {
		/** Requests to enter the protection, by any operation of this handle. */
		admissions: 0,
		/** Those still waiting to enter, and the most that ever waited at once. */
		waiting: 0,
		mostWaiting: 0,
		/** Refuses the next request to enter, as a failing lock manager would. */
		refuseNext: undefined as Error | undefined,
		/**
		 * Runs once when an automatic request enters and finds nothing left to
		 * answer, after its work returned and before the worker resumes.
		 */
		onAnswered: undefined as (() => void) | undefined,
		/** Commits that reached the branch compare-and-swap. */
		publications: 0,
		pushes: 0,
		fetches: 0,
		/** Fail the next capture after its optional hold. */
		failCaptureNext: false,
		/** Whole-folder reads, by a scan or a commit. */
		captures: 0,
		/** Object-store sessions opened, by a scan or a commit. */
		objectSessions: 0,
		/** What the remote holds, as the tracking ref would record it. */
		remoteHead: undefined as string | undefined,
		offline: false,
		hold: undefined as ReturnType<typeof gate> | undefined,
		reached: gate(),
	};
	const boundary: typeof base = {
		...base,
		async capture() {
			probe.captures++;
			const captured = await base.capture();
			await heldAt('captured');
			if (probe.failCaptureNext) {
				probe.failCaptureNext = false;
				throw new Error('Controlled capture failure');
			}
			return captured;
		},
	};
	const backend: GitBackend = {
		...real,
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		async exclusive(work, signal) {
			probe.admissions++;
			const refused = probe.refuseNext;
			probe.refuseNext = undefined;
			if (refused !== undefined) throw refused;
			probe.waiting++;
			probe.mostWaiting = Math.max(probe.mostWaiting, probe.waiting);
			let entered = false;
			try {
				const value = await real.exclusive(() => {
					entered = true;
					probe.waiting--;
					return work();
				}, signal);
				// Only an automatic request with nothing to answer returns nothing.
				const answered = probe.onAnswered;
				if (value === undefined && answered !== undefined) {
					probe.onAnswered = undefined;
					answered();
				}
				return value;
			} finally {
				if (!entered) probe.waiting--;
			}
		},
		withObjects(work) {
			probe.objectSessions++;
			return real.withObjects(work);
		},
		async fetch() {
			probe.fetches++;
			await heldAt('transport');
			return probe.remoteHead;
		},
		async readRemoteTracking() {
			await heldAt('readRemoteTracking');
			return probe.remoteHead;
		},
		async pathStatus() {
			await heldAt('pathStatus');
			return real.pathStatus();
		},
		async push(oid) {
			probe.pushes++;
			await heldAt('transport');
			if (probe.offline) throw new Error('offline');
			probe.remoteHead = oid;
		},
		async casBranch(expected, next) {
			probe.publications++;
			const hold = probe.hold;
			probe.hold = undefined;
			if (hold !== undefined) {
				probe.reached.open();
				await hold.opened;
			}
			return real.casBranch(expected, next);
		},
	};
	const history = createHistory({ backend, boundary, author });
	async function land(path: string, text: string) {
		const bytes = encoder.encode(text);
		const { error: applyError } = await boundary.apply([
			{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
		]);
		expect(applyError).toBeNull();
	}
	/** A complete save as the folder publishes it: land, note, one request. */
	async function save(path: string, text: string) {
		await land(path, text);
		history.noteEdit();
		history.requestAutomaticCommit();
	}
	/** Wait until no commit or push of this handle is in flight. */
	async function idle() {
		await Bun.sleep(0);
		await until(
			() =>
				!history.snapshot.activity.commit.active &&
				!history.snapshot.activity.push.active,
		);
	}
	/** The committed files at the branch head, as text. */
	async function committed() {
		const head = await real.readBranch();
		if (head === undefined) return {};
		return real.withObjects(async (access) => {
			const files = await readTreeFiles(access, await commitTree(access, head));
			const entries: [string, string][] = [];
			for (const [path, file] of files)
				entries.push([path, decoder.decode(await readBlob(access, file.oid))]);
			return Object.fromEntries(entries);
		});
	}
	/** The saved files in the folder, as text. */
	async function saved() {
		const captured = expectOk(await base.capture());
		return Object.fromEntries(
			[...captured.files].map(([path, bytes]) => [path, decoder.decode(bytes)]),
		);
	}
	return {
		real,
		history,
		probe,
		holds,
		entered: entered.opened,
		land,
		save,
		idle,
		committed,
		saved,
	};
}

// Automatic commits need the shared lock; this runtime has none of its own.
useWebLocks();

// ============================================================================
// One request per published save
// ============================================================================

test('a published save makes one commit of the folder with a subject from the committed tree', async () => {
	const { history, probe, save, idle, committed } = await tab(
		createTestStorage(),
		'one-attempt',
	);
	await save('a.txt', 'one');
	// The save returned; its request is in flight.
	expect(history.snapshot.activity.commit).toEqual({ active: true });
	await idle();
	expect(probe.admissions).toBe(1);
	expect(probe.publications).toBe(1);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add a.txt',
		changedPaths: 1,
	});
	expect(await committed()).toEqual({ 'a.txt': 'one' });
	// A configured remote never makes a save upload.
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();

	// Nothing else happens until the next save.
	await Bun.sleep(30);
	expect(probe.admissions).toBe(1);
	await history.close();
});

test('a write this handle did not publish, and a noted edit alone, ask for nothing', async () => {
	const environment = createTestStorage();
	const mine = await tab(environment, 'external');
	const other = await tab(environment, 'external');
	// Another tab writes to the shared store; this handle only hears a hint.
	await other.land('a.txt', 'from another tab');
	// A partial publication notes the edit and asks for nothing.
	mine.history.noteEdit();
	await Bun.sleep(30);
	expect(mine.probe.admissions).toBe(0);
	expect(mine.history.snapshot.lastCommit).toBeUndefined();
	expect(await mine.committed()).toEqual({});

	// The next save this handle publishes commits the folder as it is.
	await mine.save('b.txt', 'mine');
	await mine.idle();
	expect(mine.history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
	});
	await mine.history.close();
	await other.history.close();
});

// ============================================================================
// Held protection: one request waits and commits the latest files
// ============================================================================

test("saves during this handle's held commit are committed by one following checkpoint, without another save", async () => {
	const { history, probe, save, idle, committed, saved } = await tab(
		createTestStorage(),
		'held-own',
	);
	const held = gate();
	probe.hold = held;
	await save('a.txt', 'one');
	await probe.reached.opened;

	// The held commit already captured `one`. These saves only renumber the
	// one request: no second wait starts while the first commit runs.
	await save('a.txt', 'two');
	await save('b.txt', 'new');
	await save('a.txt', 'three');
	expect(probe.admissions).toBe(1);
	held.open();
	await idle();
	expect(probe.admissions).toBe(2);
	expect(probe.mostWaiting).toBe(1);
	expect(probe.publications).toBe(2);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
	});
	const latest = { 'a.txt': 'three', 'b.txt': 'new' };
	expect(await committed()).toEqual(latest);
	expect(await saved()).toEqual(latest);
	expect(history.snapshot.files).toMatchObject({
		state: 'observed',
		stale: false,
	});

	// Every request was answered; nothing runs on its own afterward.
	await Bun.sleep(30);
	expect(probe.admissions).toBe(2);
	expect(probe.pushes).toBe(0);
	await history.close();
});

test('a save during a failing capture requests one later pass, and the failure alone requests nothing', async () => {
	const { history, probe, holds, save, idle, committed } = await tab(
		createTestStorage(),
		'failed-capture',
	);
	const captured = gate();
	holds.captured = captured;
	probe.failCaptureNext = true;
	await save('a.txt', 'one');
	await until(() => holds.captured === undefined);
	await save('a.txt', 'two');
	const outcomes: string[] = [];
	const unsubscribe = history.subscribe((snapshot) => {
		const status = snapshot.lastCommit?.status;
		if (status && outcomes.at(-1) !== status) outcomes.push(status);
	});
	captured.open();
	await idle();
	expect(outcomes).toEqual(['failed', 'committed']);
	expect(probe.admissions).toBe(2);
	expect(await committed()).toEqual({ 'a.txt': 'two' });

	probe.failCaptureNext = true;
	await save('a.txt', 'three');
	await idle();
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'failed',
		error: 'Controlled capture failure',
	});
	await Bun.sleep(30);
	expect(probe.admissions).toBe(3);
	expect(await committed()).toEqual({ 'a.txt': 'two' });
	unsubscribe();
	await history.close();
});

test('while another tab holds the Web Lock, repeated saves wait as one request and commit the latest files once it frees', async () => {
	const restore = installWebLocks();
	try {
		const environment = createTestStorage();
		const a = await tab(environment, 'locked-tabs');
		const b = await tab(environment, 'locked-tabs');
		const held = gate();
		a.probe.hold = held;
		await a.save('a.txt', 'from a');
		await a.probe.reached.opened;

		await b.save('b.txt', 'one');
		await b.save('b.txt', 'two');
		await b.save('c.txt', 'last');
		await Bun.sleep(20);
		// One wait for the lock, and nothing recorded while it waits.
		expect(b.probe.admissions).toBe(1);
		expect(b.probe.mostWaiting).toBe(1);
		expect(b.history.snapshot.activity.commit).toEqual({ active: true });
		expect(b.history.snapshot.lastCommit).toBeUndefined();

		held.open();
		await a.idle();
		const first = a.history.snapshot.lastCommit;
		expect(first).toMatchObject({ status: 'committed', message: 'Add a.txt' });
		// Tab B's request runs when the lock frees, on top of tab A's commit.
		await b.idle();
		expect(b.probe.publications).toBe(1);
		expect(b.history.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Update 2 files',
			parent: first?.status === 'committed' ? first.oid : undefined,
		});
		expect(await b.committed()).toEqual({
			'a.txt': 'from a',
			'b.txt': 'two',
			'c.txt': 'last',
		});
		await Bun.sleep(30);
		expect(b.probe.admissions).toBe(1);
		expect(b.probe.pushes).toBe(0);
		expect(b.history.snapshot.lastPush).toBeUndefined();
		await a.history.close();
		await b.history.close();
	} finally {
		restore();
	}
});

test("a save during this handle's held pull or path listing is committed once that work ends", async () => {
	const restore = installWebLocks();
	try {
		const { history, probe, holds, entered, save, idle, committed } = await tab(
			createTestStorage(),
			'own-lock',
		);

		// A pull holds the protection while it reads the fetched head.
		const pulling = gate();
		holds.readRemoteTracking = pulling;
		const pull = history.pullFastForward();
		await entered;
		await save('a.txt', 'one');
		await Bun.sleep(10);
		expect(probe.publications).toBe(0);
		expect(history.snapshot.lastCommit).toBeUndefined();
		pulling.open();
		expect(expectErr(await pull).name).toBe('NoFetchedHead');
		await idle();
		expect(probe.publications).toBe(1);
		expect(history.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add a.txt',
		});
		expect(await committed()).toEqual({ 'a.txt': 'one' });

		// So does an explicit path listing.
		const listing = gate();
		holds.pathStatus = listing;
		const paths = history.paths();
		await until(() => holds.pathStatus === undefined);
		await save('a.txt', 'two');
		await Bun.sleep(10);
		expect(probe.publications).toBe(1);
		listing.open();
		expectOk(await paths);
		await idle();
		expect(probe.publications).toBe(2);
		expect(history.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Update a.txt',
		});
		expect(await committed()).toEqual({ 'a.txt': 'two' });
		await history.close();
	} finally {
		restore();
	}
});

// ============================================================================
// Explicit commits answer pending requests
// ============================================================================

test('an explicit commit during a held attempt waits and captures a save made while it waited', async () => {
	const { history, probe, save, idle, committed } = await tab(
		createTestStorage(),
		'explicit-waits',
	);
	probe.offline = true;
	const held = gate();
	probe.hold = held;
	await save('a.txt', 'one');
	await probe.reached.opened;

	let outcome: Awaited<ReturnType<typeof history.commit>> | undefined;
	const explicit = history.commit().then((value) => {
		outcome = value;
	});
	await Bun.sleep(20);
	expect(outcome).toBeUndefined();
	// Saved after the request, while it waits.
	await save('b.txt', 'while waiting');

	held.open();
	await explicit;
	expect(outcome).toMatchObject({ status: 'committed', message: 'Add b.txt' });
	const recorded = history.snapshot.lastCommit;
	expect(recorded).toMatchObject({ status: 'committed', message: 'Add b.txt' });
	// The explicit commit answered the request `b.txt` made. Whether the
	// worker found that before or after entering again, it commits nothing
	// and leaves the explicit commit's outcome in place.
	await idle();
	expect(probe.publications).toBe(2);
	expect(history.snapshot.lastCommit).toBe(recorded);
	expect(await committed()).toEqual({
		'a.txt': 'one',
		'b.txt': 'while waiting',
	});
	// Both the automatic commit and the explicit commit stayed local.
	expect(probe.pushes).toBe(0);
	await history.close();
});

test('a request an explicit commit already answered records nothing, and a save that asks as it returns is still committed', async () => {
	const { real, history, probe, land, save, idle, committed } = await tab(
		createTestStorage(),
		'answered-race',
	);
	// Something of this tab holds the protection. An explicit commit, and
	// then a save's request, wait behind it in that order.
	const holding = gate();
	const holder = real.exclusive(() => holding.opened);
	const explicit = history.commit();
	await save('a.txt', 'one');
	await Bun.sleep(10);
	expect(probe.mostWaiting).toBe(2);

	// The explicit commit captures `a.txt` and is held before it publishes.
	// A save lands then, and its request arrives just as the worker comes
	// back from finding nothing left to answer.
	const held = gate();
	probe.hold = held;
	probe.onAnswered = () => {
		history.noteEdit();
		history.requestAutomaticCommit();
	};
	holding.open();
	await holder;
	await probe.reached.opened;
	await land('b.txt', 'raced');
	held.open();
	expect(await explicit).toMatchObject({
		status: 'committed',
		message: 'Add a.txt',
	});

	await idle();
	expect(probe.onAnswered).toBeUndefined();
	expect(probe.publications).toBe(2);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add b.txt',
	});
	expect(await committed()).toEqual({ 'a.txt': 'one', 'b.txt': 'raced' });
	await history.close();
});

// ============================================================================
// Failures are reported and not retried
// ============================================================================

test('a refused request to enter the protection is recorded, not retried, and a newer save asks again', async () => {
	const { history, probe, save, idle, committed } = await tab(
		createTestStorage(),
		'refused-entry',
	);
	probe.refuseNext = new Error('lock manager unavailable');
	await save('a.txt', 'one');
	await idle();
	expect(probe.admissions).toBe(1);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'failed',
		error: 'lock manager unavailable',
	});
	await Bun.sleep(30);
	expect(probe.admissions).toBe(1);
	expect(await committed()).toEqual({});

	await save('b.txt', 'two');
	await idle();
	expect(probe.admissions).toBe(2);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
	});
	expect(await committed()).toEqual({ 'a.txt': 'one', 'b.txt': 'two' });
	await history.close();
});

test('an explicit commit refused entry answers the saves before it: the waiting request then commits nothing', async () => {
	const { real, history, probe, save, idle, committed } = await tab(
		createTestStorage(),
		'refused-explicit',
	);
	const holding = gate();
	const holder = real.exclusive(() => holding.opened);
	await save('a.txt', 'one');
	await Bun.sleep(10);
	expect(probe.waiting).toBe(1);

	probe.refuseNext = new Error('lock manager unavailable');
	const refused = await history.commit();
	expect(refused).toMatchObject({
		status: 'failed',
		error: 'lock manager unavailable',
	});
	holding.open();
	await holder;
	await idle();
	// The worker entered and found the save already answered by the failure.
	expect(probe.admissions).toBe(2);
	expect(probe.publications).toBe(0);
	expect(history.snapshot.lastCommit).toMatchObject(refused);
	expect(await committed()).toEqual({});

	await save('b.txt', 'two');
	await idle();
	expect(await committed()).toEqual({ 'a.txt': 'one', 'b.txt': 'two' });
	await history.close();
});

// ============================================================================
// Pushing
// ============================================================================

test('a failed explicit push is not retried by a save; another explicit push uploads the new history', async () => {
	const { history, probe, save, idle } = await tab(
		createTestStorage(),
		'push-again',
	);
	probe.offline = true;
	await save('a.txt', 'one');
	await idle();
	expect(probe.pushes).toBe(0);
	expect((await history.push()).status).toBe('failed');
	expect(history.snapshot.lastPush?.status).toBe('failed');
	expect(probe.pushes).toBe(1);

	// Nothing tries again on its own.
	await Bun.sleep(30);
	expect(probe.pushes).toBe(1);

	probe.offline = false;
	await save('a.txt', 'two');
	await idle();
	expect(history.snapshot.lastPush?.status).toBe('failed');
	expect(probe.pushes).toBe(1);
	expect((await history.push()).status).toBe('pushed');
	expect(history.snapshot.lastPush?.status).toBe('pushed');
	expect(probe.pushes).toBe(2);
	const sync = history.snapshot.sync;
	expect(sync.state === 'observed' && sync.value.ahead).toBe(0);
	await history.close();
});

test('explicit commit is local; commitAndPush pushes', async () => {
	const { history, probe, land } = await tab(
		createTestStorage(),
		'explicit-local',
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	await Bun.sleep(20);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();

	await land('a.txt', 'two');
	const both = await history.commitAndPush();
	expect(both.commit.status).toBe('committed');
	expect(both.push.status).toBe('pushed');
	expect(probe.pushes).toBe(1);
	await history.close();
});

test('a caller that stops waiting on commitAndPush leaves its commit to finish and starts no push later', async () => {
	const { history, probe, land, committed } = await tab(
		createTestStorage(),
		'abandoned',
	);
	await land('a.txt', 'one');
	const held = gate();
	probe.hold = held;
	const caller = new AbortController();
	const waiting = history.commitAndPush({ signal: caller.signal });
	await probe.reached.opened;
	caller.abort();
	expect(await waiting).toEqual({
		commit: { status: 'stoppedWaiting' },
		push: { status: 'stoppedWaiting' },
	});

	// The commit was already inside the protection: it finishes and reports.
	held.open();
	await until(() => history.snapshot.lastCommit !== undefined);
	expect(history.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Add a.txt',
	});
	expect(await committed()).toEqual({ 'a.txt': 'one' });
	await Bun.sleep(30);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();
	await history.close();
});

// ============================================================================
// Closing
// ============================================================================

test('closing after a Web Lock grant but before its callback refuses Git work without recording a commit', async () => {
	const restore = installWebLocks();
	try {
		const locks = navigator.locks as unknown as OpfsLocks;
		const request = locks.request;
		const granted = gate();
		const callback = gate();
		locks.request = (name, options, work) =>
			request(name, options, async (lock) => {
				if (name.startsWith('epicenter-folder-opfs-git:')) {
					granted.open();
					// The host has granted this lock and ignores a later abort.
					// Hold before the backend callback starts actual Git work.
					await callback.opened;
				}
				return work(lock);
			});
		const { history, holds } = await tab(createTestStorage(), 'granted-close');
		const pathStatus = gate();
		holds.pathStatus = pathStatus;
		const listing = history.paths();
		await granted.opened;
		const closed = history.close();
		callback.open();
		expect(expectErr(await listing).name).toBe('Closed');
		await closed;
		expect(holds.pathStatus).toBe(pathStatus);
		expect(history.snapshot.lastCommit).toBeUndefined();
	} finally {
		restore();
	}
});

test("closing refuses an explicit commit still waiting on another tab's Web Lock, resolves without it, and the branch is not moved by it", async () => {
	const restore = installWebLocks();
	try {
		const environment = createTestStorage();
		const a = await tab(environment, 'close-waiting');
		const b = await tab(environment, 'close-waiting');
		const held = gate();
		a.probe.hold = held;
		await a.save('a.txt', 'from a');
		await a.probe.reached.opened;

		await b.land('b.txt', 'from b');
		const waiting = b.history.commit();
		const listing = b.history.paths();
		await Bun.sleep(20);
		expect(b.history.snapshot.activity.commit).toEqual({ active: true });

		// Tab A still holds the lock. Tab B closes without waiting for it.
		await b.history.close();
		expect(await waiting).toEqual({ status: 'closed' });
		expect((await listing).error?.name).toBe('Closed');
		expect(b.history.snapshot.activity.commit).toEqual({ active: false });
		expect(b.history.snapshot.lastCommit).toBeUndefined();

		held.open();
		await a.idle();
		await Bun.sleep(30);
		// Tab B's commit never ran, not even after the lock was freed.
		expect(b.probe.publications).toBe(0);
		expect(await a.committed()).toEqual({ 'a.txt': 'from a' });
		expect(await a.saved()).toEqual({ 'a.txt': 'from a', 'b.txt': 'from b' });
		await a.history.close();
	} finally {
		restore();
	}
});

test("closing refuses a save's request still waiting on another tab's Web Lock; nothing of it runs once the lock frees", async () => {
	const restore = installWebLocks();
	try {
		const environment = createTestStorage();
		const a = await tab(environment, 'close-request');
		const b = await tab(environment, 'close-request');
		const held = gate();
		a.probe.hold = held;
		await a.save('a.txt', 'from a');
		await a.probe.reached.opened;
		const head = await a.real.readBranch();

		await b.save('b.txt', 'from b');
		await b.save('b.txt', 'from b, again');
		await Bun.sleep(20);
		expect(b.probe.waiting).toBe(1);
		expect(b.history.snapshot.activity.commit).toEqual({ active: true });

		await b.history.close();
		expect(b.probe.waiting).toBe(0);
		expect(b.history.snapshot.activity.commit).toEqual({ active: false });
		expect(b.history.snapshot.lastCommit).toBeUndefined();

		held.open();
		await a.idle();
		await Bun.sleep(30);
		// Only tab A's commit moved the branch; tab B's save stays saved.
		expect(b.probe.admissions).toBe(1);
		expect(b.probe.publications).toBe(0);
		const first = a.history.snapshot.lastCommit;
		expect(first).toMatchObject({ status: 'committed', parent: head });
		expect(await a.real.readBranch()).toBe(
			first?.status === 'committed' ? first.oid : undefined,
		);
		expect(await a.committed()).toEqual({ 'a.txt': 'from a' });
		expect(await a.saved()).toEqual({
			'a.txt': 'from a',
			'b.txt': 'from b, again',
		});
		await a.history.close();
	} finally {
		restore();
	}
});

test('closing waits for an attempt already inside the protection, refuses a commit waiting behind it, and makes no last commit', async () => {
	const restore = installWebLocks();
	try {
		const { history, probe, save, committed, saved } = await tab(
			createTestStorage(),
			'close-admitted',
		);
		const held = gate();
		probe.hold = held;
		await save('a.txt', 'one');
		await probe.reached.opened;
		await save('b.txt', 'late');
		// Asked for before closing, still waiting behind the held attempt.
		const waiting = history.commit();

		const closing = history.close();
		expect(history.snapshot.closed).toBe(true);
		expect(await waiting).toEqual({ status: 'closed' });
		expect(await history.commit()).toEqual({ status: 'closed' });
		expect((await history.status()).error?.name).toBe('Closed');
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		// A save that lands after closing began asks for nothing.
		const before = probe.admissions;
		await save('c.txt', 'later still');
		expect(probe.admissions).toBe(before);
		await Bun.sleep(20);
		// The admitted attempt still uses storage; close has not resolved.
		expect(closed).toBe(false);

		held.open();
		await closing;
		// The request `b.txt` left pending was not carried past close.
		expect(probe.admissions).toBe(before);
		expect(probe.publications).toBe(1);
		expect(history.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add a.txt',
		});
		expect(history.snapshot.activity).toEqual({
			scan: { active: false },
			commit: { active: false },
			push: { active: false },
			fetch: { active: false },
			pull: { active: false },
			merge: { active: false },
		});
		// The commit that finished during close stayed local.
		expect(probe.pushes).toBe(0);
		expect(await committed()).toEqual({ 'a.txt': 'one' });
		expect(await saved()).toEqual({
			'a.txt': 'one',
			'b.txt': 'late',
			'c.txt': 'later still',
		});
	} finally {
		restore();
	}
});

// ============================================================================
// Status scans
// ============================================================================

test('status requests during a held scan share one following scan, which reads the last saved edit; nothing is committed or pushed', async () => {
	const { history, probe, holds, land } = await tab(
		createTestStorage(),
		'scan-burst',
	);
	await land('a.txt', 'one');
	const scanning = gate();
	holds.captured = scanning;
	const first = history.status();
	await until(() => holds.captured === undefined);
	expect(probe.captures).toBe(1);

	// A burst while the first scan is held after it read the folder.
	await land('b.txt', 'two');
	const burst = [history.status(), history.status(), history.status()];
	await land('c.txt', 'last');
	burst.push(history.status());
	await Bun.sleep(20);
	// None of them joined the running scan and none started another.
	expect(probe.captures).toBe(1);

	scanning.open();
	// The held scan reports what it read before the burst.
	expect(expectOk(await first).changes.map((change) => change.path)).toEqual([
		'a.txt',
	]);
	const results = await Promise.all(burst);
	const paths = results.map((result) =>
		expectOk(result).changes.map((change) => change.path),
	);
	for (const seen of paths) expect(seen).toEqual(['a.txt', 'b.txt', 'c.txt']);
	// One scan followed for all four callers.
	expect(probe.captures).toBe(2);
	const files = history.snapshot.files;
	expect(files).toMatchObject({ state: 'observed', stale: false });
	expect(
		files.state === 'observed' && files.value.changes.map((c) => c.path),
	).toEqual(['a.txt', 'b.txt', 'c.txt']);

	// The shared scan left no commit, push, or later work behind.
	await Bun.sleep(30);
	expect(probe.captures).toBe(2);
	expect(probe.admissions).toBe(0);
	expect(probe.publications).toBe(0);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastCommit).toBeUndefined();
	// A request after the burst gets a scan of its own.
	expectOk(await history.status());
	expect(probe.captures).toBe(3);
	await history.close();
});

test('closing waits for the running scan and refuses the scan waiting behind it', async () => {
	const { history, probe, holds, land } = await tab(
		createTestStorage(),
		'scan-close',
	);
	await land('a.txt', 'one');
	const scanning = gate();
	holds.captured = scanning;
	const first = history.status();
	await until(() => holds.captured === undefined);
	const following = [history.status(), history.status()];

	let closed = false;
	const closing = history.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	scanning.open();
	await closing;
	expectOk(await first);
	for (const result of await Promise.all(following))
		expect(result.error?.name).toBe('Closed');
	expect(probe.captures).toBe(1);
});

// ============================================================================
// A caller that leaves a queued push or fetch
// ============================================================================

test('a push whose caller leaves while it is queued behind a held push starts no transport when the holder finishes', async () => {
	const { history, probe, holds, land } = await tab(
		createTestStorage(),
		'push-queued',
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const transport = gate();
	holds.transport = transport;
	const holder = history.push();
	await until(() => holds.transport === undefined);
	expect(probe.pushes).toBe(1);

	const caller = new AbortController();
	const queued = history.push({ signal: caller.signal });
	await Bun.sleep(10);
	caller.abort();
	expect(await queued).toEqual({ status: 'stoppedWaiting' });

	transport.open();
	expect((await holder).status).toBe('pushed');
	await Bun.sleep(30);
	// The caller that left never got a transport of its own.
	expect(probe.pushes).toBe(1);
	expect(history.snapshot.activity.push).toEqual({ active: false });
	expect(history.snapshot.lastPush?.status).toBe('pushed');
	await history.close();
});

test('a push asked for with an already aborted signal starts no transport', async () => {
	const { history, probe, land } = await tab(
		createTestStorage(),
		'push-aborted',
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const caller = new AbortController();
	caller.abort();
	expect(await history.push({ signal: caller.signal })).toEqual({
		status: 'stoppedWaiting',
	});
	await Bun.sleep(30);
	expect(probe.pushes).toBe(0);
	expect(history.snapshot.lastPush).toBeUndefined();
	// The runner is not left holding anything: a plain push goes out.
	expect((await history.push()).status).toBe('pushed');
	expect(probe.pushes).toBe(1);
	await history.close();
});

test('a caller that leaves commitAndPush while its push is queued keeps its commit and starts no transport', async () => {
	const { history, probe, holds, land } = await tab(
		createTestStorage(),
		'both-queued',
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const transport = gate();
	holds.transport = transport;
	const holder = history.push();
	await until(() => holds.transport === undefined);

	await land('b.txt', 'two');
	const caller = new AbortController();
	const both = history.commitAndPush({ signal: caller.signal });
	// Wait for this commit, not the earlier commit whose push is still held.
	await until(() => {
		const committed = history.snapshot.lastCommit;
		return (
			committed?.status === 'committed' && committed.message === 'Add b.txt'
		);
	});
	caller.abort();
	expect(await both).toMatchObject({
		commit: { status: 'committed', message: 'Add b.txt' },
		push: { status: 'stoppedWaiting' },
	});

	transport.open();
	await holder;
	await Bun.sleep(30);
	expect(probe.pushes).toBe(1);
	await history.close();
});

test('a caller that leaves after its push started is told so; the transport finishes and close waits for one that has not', async () => {
	const { history, probe, holds, land } = await tab(
		createTestStorage(),
		'push-admitted',
	);
	await land('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	const transport = gate();
	holds.transport = transport;
	const caller = new AbortController();
	const admitted = history.push({ signal: caller.signal });
	await until(() => holds.transport === undefined);
	caller.abort();
	// The caller stopped waiting; the host did not cancel anything.
	expect(await admitted).toEqual({ status: 'stoppedWaiting' });
	expect(history.snapshot.activity.push).toEqual({ active: true });

	let closed = false;
	const closing = history.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	transport.open();
	await closing;
	expect(probe.pushes).toBe(1);
	expect(history.snapshot.lastPush?.status).toBe('pushed');
});

test('a fetch whose caller leaves while it is queued, or before it asks, starts no transport', async () => {
	const { history, probe, holds } = await tab(
		createTestStorage(),
		'fetch-queued',
	);
	const transport = gate();
	holds.transport = transport;
	const holder = history.fetch();
	await until(() => holds.transport === undefined);
	expect(probe.fetches).toBe(1);

	const caller = new AbortController();
	const queued = history.fetch({ signal: caller.signal });
	await Bun.sleep(10);
	caller.abort();
	expect((await queued).error?.name).toBe('StoppedWaiting');
	expect((await history.fetch({ signal: caller.signal })).error?.name).toBe(
		'StoppedWaiting',
	);

	transport.open();
	expectOk(await holder);
	await Bun.sleep(30);
	expect(probe.fetches).toBe(1);
	expect(history.snapshot.activity.fetch).toEqual({ active: false });
	await history.close();
});

// ============================================================================
// A directory with the real `git`
// ============================================================================

async function directory(prefix: string) {
	const root = await scratch(prefix);
	const open = () => openNativeFolder({ root, definition, git: { author } });
	return { root, open, folder: await open() };
}

async function settled(
	folder: Awaited<ReturnType<typeof directory>>['folder'],
) {
	await Bun.sleep(0);
	await until(() => !folder.git.snapshot.activity.commit.active);
}

test('a held ref lock fails the attempt, records the error, keeps the save, and nothing retries until the next save', async () => {
	const { root, folder } = await directory('attempt-ref-lock-');
	expectOk(await folder.files.create('a.md', 'first'));
	await settled(folder);
	const head = await git(root, 'rev-parse', 'HEAD');

	const lock = join(root, '.git', 'refs', 'heads', 'main.lock');
	await writeFile(lock, '');
	expectOk(await folder.files.create('b.md', 'saved under a lock'));
	await settled(folder);
	const failed = folder.git.snapshot.lastCommit;
	expect(failed?.status).toBe('failed');
	expect(failed?.status === 'failed' && failed.error).toContain('main.lock');
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
	expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('saved under a lock');
	expect(await git(root, 'status', '--porcelain')).toBe('?? b.md');

	await rm(lock);
	await Bun.sleep(60);
	// The lock is gone and nothing ran on its own.
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
	expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
	expect(folder.git.snapshot.lastCommit?.status).toBe('failed');

	// The next save's attempt commits both.
	expectOk(await folder.files.create('c.md', 'next'));
	await settled(folder);
	expect(folder.git.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
		parent: head,
	});
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await folder.close();
});

test('a held index lock still commits, reports the index warning, and the next commit repairs it', async () => {
	const { root, folder } = await directory('attempt-index-lock-');
	expectOk(await folder.files.create('a.md', 'first'));
	await settled(folder);

	const lock = join(root, '.git', 'index.lock');
	await writeFile(lock, '');
	expectOk(await folder.files.create('b.md', 'second'));
	await settled(folder);
	const committed = folder.git.snapshot.lastCommit;
	expect(committed).toMatchObject({ status: 'committed', message: 'Add b.md' });
	expect(committed?.status === 'committed' && committed.indexWarning).toContain(
		'index.lock',
	);
	expect(await git(root, 'show', 'HEAD:b.md')).toBe('second');
	// The index is behind the branch, not corrupt: Git still reads it.
	await rm(lock);
	expect(await git(root, 'status', '--porcelain')).toBe('D  b.md\n?? b.md');

	expect(await folder.git.commit()).toMatchObject({
		status: 'unchanged',
		indexWarning: undefined,
	});
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await folder.close();
});

test('many callers in one handle and across two each take a commit and leave a linear branch, sound objects, and a usable index', async () => {
	const { root, open, folder: one } = await directory('attempt-many-');
	const two = await open();
	// Opening committed epicenter.json before any caller here asked.
	await settled(one);
	await settled(two);
	const opening = Number(await git(root, 'rev-list', '--count', 'HEAD'));
	const tally: Record<string, number> = {};
	const committedOids: string[] = [];
	for (let round = 0; round < 8; round++) {
		await writeFile(join(root, `note-${round % 3}.md`), `round ${round}`);
		const outcomes = await Promise.all([
			...Array.from({ length: 3 }, () => one.git.commit()),
			...Array.from({ length: 3 }, () => two.git.commit()),
			one.git.commitAndPush().then((both) => both.commit),
		]);
		for (const outcome of outcomes) {
			tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
			if (outcome.status === 'committed') committedOids.push(outcome.oid);
			// Every caller is told what its own commit did.
			expect(['committed', 'unchanged', 'branchMoved', 'failed']).toContain(
				outcome.status,
			);
		}
		expect(await readFile(join(root, `note-${round % 3}.md`), 'utf8')).toBe(
			`round ${round}`,
		);
	}
	console.log('many callers, outcome tally:', JSON.stringify(tally));

	// Every commit reported as committed is on the branch: none was overwritten.
	expect(committedOids.length).toBeGreaterThan(0);
	for (const oid of committedOids)
		await git(root, 'merge-base', '--is-ancestor', oid, 'HEAD');
	const parents = (await git(root, 'log', '--format=%P')).split('\n');
	expect(
		parents.every((line) => line.split(' ').filter(Boolean).length <= 1),
	).toBe(true);
	// The branch moved once per reported commit and never by force.
	expect(Number(await git(root, 'rev-list', '--count', 'HEAD'))).toBe(
		opening + committedOids.length,
	);
	await git(root, 'fsck', '--strict', '--no-dangling');

	const last = await one.git.commit();
	expect(['committed', 'unchanged']).toContain(last.status);
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await git(root, 'diff', '--cached', '--quiet');
	await one.close();
	await two.close();
});

test('the subject and count describe the committed tree, not the files on disk', async () => {
	const { root, folder } = await directory('attempt-subject-');
	// Opening committed epicenter.json on its own.
	await settled(folder);
	await writeFile(join(root, '.gitignore'), '*.log\n');
	await writeFile(join(root, 'a.md'), 'a');
	await writeFile(join(root, 'b.md'), 'b');
	await writeFile(join(root, 'debug.log'), 'ignored');
	const first = await folder.git.commit();
	const changed = async () =>
		(
			await git(
				root,
				'diff-tree',
				'--root',
				'-r',
				'--name-only',
				'--no-commit-id',
				'HEAD',
			)
		).split('\n');
	expect(await changed()).toEqual(['.gitignore', 'a.md', 'b.md']);
	expect(first).toMatchObject({
		status: 'committed',
		message: 'Update 3 files',
		changedPaths: 3,
	});
	expect(await git(root, 'log', '-1', '--format=%s')).toBe('Update 3 files');

	// Four files change on disk; one is ignored and one ends as it began.
	await writeFile(join(root, 'a.md'), 'a2');
	await writeFile(join(root, 'b.md'), 'b');
	await writeFile(join(root, 'debug.log'), 'still ignored');
	const second = await folder.git.commit();
	expect(await changed()).toEqual(['a.md']);
	expect(second).toMatchObject({
		status: 'committed',
		message: 'Update a.md',
		changedPaths: 1,
	});
	await folder.close();
});

test('close from a commit activity observer refuses unadmitted work or waits for the admitted attempt', async () => {
	const mine = await tab(createTestStorage(), 'close-from-activity');
	const hold = gate();
	mine.probe.hold = hold;
	let initiated = false;
	let closed = false;
	let closing: Promise<void> | undefined;
	const unsubscribe = mine.history.subscribe((snapshot) => {
		if (initiated || !snapshot.activity.commit.active) return;
		initiated = true;
		closing = mine.history.close().then(() => {
			closed = true;
		});
	});
	try {
		await mine.save('note.md', 'saved');
		await until(() => closed || mine.probe.publications > 0);
		if (closed) {
			await Bun.sleep(20);
			expect(mine.probe.publications).toBe(0);
		} else {
			expect(mine.probe.publications).toBe(1);
			hold.open();
			await closing;
			expect(await mine.committed()).toEqual({ 'note.md': 'saved' });
		}
		expect(closed).toBe(true);
		expect(mine.probe.pushes).toBe(0);
	} finally {
		hold.open();
		unsubscribe();
		await closing;
		await mine.history.close();
	}
});
