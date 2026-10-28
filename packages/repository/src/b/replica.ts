/**
 * Design B's replica, collapsed: a clone with a short local branch.
 *
 * Per file, four levels: `base` (the text at the commit this device stands
 * on, its position), `sent` (the text in its commit awaiting an answer),
 * `committed` (the text in its newest commit, not yet sent), and `mine` (what
 * it shows and types into). Every save commits at once, leaving out held
 * text (which would break parsing; a missing file below counts as one that
 * must parse). One commit is sent at a time, on top of the position, in
 * merge mode for a person; while one is in flight, or while offline, the
 * newest unsent commit is amended. The answer is `main` and its texts, which
 * become the bases, with anything newer merged on top here.
 *
 * Notifications name a commit and its parents. One whose first parent is
 * the position is applied (its texts read by hash); one that cannot be
 * placed waits briefly, then the device catches up by walking history.
 * Requests go one at a time; a lost one is sent again, and a resent commit
 * is answered with its recorded outcome.
 *
 * Its whole state round-trips through `store` as JSON. Rules the collapsed
 * design does not state are marked `RULE:`.
 */
import { gitBlobHash } from '../hash.js';
import { parseMarkdown, passesParseGate, sameValue } from '../markdown.js';
import { merge, withMarkers } from '../merge.js';
import { type CatchUp, commitId, type Event, type LiveCommit, type PushAnswer } from './server.js';

export type Request =
	| { type: 'push'; rid: number; commit: LiveCommit }
	| { type: 'catch-up'; rid: number; from: string | null; paths: string[] }
	| { type: 'fetch'; rid: number; hashes: string[] };
export type Reply =
	| { type: 'answer'; rid: number; answer: PushAnswer }
	| { type: 'caught-up'; rid: number; catchUp: CatchUp }
	| { type: 'fetched'; rid: number; texts: Record<string, string> };

/** Something of yours that did not land as typed. Kept until dismissed. */
export type Notice =
	/** A field value someone else's change kept out. */
	| { kind: 'field'; path: string; key: string; yours: unknown; kept: unknown }
	/** Lines both sides changed, now a conflict block in the file. */
	| { kind: 'overlap'; path: string; unit: string }
	/** Your delete lost to an edit you had not seen; the file stays. */
	| { kind: 'kept'; path: string }
	/** Deleted elsewhere; your edit brought it back. */
	| { kind: 'restored'; path: string };

/** A level of a file: its text, null for no file. */
type Level = { text: string | null };

type FileRecord = {
	base: string | null;
	mine: string | null;
	sent?: Level;
	committed?: Level;
};

