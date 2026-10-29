/**
 * The repository server core: one object per repository that orders every
 * write. It applies batches all or nothing against an overlay of files changed
 * since the last commit, broadcasts what changed, and commits the overlay to
 * Git's `main` by compare-and-swap. It knows no transport: a host (an
 * in-process test transport, later a Durable Object) calls `connect`.
 */
import { createLogger, type Logger } from 'wellcrafted/logger';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { gitBlobHash } from '../core/hash.js';
import { breaksParsing } from '../parse-rule.js';
import { type Party, versionOf } from '../core/conflict.js';
import { merge, withBlocks } from '../core/merge.js';
import { settle } from './policy.js';
import type {
	Base,
	Batch,
	BatchOutcome,
	Broadcast,
	ChangeOutcome,
	FileState,
	Move,
	Overlap,
	SettledOverlap,
	Welcome,
} from '../protocol.js';
import { first, type SqlDriver } from '../sql.js';
import { type GitStore, MAIN, type Signature, sequenceOf, type Tree } from '../server/git-store.js';
import { createPathHistory, type PathEvent, pathEventsOf, pathEventTrailer, type SequencedEvent, trace } from './history.js';
import { receivePush } from './push.js';

export const CommitError = defineErrors({
	/** `main` moved while the commit was being written; nothing was cleared. */
	Raced: ({ expected }: { expected: string | null }) => ({
		message: `main moved away from ${expected ?? 'nothing'} during a commit`,
		expected,
	}),
});
export type CommitError = InferErrors<typeof CommitError>;

const ServerDiagnostic = defineErrors({
	TimedCommitFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A timed commit did not land; the overlay is kept',
		cause,
	}),
});

/**
 * A free sibling of `path` for a change `user` made that cannot land there,
 * named for the user and the server's day: `fix-login (bob, 2026-10-28).md`,
 * then `fix-login (bob, 2026-10-28, 2).md`. It sits in the same folder, so the
 * same templates match it.
 */
export function siblingPath(path: string, user: string, at: number, exists: (path: string) => boolean) {
	const cut = path.lastIndexOf('/') + 1;
	const name = path.slice(cut);
	const ext = name.endsWith('.md') ? '.md' : '';
	const stem = name.slice(0, name.length - ext.length);
	// A user id never adds a folder, a hidden name or a control character.
	const who = user.replace(/[/\\\u0000-\u001f\u007f]/g, '-').replace(/^\./, '-');
	const day = new Date(at).toISOString().slice(0, 10);
	for (let k = 1; ; k++) {
		const candidate = `${path.slice(0, cut)}${stem} (${who}, ${day}${k === 1 ? '' : `, ${k}`})${ext}`;
		if (!exists(candidate)) return candidate;
	}
}

/** Who is connected: the server stamps every batch with `user`. Each batch names its own overlap policy. */
export type Peer = {
	device: string;
	user: string;
	onBroadcast?: (broadcast: Broadcast) => void;
};

export type Committed = { oid: string; seq: number };

