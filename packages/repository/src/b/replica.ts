/**
 * Design B's replica, phase 0a: a clone with a short local branch.
 *
 * Per file, four levels: `base` (the text at the commit this device stands
 * on, its position), `sent` (the text in its commit awaiting an answer),
 * `committed` (the text in its newest commit, not yet sent), and `mine` (what
 * it shows and types into). A save commits the files saved since they last
 * went out, at once, except held text: a text the door refuses, or one the
 * server refused, which stays held with its reason until its person saves
 * that file again. One commit is sent
 * at a time, on top of the position; while one is in flight, or offline, the
 * newest unsent commit is amended.
 *
 * Saves are conditional: `write(path, next, { over })` names the text the
 * caller started from, and if `mine` moved since, the two are merged here,
 * so a stale editor never reverts someone's synced change. `edit(path, fn)`
 * does the same for a synchronous change.
 *
 * There are no stored notices. A person reads two things: the text, whose
 * conflict blocks say what contested, and each file's state (synced,
 * sending, held with a reason). What is held is always the person's own
 * text: a text the door refuses, a text the server refused, work whose
 * outcome is unknown. A delete or field removal that loses to an edit is not
 * held: it is an intent, not typed text, and the edited file (or field) just
 * stays, visibly.
 *
 * Its whole state round-trips through `store` as JSON. Rules the design does
 * not state are marked `RULE:`.
 */
import { commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { admissible, fold } from './door.js';
import type { CatchUp, Event, PushAnswer } from './server.js';
import { appendBlock, settle } from './settle.js';

export type Request =
	| { type: 'push'; rid: number; commit: LiveCommit }
	| { type: 'catch-up'; rid: number; from: string | null; paths: string[]; to?: string; after?: string }
	| { type: 'fetch'; rid: number; hashes: string[] };
export type Reply =
	| { type: 'answer'; rid: number; answer: PushAnswer }
	| { type: 'caught-up'; rid: number; catchUp: CatchUp }
	| { type: 'fetched'; rid: number; texts: Record<string, string> };

/** A level of a file: its text, null for no file. */
type Level = { text: string | null };

type FileRecord = {
	base: string | null;
	mine: string | null;
	sent?: Level;
	committed?: Level;
	/** Saved since it last went out: the next commit takes it, unless it is held or waits for a held partner. */
	saved?: true;
	/** RULE: held, with why: the person's own text that cannot go. Only a save of this path clears it. */
	held?: { reason: string };
	/** RULE: this work's commit got `outcome-unknown`: the next catch-up puts it beside what is there, never merged blindly. */
	unknown?: true;
	/** RULE: paths saved with this one (a rename's two halves): they commit together, and one held holds them all. */
	together?: string[];
};

type Persisted = {
	position: string | null;
	/** Recent positions, so a late notification is recognized as old. */
	passed: string[];
	files: Record<string, FileRecord>;
	/** The commit sent and not yet answered: sent again, unchanged, until it is. */
	inflight: LiveCommit | null;
	/** How many times the commit in flight has been sent: once means an `outcome-unknown` answer was a refusal, not a lost landing. */
	attempts: number;
	next: number;
};

export type Store = { load(): string | null; save(json: string): void };

export function createMemoryStore(): Store & { bytes(): number } {
	let json: string | null = null;
	return {
		load: () => json,
		save: (next) => {
			json = next;
		},
		bytes: () => json?.length ?? 0,
	};
}

const PASSED = 4096;

export function createReplica({
	device,
	user = device,
	mode = 'merge',
	store,
	after,
	now,
	timeout = 2_000,
	gap = 500,
}: {
	device: string;
	user?: string;
	/** How this device's commits meet a `main` that moved: a person's always merge. */
	mode?: 'merge' | 'fast-forward';
	store: Store;
	/** Run `run` after `ms` (the host's timer). */
	after: (ms: number, run: () => void) => void;
	/** The host's clock, in milliseconds. */
	now: () => number;
	/** A request unanswered this long is taken as lost. */
	timeout?: number;
	/** A notification that cannot be placed this long sends a catch-up. */
	gap?: number;
}) {
	const loaded = store.load();
	const state: Persisted =
		loaded === null ? { position: null, passed: [], files: {}, inflight: null, attempts: 0, next: 1 } : (JSON.parse(loaded) as Persisted);
	const files = new Map(Object.entries(state.files));
	const passed = new Set(state.passed);
	/** Notifications not yet placed, by the commit they follow. */
	const waiting = new Map<string, Event>();
	let send: ((request: Request) => void) | null = null;
	let pending: { rid: number; kind: Request['type'] } | null = null;
	/** A catch-up being gathered page by page, then its texts read. */
	let gathering: CatchUp | null = null;
	/** A catch-up or notification whose texts are being read. */
	let reading: { catchUp: CatchUp } | { event: Event } | null = null;
	// A process starts by catching up.
	let needCatchUp = true;
	let gapArmed = false;
	let alive = true;
	let nextMode = mode;
	/** No push before this time: the server asked this member to slow down. */
	let backoffUntil = 0;
	/** The reason of the last refusal, for an agent awaiting its verdict. */
	let lastRefusal: string | null = null;
	const labels = { current: 'main', incoming: `${user}/${device}` };
	const stats = { pushes: 0, applied: 0, merged: 0, refused: 0, catchUps: 0, fetches: 0, timeouts: 0, late: 0, notifications: 0, placed: 0, commits: 0, unknown: 0 };

	const save = () => {
		state.files = Object.fromEntries(files);
		state.passed = [...passed].slice(-PASSED);
		store.save(JSON.stringify(state));
	};
	const pass = (id: string) => {
		passed.delete(id);
		passed.add(id);
		if (passed.size > PASSED) passed.delete(passed.values().next().value as string);
	};
	const record = (path: string): FileRecord => files.get(path) ?? { base: null, mine: null };
	const set = (path: string, next: FileRecord) => {
		const empty =
			next.base === null && next.mine === null && next.sent === undefined && next.committed === undefined && next.held === undefined && next.together === undefined && next.saved === undefined;
		if (empty) files.delete(path);
		else files.set(path, next);
	};
	/** What the server will have once this device's commits land. */
	const tip = (f: FileRecord) => (f.committed ?? f.sent ?? { text: f.base }).text;
	/** Why `mine` is held back, or null when it can go. */
	const heldReason = (f: FileRecord) => f.held?.reason ?? null;

	// ==========================================================================
	// Saving, committing and sending
	// ==========================================================================

	/** Held, or saved together with a path that is held. */
	function blocked(path: string, seen = new Set<string>()): boolean {
		if (seen.has(path)) return false;
		seen.add(path);
		const f = record(path);
		return heldReason(f) !== null || (f.together ?? []).some((other) => blocked(other, seen));
	}

	/**
	 * Take the files saved since they last went out into the newest unsent
	 * commit (amended while one is in flight or offline). One the door refuses
	 * is held instead, so held text goes only with its own next save.
	 */
	function commit() {
		for (const [path, f] of [...files]) {
			if (f.saved === undefined) continue;
			const refusal = f.mine === tip(f) ? null : admissible(path, f.mine);
			if (refusal !== null) {
				const { saved: _, ...rest } = f;
				set(path, { ...rest, held: { reason: refusal } });
			}
		}
		for (const [path, f] of [...files]) {
			if (f.saved === undefined || blocked(path)) continue;
			const { saved: _, ...rest } = f;
			const under = (f.sent ?? { text: f.base }).text;
			if (f.mine === under) {
				const { committed: __, ...clean } = rest;
				set(path, clean);
			} else set(path, { ...rest, committed: { text: f.mine } });
		}
		stats.commits++;
		save();
		pump();
	}

	/** Save texts: each merged here with `mine` if `mine` moved since the text the caller started from. */
	function writeAll(changes: Record<string, string | null>, { over, commitMode }: { over?: Record<string, string | null>; commitMode?: 'merge' | 'fast-forward' } = {}) {
		// Paths equal after NFC and case folding are one path: a save goes to the spelling this device has.
		const spelled = (path: string) => {
			const nfc = path.normalize('NFC');
			return [...files.keys()].find((known) => fold(known) === fold(nfc)) ?? nfc;
		};
		const all = Object.keys(changes).map(spelled);
		for (const [given, text] of Object.entries(changes)) {
			const path = spelled(given);
			const { held: _, ...f } = record(path);
			const from = over === undefined || !(given in over) ? f.mine : (over[given] ?? null);
			const next = from === f.mine ? text : settle(from, f.mine, text, { labels }).text;
			// RULE: a save joins any group the path is already in: a new text over a rename's unsent half must still go with the other half.
			const together = [...new Set([...(f.together ?? []), ...all.filter((other) => other !== path)])];
			set(path, { ...f, mine: next, saved: true, ...(together.length === 0 ? {} : { together }) });
		}
		if (commitMode !== undefined) nextMode = commitMode;
		commit();
	}

	function request(message: Request) {
		if (send === null) return;
		const { rid } = message;
		pending = { rid, kind: message.type };
		send(message);
		after(timeout, () => {
			if (!alive || pending?.rid !== rid) return;
			stats.timeouts++;
			pending = null;
			reading = null;
			gathering = null;
			// A lost push is sent again as it is; a lost catch-up or read is asked again.
			if (message.type !== 'push') needCatchUp = true;
			pump();
		});
	}

	function catchUp() {
		stats.catchUps++;
		needCatchUp = false;
		gathering = null;
		request({ type: 'catch-up', rid: state.next++, from: state.position, paths: [] });
	}

	function pump() {
		if (!alive || send === null || pending !== null) return;
		if (state.inflight !== null) {
			stats.pushes++;
			state.attempts++;
			request({ type: 'push', rid: state.next++, commit: state.inflight });
			return save();
		}
		const parent = state.position;
		if (needCatchUp || parent === null) {
			catchUp();
			return save();
		}
		if (reading !== null || gathering !== null) return;
		// RULE: a commit waits while a path saved with it is held (a rename's halves go together).
		const ready = now() < backoffUntil ? [] : [...files].filter(([path, f]) => f.committed !== undefined && !blocked(path));
		// RULE: a ready commit goes before reading notifications: its answer brings everything since its parent, and on a busy note there is always another notification.
		if (ready.length === 0) {
			if (waiting.has(parent)) place();
			return;
		}
		const body = {
			parent,
			mode: nextMode,
			author: { user, device },
			time: new Date(Date.UTC(2026, 9, 28) + now()).toISOString(),
			files: ready.map(([path, f]) => ({ path, text: f.committed?.text ?? null })),
		};
		const sent: LiveCommit = { id: commitId(body), ...body };
		for (const [path, f] of ready) {
			const { committed, ...rest } = f;
			set(path, { ...rest, sent: committed as Level });
		}
		nextMode = mode;
		state.inflight = sent;
		state.attempts = 1;
		stats.pushes++;
		request({ type: 'push', rid: state.next++, commit: sent });
		save();
	}

	// ==========================================================================
	// Taking what the server says
	// ==========================================================================

	/**
	 * A path's text on `main` is now `text`. `landed` when that holds this
	 * device's sent commit, whose text the local work above it was made on.
	 * `deleted` when the path was deleted at some point since this device's base.
	 */
	function integrate(path: string, text: string | null, landed: boolean, deleted = false) {
		const f = record(path);
		const own = landed && f.sent !== undefined;
		// A path in the commit awaiting its answer waits for that answer, which brings it.
		if (f.sent !== undefined && !own) return;
		if (f.unknown) {
			// RULE: work whose outcome is unknown is put beside what is there, held for its person, never merged blindly.
			const work = f.committed !== undefined ? f.committed.text : f.mine;
			const mine = work === text ? text : work === null || text === null ? work : appendBlock(text, work, { current: 'main', incoming: `${labels.incoming} (outcome unknown)` });
			set(path, { base: text, mine, ...(mine === text ? {} : { held: { reason: 'outcome unknown' } }) });
			return;
		}
		const below = own ? (f.sent?.text ?? null) : f.base;
		const gone = deleted && !own;
		// Committed work is rebased onto the new text; a delete or removal that loses to an edit leaves the edit.
		let committed: string | null | undefined;
		if (f.committed !== undefined) committed = settle(below, text, f.committed.text, { deletedSince: gone, labels }).text;
		// Held or waiting text in `mine` is rebased too, and stays held: it goes only with its own save.
		const mineBelow = f.committed !== undefined ? f.committed.text : below;
		const mine = settle(mineBelow, committed !== undefined ? committed : text, f.mine, { deletedSince: gone && f.committed === undefined, labels }).text;
		const next: FileRecord = { base: text, mine };
		if (committed !== undefined && committed !== text) next.committed = { text: committed };
		if (mine !== text) {
			if (f.held !== undefined) next.held = f.held;
			if (f.saved !== undefined) next.saved = true;
		}
		// A group lasts until its own commit lands: while anything of it is unsent here.
		if (f.together !== undefined && (!own || next.committed !== undefined || next.mine !== next.base)) next.together = f.together;
		set(path, next);
	}

	function onLanded(answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>) {
		state.inflight = null;
		if (answer.kind === 'applied') stats.applied++;
		else stats.merged++;
		for (const id of answer.commits) pass(id);
		prune();
		for (const file of answer.files) integrate(file.path, file.text, true, file.deleted === true);
		state.position = answer.main;
		pass(answer.main);
	}

	function onRefused(answer: Extract<PushAnswer, { kind: 'refused' }>) {
		stats.refused++;
		const sent = state.inflight;
		state.inflight = null;
		lastRefusal = answer.reason;
		for (const file of sent?.files ?? []) {
			const { sent: level, ...rest } = record(file.path);
			if (mode === 'fast-forward') {
				// An agent's change is dropped: it reads again and redoes its task.
				const { committed: _, ...clean } = rest;
				set(file.path, { ...clean, mine: rest.base });
				continue;
			}
			// RULE: a person's refused text is never dropped: what the door refused is held with the reason; the rest goes again.
			const atFault = answer.path === undefined || answer.path === file.path;
			const partner = answer.path !== undefined && (rest.together ?? []).includes(answer.path);
			if (answer.reason !== 'rate' && !atFault && partner) {
				// Saved with the path at fault (a rename's other half): it waits with it, uncommitted.
				const { committed: _, ...clean } = rest;
				set(file.path, { ...clean, saved: true });
			} else if (answer.reason === 'rate' || !atFault) set(file.path, { ...rest, committed: rest.committed ?? level ?? { text: file.text } });
			else {
				const { committed: _, ...clean } = rest;
				set(file.path, { ...clean, held: { reason: answer.reason } });
			}
		}
		if (mode === 'fast-forward') needCatchUp = true;
		if (answer.reason === 'rate') {
			backoffUntil = now() + 1_000;
			after(1_000, pump);
		}
	}

	/**
	 * The server cannot say what became of this commit (its parent or its
	 * outcome left the window). RULE: sent once, it was refused, never landed,
	 * so its work goes back as unsent and merges normally after a full
	 * catch-up; sent more than once, an earlier send may have landed, so its
	 * work is put beside what is there, held.
	 */
	function onUnknown() {
		stats.unknown++;
		const sent = state.inflight;
		const once = state.attempts <= 1;
		state.inflight = null;
		for (const file of sent?.files ?? []) {
			const { sent: level, ...rest } = record(file.path);
			set(file.path, { ...rest, committed: rest.committed ?? level ?? { text: file.text }, ...(once ? {} : { unknown: true as const }) });
		}
		if (!once) for (const [path, f] of [...files]) if (f.committed !== undefined) set(path, { ...f, unknown: true });
		state.position = null;
		needCatchUp = true;
	}

	function onAnswer(answer: PushAnswer) {
		switch (answer.kind) {
			case 'applied':
			case 'merged':
				onLanded(answer);
				place();
				return;
			case 'refused':
				onRefused(answer);
				return;
			case 'outcome-unknown':
				onUnknown();
				return;
			default:
				answer satisfies never;
		}
	}

	/** Texts this device already holds, by hash. */
	function known() {
		const texts = new Map<string, string>();
		for (const f of files.values())
			for (const level of [f.base, f.mine, f.sent?.text ?? null, f.committed?.text ?? null]) if (level !== null) texts.set(gitBlobHash(level), level);
		return texts;
	}
	const missing = (hashes: (string | null)[], have: Map<string, string>) => [...new Set(hashes.filter((h): h is string => h !== null && !have.has(h)))];

	function applyCatchUp(reply: CatchUp, texts: Map<string, string>) {
		// RULE (kept by reasoning, no seed reaches it): a text that cannot be found is never taken as a delete, or a later save would write over a text this device never saw.
		if (reply.files.some((f) => f.hash !== null && !texts.has(f.hash))) {
			needCatchUp = true;
			return;
		}
		const named = new Set(reply.files.map((f) => f.path));
		for (const file of reply.files) integrate(file.path, file.hash === null ? null : (texts.get(file.hash) ?? null), false, file.deleted === true);
		// In a full listing, every local file not named is absent.
		if (reply.full) for (const [path, f] of [...files]) if (!named.has(path) && (f.base !== null || f.unknown)) integrate(path, null, false);
		for (const [path, f] of [...files])
			if (f.unknown) {
				const { unknown: _, ...rest } = f;
				set(path, rest);
			}
		for (const id of reply.commits) pass(id);
		state.position = reply.main;
		pass(reply.main);
		prune();
	}

	function applyEvent(event: Event, texts: Map<string, string>) {
		if (event.files.some((f) => f.hash !== null && !texts.has(f.hash))) return;
		waiting.delete(event.parents[0] ?? '');
		for (const file of event.files) integrate(file.path, file.hash === null ? null : (texts.get(file.hash) ?? null), false);
		state.position = event.commit;
		pass(event.commit);
		stats.placed++;
	}

	/** Drop waiting notifications for commits already passed: an answer or a catch-up covered them. */
	function prune() {
		for (const [parent, event] of [...waiting]) if (passed.has(event.commit)) waiting.delete(parent);
	}

	/** Apply waiting notifications that follow the position, reading their texts first. */
	function place() {
		const next = () => (state.position === null ? undefined : waiting.get(state.position));
		// RULE: nothing is applied while a commit is in flight (a delete needs no read, so this is not implied); its answer brings everything since its parent.
		for (let event = next(); event !== undefined && state.inflight === null; event = next()) {
			const have = known();
			const lacking = missing(event.files.map((f) => f.hash), have);
			if (lacking.length > 0) {
				// A ready commit goes first (see `pump`).
				if (pending !== null || send === null || [...files.values()].some((f) => f.committed !== undefined)) break;
				reading = { event };
				stats.fetches++;
				request({ type: 'fetch', rid: state.next++, hashes: lacking });
				return;
			}
			applyEvent(event, have);
		}
		if (waiting.size > 0 && !gapArmed) {
			gapArmed = true;
			after(gap, () => {
				gapArmed = false;
				if (!alive || waiting.size === 0 || (state.position !== null && waiting.has(state.position))) return;
				needCatchUp = true;
				pump();
			});
		}
	}

	// Work saved before a restart and not yet committed is committed now.
	if ([...files.values()].some((f) => f.saved !== undefined)) commit();

	return {
		device,
		/** What this device shows for a path, or null for no file. */
		read: (path: string) => files.get(path)?.mine ?? null,
		/** Every path this device shows. */
		paths: () => [...files].filter(([, f]) => f.mine !== null).map(([path]) => path).sort(),
		/** Every file's base and mine, and whether it has nothing unsent, for checks. */
		files: () =>
			new Map([...files].map(([path, f]) => [path, { base: f.base, mine: f.mine, tip: tip(f), settled: f.sent === undefined && f.committed === undefined }])),
		/**
		 * Save one path: `over` is the text the caller started from (the editor's
		 * loaded text); if `mine` moved since, the two are merged here. Without
		 * `over`, the caller asserts it started from what `read` shows now.
		 */
		write(path: string, next: string | null, { over, commitMode }: { over?: string | null; commitMode?: 'merge' | 'fast-forward' } = {}) {
			writeAll({ [path]: next }, { ...(over === undefined ? {} : { over: { [path]: over } }), ...(commitMode === undefined ? {} : { commitMode }) });
		},
		/** Save several paths in one commit (a rename is a delete of the old path and a write of the new one). */
		writeAll,
		/** Change a path from what it shows now. */
		edit(path: string, change: (text: string | null) => string | null, options: { commitMode?: 'merge' | 'fast-forward' } = {}) {
			const text = files.get(path)?.mine ?? null;
			writeAll({ [path]: change(text) }, { over: { [path]: text }, ...options });
		},
		/** Files whose text is held back, with why. */
		held: () => [...files].flatMap(([path, f]) => {
			const reason = heldReason(f);
			return reason === null ? [] : [{ path, reason }];
		}),
		/** Whether anything is waiting to send, for an answer, or to be caught up. */
		busy: () =>
			pending !== null ||
			needCatchUp ||
			gathering !== null ||
			state.inflight !== null ||
			[...files].some(([path, f]) => f.committed !== undefined || (f.saved !== undefined && !blocked(path))),
		/** One file's state: synced, sending, or held with why. */
		state(path: string): { status: 'synced' | 'sending' | 'held'; reason?: string } {
			const f = record(path);
			const reason = heldReason(f);
			if (reason !== null) return { status: 'held', reason };
			// A path saved with a held one waits for it: say so, not "sending".
			const partner = f.saved === undefined ? undefined : (f.together ?? []).find((other) => blocked(other));
			if (partner !== undefined) return { status: 'held', reason: `saved with ${partner}, which is held` };
			return f.sent !== undefined || f.committed !== undefined || f.saved !== undefined ? { status: 'sending' } : { status: 'synced' };
		},
		/** Why the last commit was refused (an agent's verdict), or null. */
		lastRefusal: () => lastRefusal,
		position: () => state.position,
		stats: () => ({ ...stats }),
		/** Requests can be sent (online), or not (null). */
		attach(sender: ((request: Request) => void) | null) {
			send = sender;
			if (sender === null) {
				pending = null;
				reading = null;
				gathering = null;
			}
			pump();
		},
		/** The notification stream opened: anything may have been missed, so catch up. */
		streamOpened() {
			needCatchUp = true;
			pump();
		},
		notify(event: Event) {
			if (!alive) return;
			stats.notifications++;
			const [parent = ''] = event.parents;
			// Old: already passed, or after a position passed that is not this one (history is a line).
			if (passed.has(event.commit) || (passed.has(parent) && parent !== state.position)) return;
			// RULE: this device's commit in flight, or the merge that takes it in (as second parent), is answered by the push.
			const sent = state.inflight;
			if (sent !== null && (event.commit === sent.id || event.parents.slice(1).includes(sent.id))) return;
			waiting.set(parent, event);
			place();
			save();
			pump();
		},
		reply(message: Reply) {
			if (!alive) return;
			// A reply to a request that timed out is ignored: the request is made again.
			if (pending?.rid !== message.rid) {
				stats.late++;
				return;
			}
			pending = null;
			switch (message.type) {
				case 'answer':
					onAnswer(message.answer);
					break;
				case 'caught-up': {
					const page = message.catchUp;
					const whole: CatchUp = gathering === null ? page : { ...page, files: [...gathering.files, ...page.files] };
					if (page.next !== null) {
						// RULE: a catch-up comes in pages up to the server's limit; the device gathers them, then applies them at once.
						gathering = whole;
						request({ type: 'catch-up', rid: state.next++, from: state.position, paths: [], to: page.main, after: page.next });
						break;
					}
					gathering = null;
					const have = known();
					const lacking = missing(whole.files.map((f) => f.hash), have);
					if (lacking.length === 0) applyCatchUp(whole, have);
					else {
						reading = { catchUp: whole };
						stats.fetches++;
						request({ type: 'fetch', rid: state.next++, hashes: lacking });
					}
					break;
				}
				case 'fetched': {
					const was = reading;
					reading = null;
					const texts = new Map([...known(), ...Object.entries(message.texts)]);
					if (was !== null && 'catchUp' in was) applyCatchUp(was.catchUp, texts);
					else if (was !== null && state.position === was.event.parents[0]) applyEvent(was.event, texts);
					place();
					break;
				}
				default:
					message satisfies never;
			}
			save();
			pump();
		},
		/** Stop: timers and late messages for this instance do nothing. */
		close() {
			alive = false;
		},
	};
}

export type Replica = ReturnType<typeof createReplica>;
