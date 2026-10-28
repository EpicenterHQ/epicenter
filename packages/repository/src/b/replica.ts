/**
 * Design B's replica, revised: a clone with a short local branch.
 *
 * Per file, four levels: `base` (the text at the commit this device stands
 * on, its position), `sent` (the text in its commit awaiting an answer),
 * `committed` (the text in its newest commit, not yet sent, amended until it
 * is), and `mine` (what it shows and types into). Typing changes `mine`; a
 * commit takes `mine` after a 0.5 s pause or every 2 s while typing, leaving
 * out held text (which would break parsing; a missing file below counts as
 * one that must parse). One commit is sent at a time, on top of the
 * position, in merge mode for a person: the answer is `main` and its texts,
 * which become the bases, with anything newer merged on top here.
 *
 * Notifications name a commit and its parents. One whose first parent is
 * the position is applied (its texts read by hash); one that cannot be
 * placed waits briefly, then the device catches up by walking history.
 * Requests go one at a time; a lost one is sent again, and a resent commit
 * is answered with its recorded outcome.
 *
 * Its whole state round-trips through `store` as JSON. Rules the revised
 * design does not state are marked `RULE:`.
 */
import { gitBlobHash } from '../hash.js';
import { parseMarkdown, passesParseGate, sameValue } from '../markdown.js';
import { merge, withMarkers } from '../merge.js';
import { type CatchUp, commitId, type Event, type LiveCommit, type PushAnswer } from './server.js';

export type Request =
	| { type: 'push'; rid: number; commit: LiveCommit }
	| { type: 'catch-up'; rid: number; from: string | null; paths: { path: string; at?: string }[] }
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
	/** An edit of a note deleted and replaced, saved beside it. */
	| { kind: 'sibling'; path: string; of: string }
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
	/**
	 * RULE: the server deleted this file under work this device had not sent.
	 * `base` stays the text that work was made on, and `from` the commit it was
	 * at, which the commit names so the server can tell a restore from a
	 * replacement. A note created at the path meanwhile is not merged into it here.
	 */
	gone?: { from: string };
	/**
	 * RULE: this device does not know the path's text (it dropped a record it
	 * could no longer trust and asked again); nothing at the path is committed
	 * until the answer comes, so no commit claims to write over a text it never saw.
	 */
	unknown?: true;
	/**
	 * RULE: the commit `base` was taken at. A file's base can be older than the
	 * position (a path the device had no news of), so a commit names this, not
	 * the position, as the commit its kept work was made on.
	 */
	at?: string;
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
	/** Paths the next catch-up names, besides what history walks to. */
	refresh: string[];
	notices: Notice[];
	refusals: { paths: string[]; reason: string }[];
	next: number;
};