type Persisted = {
	position: string | null;
	/** Recent positions, so a late notification is recognized as old. */
	passed: string[];
	files: Record<string, FileRecord>;
	/** The commit sent and not yet answered: sent again, unchanged, until it is. */
	inflight: LiveCommit | null;
	/** A commit answered `flushed`: the next catch-up brings its texts. */
	landing: LiveCommit | null;
	notices: Notice[];
	refusals: { paths: string[]; reason: string }[];
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

const fieldsOf = (text: string | null) => (text === null ? {} : (parseMarkdown(text).data?.fields ?? {}));
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
		loaded === null
			? { position: null, passed: [], files: {}, inflight: null, landing: null, notices: [], refusals: [], next: 1 }
			: (JSON.parse(loaded) as Persisted);
	const files = new Map(Object.entries(state.files));
	const passed = new Set(state.passed);
	/** Notifications not yet placed, by the commit they follow. */
	const waiting = new Map<string, Event>();
	let send: ((request: Request) => void) | null = null;
	let pending: { rid: number; kind: Request['type'] } | null = null;
	/** A catch-up or notification whose texts are being read. */
	let reading: { catchUp: CatchUp } | { event: Event } | null = null;
	// A process starts by catching up.
	let needCatchUp = true;
	let gapArmed = false;
	let alive = true;
	/** A merge left work to commit, once the reply is taken in. */
	let dirty = false;
	let nextMode = mode;
	const stats = { pushes: 0, applied: 0, merged: 0, refused: 0, catchUps: 0, fetches: 0, timeouts: 0, late: 0, notifications: 0, placed: 0, commits: 0 };

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
		const empty = next.base === null && next.mine === null && next.sent === undefined && next.committed === undefined;
		if (empty) files.delete(path);
		else files.set(path, next);
	};
	/** What the server will have once this device's commits land. */
	const tip = (f: FileRecord) => (f.committed ?? f.sent ?? { text: f.base }).text;
	const notice = (next: Notice) => {
		if (JSON.stringify(state.notices.at(-1)) !== JSON.stringify(next)) state.notices.push(next);
	};

	// ==========================================================================
	// Committing and sending
	// ==========================================================================

	/** Take `mine` into the newest unsent commit (a new one, or amended while one is in flight or offline), leaving held text out. */
	function commit() {
		dirty = false;
		for (const [path, f] of [...files]) {
			if (f.mine === tip(f) || !passesParseGate(path, tip(f), f.mine)) continue;
			const under = (f.sent ?? { text: f.base }).text;
			if (f.mine === under) {
				const { committed: _, ...rest } = f;
				set(path, rest);
			} else set(path, { ...f, committed: { text: f.mine } });
		}
		stats.commits++;
		save();
		pump();
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
			// A lost push is sent again as it is; a lost catch-up or read is asked again.
			if (message.type !== 'push') needCatchUp = true;
			pump();
		});
	}

	function catchUp() {
		stats.catchUps++;
		needCatchUp = false;
		const paths = state.landing?.files.map((f) => f.path) ?? [];
		request({ type: 'catch-up', rid: state.next++, from: state.position, paths });
	}

	function pump() {
		if (!alive || send === null || pending !== null) return;
		if (state.inflight !== null) {
			stats.pushes++;
			request({ type: 'push', rid: state.next++, commit: state.inflight });
			return save();
		}
		const parent = state.position;
		if (needCatchUp || state.landing !== null || parent === null) {
			catchUp();
			return save();
		}
		if (reading !== null) return;
		const ready = [...files].filter(([, f]) => f.committed !== undefined);
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
		stats.pushes++;
		request({ type: 'push', rid: state.next++, commit: sent });
		save();
	}

	// ==========================================================================
	// Taking what the server says
	// ==========================================================================

	/** Merge one level onto another; the server's text wins a field clash, and what of mine did not land is noted. */
	function rebase(path: string, base: string | null, current: string | null, incoming: string | null) {
		if (incoming === base) return current;
		if (current === base) return incoming;
		const result = merge(base, current, incoming);
		for (const overlap of result.overlaps) {
			if (overlap.unit === 'field' && overlap.incoming !== undefined && overlap.current !== undefined && !sameValue(overlap.current, overlap.incoming))
				notice({ kind: 'field', path, key: overlap.key, yours: overlap.incoming, kept: overlap.current });
			if (overlap.unit === 'file' && overlap.clash === 'deleted') notice({ kind: overlap.side === 'incoming' ? 'kept' : 'restored', path });
		}
		return withMarkers(result, { current: 'main', incoming: device });
	}

	/**
	 * A path's text on `main` is now `text`. `landed` when that holds this
	 * device's sent commit, whose text the local work above it was made on.
	 */
	function integrate(path: string, text: string | null, landed: boolean) {
		const f = record(path);
		const own = landed && f.sent !== undefined;
		// A path in the commit awaiting its answer waits for that answer, which brings it.
		if (f.sent !== undefined && !own) return;
		const below = own ? (f.sent?.text ?? null) : f.base;
		if (own) {
			// RULE: a field this commit set that the server's merge kept out is noted here, from the commit and the answer; nothing else holds the value.
			const before = fieldsOf(f.base);
			const now_ = fieldsOf(text);
			for (const [key, value] of Object.entries(fieldsOf(f.sent?.text ?? null)))
				if (!sameValue(value, before[key]) && !sameValue(now_[key], value)) notice({ kind: 'field', path, key, yours: value, kept: now_[key] });
		}
		const committed = f.committed === undefined ? undefined : rebase(path, below, text, f.committed.text);
		const mine = rebase(path, f.committed === undefined ? below : f.committed.text, committed ?? text, f.mine);
		const next: FileRecord = { base: text, mine };
		if (committed !== undefined && committed !== text) next.committed = { text: committed };
		set(path, next);
		// RULE: a merge that leaves work committable (held text that parses now) commits it, as a save would.
		if (mine !== tip(next) && passesParseGate(path, tip(next), mine)) dirty = true;
	}

	function onLanded(answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>) {
		state.inflight = null;
		if (answer.kind === 'applied') stats.applied++;
		else stats.merged++;
		for (const id of answer.commits) pass(id);
		prune();
		for (const file of answer.files) integrate(file.path, file.text, true);
		for (const path of answer.restored) notice({ kind: 'restored', path });
		for (const path of answer.kept) notice({ kind: 'kept', path });
		for (const overlap of answer.overlaps)
			if (overlap.unit === 'body' || overlap.unit === 'block') notice({ kind: 'overlap', path: overlap.path, unit: overlap.unit });
		state.position = answer.main;
		pass(answer.main);
	}

	/** A commit whose outcome was pruned after a flush: rebuild its overlap notices from the flush's trailers, then catch up. */
	function onFlushed(message: string) {
		const sent = state.inflight;
		state.inflight = null;
		state.landing = sent;
		for (const line of message.split('\n')) {
			const overlap = /^Epicenter-Overlap: (.+?) (body|block|field \S+|file \S+) \(([^,]+), ([^)]+)\) in ([0-9a-f]{7})$/.exec(line);
			if (overlap !== null && sent?.id.startsWith(overlap[5] ?? '-') && (overlap[2] === 'body' || overlap[2] === 'block'))
				notice({ kind: 'overlap', path: overlap[1] ?? '', unit: overlap[2] });
		}
		needCatchUp = true;
	}

	/** RULE: the commit's parent was pruned: put its work back as unsent, catch up from nothing, and commit it again on top. */
	function onUnknownParent() {
		const sent = state.inflight;
		state.inflight = null;
		for (const file of sent?.files ?? []) {
			const { sent: level, ...rest } = record(file.path);
			set(file.path, { ...rest, committed: rest.committed ?? level ?? { text: file.text } });
		}
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
			case 'flushed':
				onFlushed(answer.message);
				return;
			case 'unknown-parent':
				onUnknownParent();
				return;
			case 'refused':
			case 'invalid':
			case 'precondition-required': {
				stats.refused++;
				const sent = state.inflight;
				state.inflight = null;
				const reason = answer.kind === 'precondition-required' ? 'no parent' : answer.reason;
				state.refusals.push({ paths: sent?.files.map((f) => f.path) ?? [], reason });
				// The change is dropped: an agent reads again and redoes its task. (A person's commit is never refused.)
				for (const file of sent?.files ?? []) {
					const { sent: _, committed: __, ...rest } = record(file.path);
					set(file.path, { ...rest, mine: rest.base });
				}
				needCatchUp = true;
				return;
			}
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
		const landed = new Set(state.landing?.files.map((f) => f.path) ?? []);
		const named = new Set(reply.files.map((f) => f.path));
		for (const file of reply.files) integrate(file.path, file.hash === null ? null : (texts.get(file.hash) ?? null), landed.has(file.path));
		if (reply.full) for (const [path, f] of [...files]) if (!named.has(path) && f.base !== null) integrate(path, null, landed.has(path));
		for (const id of reply.commits) pass(id);
		state.landing = null;
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
		for (let event = next(); event !== undefined; event = next()) {
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
	if ([...files].some(([path, f]) => f.mine !== tip(f) && passesParseGate(path, tip(f), f.mine))) commit();

	return {
		device,
		/** What this device shows for a path, or null for no file. */
		read: (path: string) => files.get(path)?.mine ?? null,
		/** Every path this device shows. */
		paths: () => [...files].filter(([, f]) => f.mine !== null).map(([path]) => path).sort(),
		/** Every file's base and mine, and whether it has nothing unsent, for checks. */
		files: () => new Map([...files].map(([path, f]) => [path, { base: f.base, mine: f.mine, settled: f.sent === undefined && f.committed === undefined }])),
		/**
		 * Save texts at once (null deletes) and commit them together; a rename
		 * is a delete of the old path and a write of the new one. `commitMode`
		 * sets the mode of the commit they go in.
		 */
		write(changes: Record<string, string | null>, { commitMode }: { commitMode?: 'merge' | 'fast-forward' } = {}) {
			for (const [path, text] of Object.entries(changes)) set(path, { ...record(path), mine: text });
			if (commitMode !== undefined) nextMode = commitMode;
			commit();
		},
		/** Files whose shown text is held back because it would break parsing. */
		held: () => [...files].filter(([path, f]) => f.mine !== tip(f) && !passesParseGate(path, tip(f), f.mine)).map(([path]) => path),
		/** Whether anything is waiting to send, for an answer, or to be caught up. */
		busy: () =>
			pending !== null ||
			needCatchUp ||
			state.inflight !== null ||
			state.landing !== null ||
			[...files].some(([path, f]) => f.committed !== undefined || (f.mine !== tip(f) && passesParseGate(path, tip(f), f.mine))),
		notices: () => [...state.notices],
		refusals: () => [...state.refusals],
		position: () => state.position,
		stats: () => ({ ...stats }),
		/** Requests can be sent (online), or not (null). */
		attach(sender: ((request: Request) => void) | null) {
			send = sender;
			if (sender === null) {
				pending = null;
				reading = null;
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
					const reply = message.catchUp;
					const have = known();
					const lacking = missing(reply.files.map((f) => f.hash), have);
					if (lacking.length === 0) applyCatchUp(reply, have);
					else {
						reading = { catchUp: reply };
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
			if (dirty) commit();
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