export type ServerOptions = {
	driver: SqlDriver;
	git: GitStore;
	now?: () => number;
	/** How old an overlay change is before `tick` commits it. A minute by default. */
	commitAfterMs?: number;
	/**
	 * When an applied batch is acknowledged: right away from the overlay, or
	 * after its commit lands in Git. See `beforeAck`.
	 */
	durability?: 'overlay' | 'commit-before-ack';
	identify?: (user: string) => Signature;
	log?: Logger;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS overlay (path TEXT PRIMARY KEY, text TEXT, hash TEXT, seq INTEGER NOT NULL, at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS texts (hash TEXT PRIMARY KEY, text TEXT NOT NULL, seq INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY, device TEXT NOT NULL, n INTEGER NOT NULL, user TEXT NOT NULL, at INTEGER NOT NULL, changes TEXT NOT NULL, overlaps TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS devices (device TEXT PRIMARY KEY, last_n INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS receipts (device TEXT NOT NULL, n INTEGER NOT NULL, seq INTEGER, outcome TEXT NOT NULL, PRIMARY KEY (device, n)) STRICT;
INSERT OR IGNORE INTO state VALUES ('seq', 0), ('committed', 0);
`;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** A settled overlap and the file it is in, as a batch row keeps it until its commit. */
type RecordedOverlap = { path: string; overlap: SettledOverlap };

/**
 * The commit trailer that names one settled overlap, so the record outlives
 * the outcome a device received. Agents find unmarked clashes with
 * `git log --grep '^Epicenter-Overlap:'` and marked ones by their markers.
 * Paths and keys are JSON strings, since they may hold spaces.
 *
 *     Epicenter-Overlap: "notes/a.md" field "status" current-kept; seq 3 by bob
 */
export function overlapTrailer(seq: number, user: string, { path, overlap }: RecordedOverlap) {
	const quote = (text: string) => JSON.stringify(text);
	let what: string;
	switch (overlap.unit) {
		case 'body':
		case 'block':
			what = `${overlap.unit} ${overlap.settled}`;
			break;
		case 'field':
			what = `field ${quote(overlap.key)} ${overlap.settled}`;
			break;
		case 'file':
			what = `file ${overlap.clash} ${overlap.settled}`;
			break;
		case 'path':
			what = `path ${overlap.clash} ${overlap.settled}${overlap.relocatedTo === null ? '' : ` -> ${quote(overlap.relocatedTo)}`}`;
	}
	return `Epicenter-Overlap: ${quote(path)} ${what}; seq ${seq} by ${user}`;
}

export function createRepositoryServer({
	driver,
	git,
	now = Date.now,
	commitAfterMs = 60_000,
	durability = 'overlay',
	identify = (user) => ({ name: user, email: `${user}@users.epicenter.invalid` }),
	log = createLogger('repository/server'),
}: ServerOptions) {
	driver.exec(SCHEMA);
	const peers = new Set<Peer>();

	// One request at a time: a batch's reads, its transaction and its commit
	// never interleave with another's.
	let tail: Promise<unknown> = Promise.resolve();
	function serially<T>(fn: () => Promise<T>): Promise<T> {
		const run = tail.then(fn);
		tail = run.catch(() => undefined);
		return run;
	}

	const history = createPathHistory(driver);
	const state = (key: 'seq' | 'committed') =>
		first<{ value: number }>(driver, 'SELECT value FROM state WHERE key = ?', [key])?.value ?? 0;
	const setState = (key: 'seq' | 'committed', value: number) =>
		driver.run('UPDATE state SET value = ? WHERE key = ?', [value, key]);

	// ------------------------------------------------------------------------
	// Reading Git's main, cached by head
	// ------------------------------------------------------------------------

	let main: { oid: string | null; tree: Tree; seq: number } = { oid: null, tree: new Map(), seq: 0 };
	let mainLoaded = false;
	const blobTexts = new Map<string, string | null>();

	async function loadMain() {
		const oid = await git.readRef(MAIN);
		if (mainLoaded && main.oid === oid) return main;
		const commit = oid === null ? null : await git.readCommit(oid);
		main = {
			oid,
			tree: commit === null ? new Map() : await git.readTree(commit.tree),
			seq: commit === null ? 0 : (sequenceOf(commit.message) ?? 0),
		};
		mainLoaded = true;
		return main;
	}

	/** A Git blob as text, or null when it is missing or not UTF-8. */
	async function gitText(oid: string): Promise<string | null> {
		if (blobTexts.has(oid)) return blobTexts.get(oid) ?? null;
		const bytes = await git.readBlob(oid);
		let text: string | null = null;
		if (bytes !== null)
			try {
				text = decoder.decode(bytes);
			} catch {
				text = null;
			}
		blobTexts.set(oid, text);
		return text;
	}

	/** The server's current text at `path`: the overlay over main. */
	async function current(path: string): Promise<string | null> {
		const row = first<{ text: string | null }>(driver, 'SELECT text FROM overlay WHERE path = ?', [path]);
		if (row !== undefined) return row.text;
		const entry = (await loadMain()).tree.get(path);
		return entry === undefined ? null : gitText(entry.oid);
	}

	/** A text the server has seen, by hash: recent bases and results, then Git. */
	async function textByHash(hash: string): Promise<string | null> {
		const row = first<{ text: string }>(driver, 'SELECT text FROM texts WHERE hash = ?', [hash]);
		if (row !== undefined) return row.text;
		return gitText(hash);
	}

	/** Who last wrote `path` in the overlay, and when, for block labels. */
	function writerOf(path: string): Party {
		const row = first<{ user: string; at: number; seq: number }>(
			driver,
			'SELECT b.user, b.at, b.seq FROM overlay o JOIN batches b ON b.seq = o.seq WHERE o.path = ?',
			[path],
		);
		return row === undefined ? { author: 'main', time: `seq-${main.seq}` } : party(row.user, row.at);
	}
	const party = (user: string, at: number): Party => ({ author: user, time: new Date(at).toISOString() });

	// ------------------------------------------------------------------------
	// Applying a batch
	// ------------------------------------------------------------------------

	/**
	 * Every path event after `since`, in order: from the trailers of the
	 * commits after it, then from the overlay. Overlay events Git already
	 * holds (a crash can leave them until the next commit clears them) are
	 * skipped.
	 */
	async function eventsAfter(since: number): Promise<SequencedEvent[]> {
		const head = await loadMain();
		const overlay = history.between(Math.max(since, head.seq), Number.MAX_SAFE_INTEGER);
		if (head.oid === null || since >= head.seq) return overlay;
		const commits = await git.commitsAfter(head.oid, since);
		return [...commits.flatMap((commit) => pathEventsOf(commit.message)), ...overlay];
	}

	type Prepared = {
		currents: Map<string, string | null>;
		bases: Map<string, string>;
		/** A path whose change sent a base text that does not hash to its hash, if one did. */
		forged: string | null;
		/** The path events after the batch's position. */
		events: SequencedEvent[];
	};

	/** Everything the transaction reads asynchronously, fetched first. */
	async function prepare(batch: Batch): Promise<Prepared> {
		const events = await eventsAfter(batch.seq);
		const currents = new Map<string, string | null>();
		const bases = new Map<string, string>();
		let forged: string | null = null;
		const load = async (path: string) => {
			if (!currents.has(path)) currents.set(path, await current(path));
		};
		const loadBase = async (base: Base, path: string) => {
			// A base text is trusted only as the text its hash names: a merge from
			// any other text would undo or invent changes.
			if (base.text !== undefined && gitBlobHash(base.text) !== base.hash) forged ??= path;
			if (bases.has(base.hash)) return;
			const text = base.text ?? (await textByHash(base.hash));
			if (text !== null) bases.set(base.hash, text);
		};
		for (const change of batch.changes) {
			if (change.kind === 'move') {
				await load(trace(change.from, batch.seq, events).path);
				await load(change.from);
				await load(change.to);
				continue;
			}
			const traced = trace(change.path, batch.seq, events);
			await load(traced.path);
			await load(change.path);
			if (change.kind === 'write') {
				if (change.base !== null) await loadBase(change.base, change.path);
			}
			// An append needs its base only when its note may be gone.
			else if (traced.deleted || currents.get(traced.path) === null) await loadBase(change.base, change.path);
		}
		return { currents, bases, forged, events };
	}

	type Applied = { outcome: BatchOutcome; broadcast: Broadcast | null };

	function applyPrepared(batch: Batch, peer: Peer, { currents, bases, forged, events: past }: Prepared): Applied {
		if (forged !== null) return { outcome: { kind: 'refused', path: forged, reason: 'the base text sent does not match its hash', overlaps: [] }, broadcast: null };
		const work = new Map(currents);
		const read = (path: string) => (work.has(path) ? (work.get(path) ?? null) : null);
		/** Whether a file is at `path`, answered synchronously so a sibling is named inside the transaction. */
		const exists = (path: string) => {
			if (work.has(path)) return work.get(path) !== null;
			const row = first<{ text: string | null }>(driver, 'SELECT text FROM overlay WHERE path = ?', [path]);
			return row === undefined ? main.tree.has(path) : row.text !== null;
		};
		const seq = state('seq') + 1;
		const at = now();
		const incomingParty = party(peer.user, at);
		const outcomes: ChangeOutcome[] = [];
		const events: PathEvent[] = [];
		const moves: Move[] = [];
		const seenTexts = new Set<string>();
		const needBase: string[] = [];
		const refuse = (path: string, reason: string, overlaps: Overlap[] = []): Applied => ({
			outcome: { kind: 'refused', path, reason, overlaps },
			broadcast: null,
		});
		const outcome = (change: Partial<ChangeOutcome> & { path: string }): ChangeOutcome => ({
			at: null,
			hash: null,
			movedTo: null,
			overlaps: [],
			...change,
		});
		const known = (base: Base | null) => (base === null ? null : (bases.get(base.hash) ?? null));
		/**
		 * Where a move earlier in this batch that did not apply left its note:
		 * a later change aimed at the move's destination means that note.
		 */
		const keptAt = new Map<string, string>();
		/**
		 * Where the note a change addresses is: after the events since the
		 * batch's position, then this batch's own moves and relocations, so a
		 * later change follows an earlier one in the same batch.
		 */
		const traceNow = (path: string) =>
			trace(keptAt.get(path) ?? path, batch.seq, [
				...past,
				...events
					.filter((event) => event.kind === 'relocate' || event.kind === 'move')
					.map((event) => ({ ...event, seq: Number.MAX_SAFE_INTEGER })),
			]);
		/** Whether a change elsewhere, since the batch's position, moved the note: this batch's own moves do not count. */
		const movedElsewhere = (path: string) => trace(keptAt.get(path) ?? path, batch.seq, past).moved;
		const sibling = (path: string) => siblingPath(path, peer.user, at, exists);
		/**
		 * A change that would leave a note's frontmatter unparseable keeps its
		 * current text: under `'refuse'` the batch is refused, and under
		 * `'mark'` the change is kept out, as an overlap its device reports.
		 */
		const keepParsing = (path: string, target: string, existing: string, movedTo: string | null): Applied | ChangeOutcome => {
			const decision = settle([{ unit: 'file', clash: 'unparseable' }], batch.policy);
			if (decision.kind === 'refuse') return refuse(path, decision.reason, decision.overlaps);
			return outcome({ path, at: target, hash: gitBlobHash(existing), text: existing, movedTo, overlaps: decision.overlaps });
		};

		for (const change of batch.changes) {
			if (change.kind === 'move') {
				const from = traceNow(change.from);
				const text = from.deleted ? null : read(from.path);
				if (text === null) {
					const decision = settle([{ unit: 'path', clash: 'gone', relocatedTo: null }], batch.policy);
					if (decision.kind === 'refuse') return refuse(change.from, decision.reason, decision.overlaps);
					outcomes.push(outcome({ path: change.from, overlaps: decision.overlaps }));
					keptAt.set(change.to, from.path);
					continue;
				}
				const to = change.to;
				const movedTo = from.path === change.from ? null : from.path;
				// A move made elsewhere already put the note at `to`.
				if (from.path === to) {
					outcomes.push(outcome({ path: change.from, at: to, hash: gitBlobHash(text), text, movedTo }));
					continue;
				}
				// The path is one of the note's fields, and the current one wins: a
				// rename of a note renamed since, or onto another note's path, leaves
				// the note where it is. No sibling is made for a move.
				const kept: Overlap | null = movedElsewhere(change.from)
					? { unit: 'field', key: 'path', base: change.from, current: from.path, incoming: to }
					: exists(to)
						? { unit: 'path', clash: 'taken', relocatedTo: null }
						: null;
				if (kept !== null) {
					const decision = settle([kept], batch.policy);
					if (decision.kind === 'refuse') return refuse(kept.unit === 'path' ? to : change.from, decision.reason, decision.overlaps);
					outcomes.push(outcome({ path: change.from, at: from.path, hash: gitBlobHash(text), text, movedTo, overlaps: decision.overlaps }));
					keptAt.set(to, from.path);
					continue;
				}
				work.set(from.path, null);
				work.set(to, text);
				events.push({ kind: 'move', path: from.path, dest: to });
				moves.push({ from: from.path, to });
				outcomes.push(outcome({ path: change.from, at: to, hash: gitBlobHash(text), text, movedTo }));
				continue;
			}

			const traced = traceNow(change.path);
			const target = traced.path;
			const movedTo = target === change.path ? null : target;
			const existing = traced.reused ? null : read(target);
			if (traced.reused) {
				// The change's own version of its note goes to a sibling.
				let text: string | null = change.kind === 'write' ? change.text : null;
				if (change.kind === 'append') {
					const base = known(change.base);
					if (base === null) {
						needBase.push(change.path);
						continue;
					}
					text = base + change.text;
				}
				const dest = text === null ? null : sibling(target);
				const decision = settle([{ unit: 'path', clash: 'reused', relocatedTo: dest }], batch.policy);
				if (decision.kind === 'refuse') return refuse(change.path, decision.reason, decision.overlaps);
				if (dest !== null && text !== null) {
					work.set(dest, text);
					events.push(
						{ kind: 'create', path: dest },
						{ kind: 'relocate', path: target, dest, before: traced.vacatedAt ?? batch.seq + 1 },
					);
				}
				outcomes.push(
					outcome({
						path: change.path,
						at: dest,
						hash: text === null ? null : gitBlobHash(text),
						...(dest === null ? {} : { text }),
						movedTo,
						overlaps: decision.overlaps,
					}),
				);
				continue;
			}

			if (change.kind === 'append' && existing !== null) {
				const text = existing + change.text;
				if (breaksParsing(target, existing, text)) {
					const kept = keepParsing(change.path, target, existing, movedTo);
					if ('outcome' in kept) return kept;
					outcomes.push(kept);
					continue;
				}
				work.set(target, text);
				outcomes.push(outcome({ path: change.path, at: target, hash: gitBlobHash(text), text, movedTo }));
				continue;
			}

			// A write, or an append whose note was deleted: an edit of its base, which beats the delete.
			let baseText: string | null = null;
			const base = change.base;
			if (base !== null) {
				baseText = known(base);
				if (baseText === null) {
					needBase.push(change.path);
					continue;
				}
			}
			const incoming = change.kind === 'append' ? (baseText ?? '') + change.text : change.text;
			if (incoming !== null) seenTexts.add(incoming);
			const result = merge(baseText, existing, incoming);
			const decision = settle(result.overlaps, batch.policy);
			if (decision.kind === 'refuse') return refuse(change.path, decision.reason, decision.overlaps);
			const text = result.overlaps.some((o) => o.unit === 'body' || o.unit === 'block')
				? withBlocks(result, {
						current: { ...writerOf(target), version: versionOf(existing) },
						base: { version: versionOf(baseText) },
						incoming: { ...incomingParty, version: versionOf(incoming) },
					})
				: result.text;
			if (existing !== null && breaksParsing(target, existing, text)) {
				const kept = keepParsing(change.path, target, existing, movedTo);
				if ('outcome' in kept) return kept;
				outcomes.push(kept);
				continue;
			}
			if (existing === null && text !== null) {
				// An edit that beat a delete brings the same note back; it is not a new note.
				const restored = result.overlaps.some((o) => o.unit === 'file' && o.clash === 'deleted');
				events.push({ kind: restored ? 'restore' : 'create', path: target });
			}
			if (existing !== null && text === null) events.push({ kind: 'delete', path: target });
			work.set(target, text);
			outcomes.push(
				outcome({
					path: change.path,
					at: text === null ? null : target,
					hash: text === null ? null : gitBlobHash(text),
					...(change.kind === 'write' && text === change.text ? {} : { text }),
					movedTo,
					overlaps: decision.overlaps,
				}),
			);
		}

		if (needBase.length > 0) return { outcome: { kind: 'need-base', paths: needBase }, broadcast: null };

		const files: FileState[] = [];
		for (const [path, text] of work) {
			if (currents.has(path) && text === currents.get(path)) continue;
			const hash = text === null ? null : gitBlobHash(text);
			driver.run('INSERT OR REPLACE INTO overlay (path, text, hash, seq, at) VALUES (?, ?, ?, ?, ?)', [path, text, hash, seq, at]);
			if (text !== null) seenTexts.add(text);
			files.push({ path, text, hash });
		}
		for (const text of seenTexts)
			driver.run('INSERT OR REPLACE INTO texts (hash, text, seq) VALUES (?, ?, ?)', [gitBlobHash(text), text, seq]);
		history.record(seq, events);
		const recorded: RecordedOverlap[] = outcomes.flatMap((change) =>
			change.overlaps.map((overlap) => ({
				path: overlap.unit === 'path' ? (change.movedTo ?? change.path) : (change.at ?? change.path),
				overlap,
			})),
		);
		driver.run('INSERT INTO batches (seq, device, n, user, at, changes, overlaps) VALUES (?, ?, ?, ?, ?, ?, ?)', [
			seq,
			batch.device,
			batch.n,
			peer.user,
			at,
			JSON.stringify(batch.changes),
			JSON.stringify(recorded),
		]);
		setState('seq', seq);
		return {
			outcome: { kind: 'applied', seq, changes: outcomes },
			broadcast: { seq, device: batch.device, files, moves },
		};
	}

	/** Apply one batch under per-device numbering; a retry returns its recorded outcome. */
	async function applyBatch(batch: Batch, peer: Peer, numbered = true): Promise<Applied> {
		if (numbered) {
			const last = first<{ last_n: number }>(driver, 'SELECT last_n FROM devices WHERE device = ?', [batch.device])?.last_n ?? 0;
			if (batch.n <= last) {
				const receipt = first<{ outcome: string }>(driver, 'SELECT outcome FROM receipts WHERE device = ? AND n = ?', [batch.device, batch.n]);
				if (receipt !== undefined) return { outcome: JSON.parse(receipt.outcome) as BatchOutcome, broadcast: null };
				// A missing receipt was applied: a refusal's receipt stays while it can be retried.
				return { outcome: { kind: 'applied', seq: null, changes: [] }, broadcast: null };
			}
			if (batch.n !== last + 1)
				return {
					outcome: { kind: 'refused', path: '', reason: `batch ${batch.n} arrived after ${last}`, overlaps: [] },
					broadcast: null,
				};
		}
		const prepared = await prepare(batch);
		return driver.transaction(() => {
			const applied = applyPrepared(batch, peer, prepared);
			if (numbered && applied.outcome.kind !== 'need-base') {
				driver.run('INSERT OR REPLACE INTO devices (device, last_n) VALUES (?, ?)', [batch.device, batch.n]);
				driver.run('INSERT OR REPLACE INTO receipts (device, n, seq, outcome) VALUES (?, ?, ?, ?)', [
					batch.device,
					batch.n,
					applied.outcome.kind === 'applied' ? applied.outcome.seq : null,
					JSON.stringify(applied.outcome),
				]);
			}
			return applied;
		});
	}

	/**
	 * Tell every other device what changed. Never the sender's device, on any
	 * connection: a batch a closed tab sent can land after the device
	 * connected again, and its own change heard as one made elsewhere would
	 * merge into its text a second time. The device learns its batch's
	 * outcome from the reply, or from the receipt when it sends it again.
	 */
	function broadcast(message: Broadcast, from: Peer | null) {
		for (const peer of peers) if (peer !== from && peer.device !== message.device) peer.onBroadcast?.(message);
	}

	/**
	 * The one place that decides when an applied batch may be acknowledged. A
	 * deployed spike is measuring whether committing every batch before its
	 * acknowledgment keeps up; if it does, the overlay can go.
	 */
	async function beforeAck() {
		if (durability === 'commit-before-ack') await commitNow();
	}

	// ------------------------------------------------------------------------
	// Committing
	// ------------------------------------------------------------------------

	/**
	 * Clear overlay rows Git already holds: never past main's sequence. A
	 * receipt goes with its batch's commit; a refusal stays while it is its
	 * device's latest batch, since a device retries only that one.
	 */
	function clearThrough(seq: number) {
		driver.transaction(() => {
			driver.run('DELETE FROM overlay WHERE seq <= ?', [seq]);
			driver.run('DELETE FROM texts WHERE seq <= ?', [seq]);
			driver.run('DELETE FROM batches WHERE seq <= ?', [seq]);
			history.clearThrough(seq);
			driver.run('DELETE FROM receipts WHERE seq <= ?', [seq]);
			driver.run(
				'DELETE FROM receipts WHERE seq IS NULL AND n < (SELECT last_n FROM devices WHERE devices.device = receipts.device)',
			);
			if (seq > state('committed')) setState('committed', seq);
		});
	}

	async function commitNow(extraParents: string[] = []): Promise<Result<Committed | null, CommitError>> {
		const head = await loadMain();
		clearThrough(head.seq);
		const rows = driver.all<{ path: string; text: string | null; seq: number }>('SELECT path, text, seq FROM overlay ORDER BY path');
		if (rows.length === 0 && extraParents.length === 0) return Ok(null);
		const seq = state('seq');
		const tree: Tree = new Map(head.tree);
		const encoder = new TextEncoder();
		for (const row of rows) {
			if (row.text === null) tree.delete(row.path);
			else tree.set(row.path, { mode: '100644', oid: await git.writeBlob(encoder.encode(row.text)) });
		}
		const users = driver.all<{ user: string }>('SELECT DISTINCT user FROM batches WHERE seq <= ? ORDER BY user', [seq]);
		const coauthors = users.map(({ user }) => {
			const who = identify(user);
			return `Co-authored-by: ${who.name} <${who.email}>`;
		});
		const overlaps = driver
			.all<{ seq: number; user: string; overlaps: string }>('SELECT seq, user, overlaps FROM batches WHERE seq <= ? ORDER BY seq', [seq])
			.flatMap((row) => (JSON.parse(row.overlaps) as RecordedOverlap[]).map((recorded) => overlapTrailer(row.seq, row.user, recorded)));
		const paths = history.between(head.seq, seq).map(pathEventTrailer);
		const trailers = [`Epicenter-Seq: ${seq}`, ...paths, ...overlaps, ...coauthors];
		const message = `Update ${rows.length} ${rows.length === 1 ? 'file' : 'files'}\n\n${trailers.map((line) => `${line}\n`).join('')}`;
		const oid = await git.writeCommit({
			tree: await git.writeTree(tree),
			parents: [...(head.oid === null ? [] : [head.oid]), ...extraParents],
			message,
			author: { name: 'Epicenter', email: 'server@epicenter.invalid' },
			at: new Date(now()),
		});
		if (!(await git.updateRef(MAIN, oid, head.oid))) return CommitError.Raced({ expected: head.oid });
		main = { oid, tree, seq };
		clearThrough(seq);
		return Ok({ oid, seq });
	}

	// ------------------------------------------------------------------------
	// Reading for devices
	// ------------------------------------------------------------------------

	async function hello(seq: number, device: string): Promise<Welcome> {
		const head = await loadMain();
		const serverSeq = state('seq');
		const through = first<{ last_n: number }>(driver, 'SELECT last_n FROM devices WHERE device = ?', [device])?.last_n ?? 0;
		if (seq >= state('committed') && seq >= head.seq) {
			const files = driver.all<FileState>('SELECT path, text, hash FROM overlay WHERE seq > ? ORDER BY seq, path', [seq]);
			return { kind: 'changes', seq: serverSeq, files, through };
		}
		const overlay = new Map(
			driver.all<FileState>('SELECT path, text, hash FROM overlay').map((row) => [row.path, row]),
		);
		const files: FileState[] = [];
		for (const [path, entry] of head.tree) {
			if (overlay.has(path)) continue;
			const text = await gitText(entry.oid);
			if (text !== null) files.push({ path, text, hash: entry.oid });
		}
		for (const row of overlay.values()) if (row.text !== null) files.push(row);
		return { kind: 'snapshot', seq: serverSeq, files, through };
	}

	const core: ServerCore = { git, loadMain, gitText, applyBatch, commitNow, broadcast };

	return {
		/** Connect a device or agent; batches it sends are stamped with its user. */
		connect(peer: Peer) {
			peers.add(peer);
			return {
				hello: (seq: number) => serially(() => hello(seq, peer.device)),
				push: (batch: Batch) =>
					serially(async () => {
						const { outcome, broadcast: message } = await applyBatch(batch, peer);
						if (message !== null) {
							await beforeAck();
							broadcast(message, peer);
						}
						return outcome;
					}),
				close() {
					peers.delete(peer);
				},
			};
		},
		/** Commit the overlay now (`epicenter pull` asks for this). */
		commit: () => serially(() => commitNow()),
		/** Commit when the oldest overlay change is due. */
		tick: () =>
			serially(async (): Promise<Result<Committed | null, CommitError>> => {
				const oldest = first<{ at: number | null }>(driver, 'SELECT min(at) AS at FROM overlay')?.at ?? null;
				if (oldest === null || now() - oldest < commitAfterMs) return Ok(null);
				const committed = await commitNow();
				if (committed.error !== null) log.warn(ServerDiagnostic.TimedCommitFailed({ cause: committed.error }));
				return committed;
			}),
		/** Merge a commit already in the Git store into main as one agent batch. */
		receivePush: (input: { commit: string; user: string }) => serially(() => receivePush(core, input)),
		/** The server's current text of a file. */
		read: (path: string) => serially(() => current(path)),
		/** How many files the overlay holds: what Git does not yet. */
		overlaySize: () => first<{ n: number }>(driver, 'SELECT count(*) AS n FROM overlay')?.n ?? 0,
		sequence: () => state('seq'),
	};
}
export type RepositoryServer = ReturnType<typeof createRepositoryServer>;
/** What an agent push needs from the server, without its connection surface. */
export type ServerCore = {
	git: GitStore;
	loadMain(): Promise<{ oid: string | null; tree: Tree; seq: number }>;
	gitText(oid: string): Promise<string | null>;
	applyBatch(batch: Batch, peer: Peer, numbered?: boolean): Promise<{ outcome: BatchOutcome; broadcast: Broadcast | null }>;
	commitNow(extraParents?: string[]): Promise<Result<Committed | null, CommitError>>;
	broadcast(message: Broadcast, from: Peer | null): void;
};