/** A merge the test audits: local work made at `baseAt`, merged with a text from `incomingAt`. */
export type MergeAudit = { path: string; baseAt: string | undefined; incomingAt: string };

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
	pause = 500,
	most = 2_000,
	onMerge,
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
	/** Commit after this long without typing… */
	pause?: number;
	/** …or at most this long after the first change not yet committed. */
	most?: number;
	onMerge?: (audit: MergeAudit) => void;
}) {
	const loaded = store.load();
	const state: Persisted =
		loaded === null
			? { position: null, passed: [], files: {}, inflight: null, landing: null, refresh: [], notices: [], refusals: [], next: 1 }
			: (JSON.parse(loaded) as Persisted);
	const files = new Map(Object.entries(state.files));
	const passed = new Set(state.passed);
	/** Notifications not yet placed, by the commit they follow. */
	const waiting = new Map<string, Event>();
	/** The refresh paths the catch-up in flight named. */
	let asked = new Set<string>();
	let send: ((request: Request) => void) | null = null;
	let pending: { rid: number; kind: Request['type'] } | null = null;
	/** A catch-up or notification whose texts are being read. */
	let reading: ({ catchUp: CatchUp } | { event: Event }) & { have: Map<string, string> } | null = null;
	// A process starts by catching up.
	let needCatchUp = true;
	let gapArmed = false;
	let alive = true;
	let lastTyped = 0;
	let uncommittedSince: number | null = null;
	let tickAt = Number.POSITIVE_INFINITY;
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
		const empty =
			next.base === null && next.mine === null && next.sent === undefined && next.committed === undefined && next.gone === undefined && next.unknown === undefined;
		if (empty) files.delete(path);
		else files.set(path, next);
	};
	/** What the server will have once this device's commits land. */
	const tip = (f: FileRecord) => (f.committed ?? f.sent ?? { text: f.gone ? null : f.base }).text;
	const hasWork = (f: FileRecord) => f.sent !== undefined || f.committed !== undefined || f.gone !== undefined || f.mine !== f.base;

	// ==========================================================================
	// Committing and sending
	// ==========================================================================

	/** Take `mine` into the newest unsent commit, amending it, leaving held text out. */
	function commit() {
		uncommittedSince = null;
		tickAt = Number.POSITIVE_INFINITY;
		for (const [path, f] of [...files]) {
			if (f.unknown || f.mine === tip(f) || !passesParseGate(path, tip(f), f.mine)) continue;
			const under = (f.sent ?? { text: f.gone ? null : f.base }).text;
			if (f.mine === under && f.gone !== undefined && f.sent === undefined) forget(path);
			else if (f.mine === under) {
				const { committed: _, ...rest } = f;
				set(path, rest);
			} else set(path, { ...f, committed: { text: f.mine } });
		}
		stats.commits++;
		save();
		pump();
	}

	/** RULE: work kept through a delete, deleted here too, leaves nothing to keep, and its base is stale: ask for the path again. */
	function forget(path: string) {
		set(path, { base: null, mine: null, unknown: true });
		state.refresh.push(path);
		needCatchUp = true;
	}

	function schedule() {
		const at = Math.min(lastTyped + pause, (uncommittedSince ?? lastTyped) + most);
		if (at >= tickAt) return;
		tickAt = at;
		after(Math.max(0, at - now()), () => {
			if (!alive || tickAt !== at) return;
			tickAt = Number.POSITIVE_INFINITY;
			// Typing went on: wait for the pause, or the cap.
			if (now() < Math.min(lastTyped + pause, (uncommittedSince ?? now()) + most)) return schedule();
			commit();
		});
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
		const named = [...new Set([...state.refresh, ...(state.landing?.files.map((f) => f.path) ?? [])])];
		asked = new Set(state.refresh);
		const paths = named.map((path) => {
			const at = files.get(path)?.at;
			return at === undefined ? { path } : { path, at };
		});
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
			files: ready.map(([path, f]) => ({ path, text: f.committed?.text ?? null, ...(f.gone === undefined ? {} : { from: f.gone.from }) })),
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

	/** Merge one level onto another; the server's text wins a field clash, and a value of mine it keeps out is noted. */
	function rebase(path: string, base: string | null, current: string | null, incoming: string | null) {
		if (incoming === base) return current;
		if (current === base) return incoming;
		const result = merge(base, current, incoming);
		for (const overlap of result.overlaps)
			if (overlap.unit === 'field' && overlap.incoming !== undefined && overlap.current !== undefined && !sameValue(overlap.current, overlap.incoming))
				state.notices.push({ kind: 'field', path, key: overlap.key, yours: overlap.incoming, kept: overlap.current });
		return withMarkers(result, { current: 'main', incoming: device });
	}

	/**
	 * A path's text on `main` at commit `at` is `text`. `landed` when that
	 * commit holds this device's sent commit, whose text the local work above
	 * it was made on.
	 */
	function integrate(path: string, text: string | null, at: string, landed: boolean) {
		// The path's text is known from here on.
		const { unknown: _, ...f } = record(path);
		const own = landed && f.sent !== undefined;
		// RULE: a path in the commit awaiting its answer waits for that answer, which brings it.
		if (f.sent !== undefined && !own) return;
		if (f.gone !== undefined && !own) return;
		const below = own ? (f.sent?.text ?? null) : f.base;
		if (own) {
			// A field this commit set that the server's merge kept out.
			const before = fieldsOf(f.base);
			const now_ = fieldsOf(text);
			for (const [key, value] of Object.entries(fieldsOf(f.sent?.text ?? null)))
				if (!sameValue(value, before[key]) && !sameValue(now_[key], value))
					state.notices.push({ kind: 'field', path, key, yours: value, kept: now_[key] });
		}
		if (hasWork(f) && below !== null) onMerge?.({ path, baseAt: f.at, incomingAt: at });
		const committed = f.committed === undefined ? undefined : rebase(path, below, text, f.committed.text);
		const mine = rebase(path, f.committed === undefined ? below : f.committed.text, committed ?? text, f.mine);
		if (text === null && mine !== null && !own) {
			// Deleted elsewhere under work not sent: keep it, made on the old note.
			set(path, { ...f, mine, ...(committed === undefined ? {} : { committed: { text: committed } }), gone: { from: f.at ?? state.position ?? at } });
			if (committed === undefined) dirty();
			return;
		}
		const next: FileRecord = { base: text, mine, at };
		if (committed !== undefined && committed !== text) next.committed = { text: committed };
		set(path, next);
		// RULE: a merge that leaves work committable (held text that parses now) commits it after the pause, as typing would.
		if (mine !== tip(next) && passesParseGate(path, tip(next), mine)) dirty();
	}

	function dirty() {
		lastTyped = now();
		uncommittedSince ??= lastTyped;
		schedule();
	}

	/** Move work on `from` that `main` put beside it, at `to`, and take `main`'s note at `from`. */
	function beside(from: string, to: string, texts: Map<string, string | null>, at: string) {
		const f = record(from);
		const sibling = texts.get(to) ?? f.sent?.text ?? null;
		set(to, { base: sibling, mine: f.mine, ...(f.committed === undefined ? {} : { committed: f.committed }), at });
		const text = texts.get(from) ?? null;
		set(from, { base: text, mine: text, at });
	}

	function onLanded(answer: Extract<PushAnswer, { kind: 'applied' | 'merged' }>) {
		state.inflight = null;
		if (answer.kind === 'applied') stats.applied++;
		else stats.merged++;
		const texts = new Map(answer.files.map((f) => [f.path, f.text]));
		const moved = new Set<string>();
		for (const { from, to } of answer.siblings) {
			beside(from, to, texts, answer.main);
			state.notices.push({ kind: 'sibling', path: to, of: from });
			moved.add(from).add(to);
		}
		for (const id of answer.commits) pass(id);
		prune();
		for (const file of answer.files) {
			if (moved.has(file.path)) continue;
			const f = record(file.path);
			if (file.replaced && !f.unknown && f.sent === undefined && f.gone === undefined && hasWork(f) && state.position !== null) {
				// History says the path holds another note now: the work here stays on the old one.
				set(file.path, { ...f, gone: { from: f.at ?? state.position } });
				continue;
			}
			integrate(file.path, file.text, answer.main, true);
		}
		for (const path of answer.restored) state.notices.push({ kind: 'restored', path });
		for (const path of answer.kept) state.notices.push({ kind: 'kept', path });
		for (const overlap of answer.overlaps)
			if (overlap.unit === 'body' || overlap.unit === 'block') state.notices.push({ kind: 'overlap', path: overlap.path, unit: overlap.unit });
		state.position = answer.main;
		pass(answer.main);
	}

	/**
	 * RULE: a commit whose outcome left with a flush: rebuild its notices from
	 * the flush's trailers, then catch up. The trailers do not say which live
	 * commit a sibling came from, so they make notices only; the catch-up's
	 * history says what the files are.
	 */
	function onFlushed(message: string) {
		const sent = state.inflight;
		state.inflight = null;
		state.landing = sent;
		for (const line of message.split('\n')) {
			const overlap = /^Epicenter-Overlap: (.+?) (body|block|field \S+|file \S+) \(([^,]+), ([^)]+)\)$/.exec(line);
			if (overlap !== null && overlap[4] === `${user}/${device}` && (overlap[2] === 'body' || overlap[2] === 'block'))
				state.notices.push({ kind: 'overlap', path: overlap[1] ?? '', unit: overlap[2] });
			const sibling = /^Epicenter-Sibling: (.+) from (.+)$/.exec(line);
			if (sibling !== null && (sibling[1] ?? '').includes(`(${device}, `) && sent?.files.some((f) => f.path === sibling[2]))
				state.notices.push({ kind: 'sibling', path: sibling[1] ?? '', of: sibling[2] ?? '' });
		}
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
			case 'refused':
			case 'invalid':
			case 'precondition-required': {
				stats.refused++;
				const sent = state.inflight;
				state.inflight = null;
				const reason = answer.kind === 'precondition-required' ? 'no parent' : answer.reason;
				state.refusals.push({ paths: sent?.files.map((f) => f.path) ?? [], reason });
				// The change is dropped: an agent reads again and redoes its task. (A person's commit is never refused.)
				// RULE: a refusal brings no texts, and notifications for these paths waited for the answer, so ask for them again.
				for (const file of sent?.files ?? []) forget(file.path);
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
		// RULE: notifications can move the position past what a catch-up answered while it was in flight: an answer already passed is old.
		if (state.position !== null && reply.main !== state.position && passed.has(reply.main)) {
			if (state.landing !== null || state.refresh.length > 0) needCatchUp = true;
			return;
		}
		// A text that cannot be found is never taken as a delete: ask again.
		if (reply.files.some((f) => f.hash !== null && !texts.has(f.hash))) {
			needCatchUp = true;
			return;
		}
		const from = state.position;
		const landed = new Set(state.landing?.files.map((f) => f.path) ?? []);
		const lookup = (path: string) => {
			const hash = reply.files.find((f) => f.path === path)?.hash ?? null;
			return hash === null ? null : (texts.get(hash) ?? null);
		};
		const named = new Set(reply.files.map((f) => f.path));
		for (const file of reply.files) {
			const f = record(file.path);
			if (file.replaced && !f.unknown && !landed.has(file.path) && hasWork(f) && f.gone === undefined && f.sent === undefined && from !== null) {
				// RULE: history says the path holds another note now: the work here stays on the old one, for the server to put beside it.
				set(file.path, { ...f, gone: { from: f.at ?? from } });
				continue;
			}
			if (file.replaced && landed.has(file.path) && from !== null) {
				// The same, after this device's commit landed: what it typed since stays on the old note, and with nothing since, the new note is taken.
				const { sent: _, ...rest } = f;
				if (f.committed !== undefined || f.mine !== (f.sent?.text ?? null)) set(file.path, { ...rest, gone: { from: f.at ?? from } });
				else set(file.path, { base: lookup(file.path), mine: lookup(file.path), at: reply.main });
				continue;
			}
			integrate(file.path, lookup(file.path), reply.main, landed.has(file.path));
		}
		if (reply.full) for (const [path, f] of [...files]) if (!named.has(path) && f.base !== null) integrate(path, null, reply.main, false);
		for (const id of reply.commits) pass(id);
		state.landing = null;
		state.refresh = state.refresh.filter((path) => !asked.has(path));
		if (state.refresh.length > 0) needCatchUp = true;
		state.position = reply.main;
		pass(reply.main);
		prune();
	}

	function applyEvent(event: Event, texts: Map<string, string>) {
		if (event.files.some((f) => f.hash !== null && !texts.has(f.hash))) return;
		waiting.delete(event.parents[0] ?? '');
		for (const file of event.files) integrate(file.path, file.hash === null ? null : (texts.get(file.hash) ?? null), event.commit, false);
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
		// RULE: nothing is applied while a commit is in flight; its answer brings everything since its parent.
		for (let event = next(); event !== undefined && state.inflight === null; event = next()) {
			const have = known();
			const lacking = missing(event.files.map((f) => f.hash), have);
			if (lacking.length > 0) {
				// A ready commit goes first (see `pump`).
				if (pending !== null || send === null || [...files.values()].some((f) => f.committed !== undefined)) break;
				reading = { event, have };
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

	// RULE: work typed before a restart and not yet committed is committed after the pause, like fresh typing.
	if ([...files].some(([path, f]) => f.mine !== tip(f) && passesParseGate(path, tip(f), f.mine))) dirty();

	return {
		device,
		/** What this device shows for a path, or null for no file. */
		read: (path: string) => files.get(path)?.mine ?? null,
		/** Every path this device shows. */
		paths: () => [...files].filter(([, f]) => f.mine !== null).map(([path]) => path).sort(),
		/** Every file's base and mine, and whether it has nothing unsent, for checks. */
		files: () =>
			new Map(
				[...files].map(([path, f]) => [
					path,
					{ base: f.gone ? null : f.base, mine: f.mine, settled: f.sent === undefined && f.committed === undefined && f.gone === undefined },
				]),
			),
		/**
		 * Save texts at once (null deletes). They are committed together after a
		 * pause; a rename is a delete of the old path and a write of the new one.
		 * `commitMode` sets the mode of the commit they go in; `now` commits at once.
		 */
		write(changes: Record<string, string | null>, { commitMode, now: immediately = false }: { commitMode?: 'merge' | 'fast-forward'; now?: boolean } = {}) {
			for (const [path, text] of Object.entries(changes)) {
				const f = record(path);
				if (text === null && f.gone !== undefined && f.sent === undefined) forget(path);
				else set(path, { ...f, mine: text });
			}
			if (commitMode !== undefined) nextMode = commitMode;
			save();
			if (immediately || (pause === 0 && most === 0)) commit();
			else dirty();
		},
		/** Commit now, without waiting for the pause. */
		commit,
		/** Files whose shown text is held back because it would break parsing. */
		held: () => [...files].filter(([path, f]) => f.mine !== tip(f) && !passesParseGate(path, tip(f), f.mine)).map(([path]) => path),
		/** Whether anything is waiting to commit, to send, for an answer, or to be caught up. */
		busy: () =>
			pending !== null ||
			needCatchUp ||
			state.inflight !== null ||
			state.landing !== null ||
			uncommittedSince !== null ||
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
			// This device's commit in flight, or the merge that takes it in (as second parent), is answered by the push.
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
						reading = { catchUp: reply, have };
						stats.fetches++;
						request({ type: 'fetch', rid: state.next++, hashes: lacking });
					}
					break;
				}
				case 'fetched': {
					const was = reading;
					reading = null;
					// RULE: the texts held when the read was asked, not now: a record dropped meanwhile took its text with it.
					const texts = new Map([...(was?.have ?? []), ...known(), ...Object.entries(message.texts)]);
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
