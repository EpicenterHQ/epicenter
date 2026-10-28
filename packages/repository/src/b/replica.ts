/**
 * Design B's replica: per file `base` (the server's text as last heard) and
 * `mine` (what this device shows and types into), the position it last
 * heard, and a sync loop that sends every ready file in one conditional
 * write. On `applied` the base becomes what was sent; on `stale` the
 * server's text is merged into `mine` and the files go again. A person is
 * never refused for someone else's change; an agent is (`mode: 'agent'`).
 *
 * Writes, catch-ups and reads of texts by hash are requests, each answered
 * by a reply, one at a time. Updates come on a separate one-way stream that
 * says only "the tree is now T; these paths changed, to these hashes".
 * Nothing orders a notification against a reply, and notifications can
 * arrive late, out of order, or not at all (a lost one closes the stream).
 * A notification names no tree it follows, so the replica cannot place it:
 * it is a hint, and a tree other than the one held sends a catch-up by tree
 * diff, whose texts are then read by hash. Replies are taken in the order
 * the device sent its requests, which is the server's order for them.
 *
 * Its whole state round-trips through `store` as JSON. Rules the design
 * README does not state are marked `RULE:` and listed in the report.
 */
import { gitBlobHash } from '../hash.js';
import { breaksParsing, sameValue } from '../markdown.js';
import { merge, withMarkers } from '../merge.js';
import type { CatchUp, Event, FileState, Unanswered, WriteAnswer, WriteFile } from './server.js';

export type Request =
	| { type: 'write'; rid: number; files: WriteFile[] }
	| { type: 'catch-up'; rid: number; from: string | null; paths: string[]; unanswered: Unanswered[] }
	| { type: 'fetch'; rid: number; hashes: string[] };
export type Reply =
	| { type: 'answer'; rid: number; answer: WriteAnswer }
	| { type: 'caught-up'; rid: number; catchUp: CatchUp }
	| { type: 'fetched'; rid: number; texts: Record<string, string> };

/** Something of yours that did not land as typed. Kept until dismissed. */
export type Notice =
	/** A field value someone else's change kept out. */
	| { kind: 'field'; path: string; key: string; yours: unknown; kept: unknown }
	/** A stale edit of a note deleted and replaced, saved beside it. */
	| { kind: 'sibling'; path: string; of: string }
	/** RULE: your delete lost to an edit you had not seen; the file stays. */
	| { kind: 'kept'; path: string }
	/** RULE: deleted elsewhere; your unsent edit brings it back. */
	| { kind: 'restored'; path: string };

type FileRecord = {
	base: string | null;
	mine: string | null;
	/**
	 * RULE: the server deleted this file under unsent edits. `base` stays the
	 * text they were made on, the merge base if the note comes back.
	 */
	gone?: true;
	/** The hash of a `mine` the server refused; not sent again until it changes. */
	refused?: string;
	/** The note `base` belongs to (see `FileHash.note`); absent for a file this device created and has not heard back about. */
	note?: number;
};

type Persisted = {
	/** The tree whose content every base matches, but those `ahead`; null before the first catch-up. */
	at: string | null;
	/** RULE: paths whose base came from a reply ahead of `at`. The next catch-up names them. */
	ahead: Record<string, true>;
	files: Record<string, FileRecord>;
	/** RULE: the write sent and not yet answered is persisted, so a lost reply or a restart can tell what was sent. */
	inflight: WriteFile[] | null;
	notices: Notice[];
	refusals: { paths: string[]; reason: string }[];
	next: number;
};

/** A merge the test audits: which note the unsent edits were made on, and which note they merged into. */
export type MergeAudit = { path: string; note: number | undefined; incoming: number | null };

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

const hashOf = (text: string | null) => (text === null ? null : gitBlobHash(text));

export function createReplica({
	device,
	mode = 'person',
	store,
	after,
	timeout = 2_000,
	today = () => '2026-10-28',
	onMerge,
}: {
	device: string;
	mode?: 'person' | 'agent';
	store: Store;
	/** Run `run` after `ms` (the host's timer). */
	after: (ms: number, run: () => void) => void;
	/** A request unanswered this long is taken as lost. */
	timeout?: number;
	today?: () => string;
	onMerge?: (audit: MergeAudit) => void;
}) {
	const loaded = store.load();
	const state: Persisted =
		loaded === null
			? { at: null, ahead: {}, files: {}, inflight: null, notices: [], refusals: [], next: 1 }
			: (JSON.parse(loaded) as Persisted);
	const files = new Map(Object.entries(state.files));
	let send: ((request: Request) => void) | null = null;
	let pending: { rid: number; kind: Request['type'] } | null = null;
	/** A catch-up whose texts are being read. */
	let reading: CatchUp | null = null;
	// A process starts by catching up.
	let needCatchUp = true;
	let lastKind: Request['type'] | null = null;
	let alive = true;
	const stats = { writes: 0, applied: 0, stale: 0, catchUps: 0, fetches: 0, fetchedTexts: 0, timeouts: 0, late: 0, notifications: 0, hints: 0 };

	const save = () => {
		state.files = Object.fromEntries(files);
		store.save(JSON.stringify(state));
	};

	/** The hash the server holds as far as this device knows. */
	const heard = (file: FileRecord) => (file.gone ? null : hashOf(file.base));
	const sentFor = (path: string) => state.inflight?.find((f) => f.path === path);

	function isReady(path: string, file: FileRecord) {
		if (file.gone) return file.mine !== null;
		if (file.mine === file.base) return false;
		if (file.refused !== undefined && file.refused === hashOf(file.mine)) return false;
		return !breaksParsing(path, file.base, file.mine);
	}

	function request(message: Request) {
		if (send === null) return;
		const { rid } = message;
		pending = { rid, kind: message.type };
		lastKind = message.type;
		send(message);
		after(timeout, () => {
			if (!alive || pending?.rid !== rid) return;
			stats.timeouts++;
			pending = null;
			reading = null;
			// A lost catch-up or read is asked again; a lost write's fate is found by the next catch-up.
			needCatchUp = true;
			pump();
		});
	}

	function catchUp() {
		stats.catchUps++;
		// RULE: cleared when asked, not when answered: a notification can arrive before the reply to a catch-up the server answered before that change.
		needCatchUp = false;
		request({
			type: 'catch-up',
			rid: state.next++,
			from: state.at,
			paths: Object.keys(state.ahead),
			unanswered: (state.inflight ?? []).map((f) => ({ path: f.path, expected: f.expected, sent: hashOf(f.text) })),
		});
		save();
	}

	function pump() {
		if (!alive || send === null || pending !== null) return;
		// A write whose answer never came is settled by a catch-up before anything else.
		if (state.inflight !== null) return catchUp();
		const ready = [...files].filter(([path, file]) => isReady(path, file));
		// Writes and catch-ups take turns, so neither starves the other.
		if (needCatchUp && (ready.length === 0 || lastKind === 'write' || state.at === null)) return catchUp();
		if (ready.length === 0) return;
		state.inflight = ready.map(([path, file]) => ({
			path,
			expected: heard(file),
			text: file.mine,
			...(file.note === undefined ? {} : { note: file.note }),
		}));
		stats.writes++;
		request({ type: 'write', rid: state.next++, files: state.inflight });
		save();
	}

	function siblingPath(path: string) {
		const slash = path.lastIndexOf('/');
		const dir = path.slice(0, slash + 1);
		const name = path.slice(slash + 1);
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const extension = dot > 0 ? name.slice(dot) : '';
		const taken = (candidate: string) => {
			const file = files.get(candidate);
			return file !== undefined && (file.base !== null || file.mine !== null);
		};
		let candidate = `${dir}${stem} (${device}, ${today()})${extension}`;
		for (let n = 2; taken(candidate); n++) candidate = `${dir}${stem} (${device}, ${today()}) ${n}${extension}`;
		return candidate;
	}

	function keepBeside(path: string, text: string) {
		const sibling = siblingPath(path);
		files.set(sibling, { base: null, mine: text });
		state.notices.push({ kind: 'sibling', path: sibling, of: path });
	}

	/**
	 * Merge `incoming` (the server's text, which wins a field clash) into
	 * `mine`, both made from `base`, and note what of mine did not land.
	 */
	function integrate(path: string, base: string | null, incoming: string | null, mine: string | null, label: string) {
		const result = merge(base, incoming, mine);
		for (const overlap of result.overlaps) {
			if (overlap.unit === 'field' && overlap.incoming !== undefined && overlap.current !== undefined && !sameValue(overlap.current, overlap.incoming))
				state.notices.push({ kind: 'field', path, key: overlap.key, yours: overlap.incoming, kept: overlap.current });
			if (overlap.unit === 'file' && overlap.clash === 'deleted')
				state.notices.push({ kind: overlap.side === 'incoming' ? 'kept' : 'restored', path });
		}
		return withMarkers(result, { current: label, incoming: device });
	}

	/** Take what the server says a file is now. */
	function receive(incoming: FileState) {
		const { path } = incoming;
		const file = files.get(path) ?? { base: null, mine: null };
		const set = (next: FileRecord) => {
			if (next.base === null && next.mine === null && !next.gone) files.delete(path);
			else files.set(path, next);
		};
		const note = incoming.note === null ? {} : { note: incoming.note };
		const take = (text: string | null): FileRecord => ({ base: text, mine: text, ...note });
		const merged = (base: string | null): FileRecord => {
			if (base !== null) onMerge?.({ path, note: file.note, incoming: incoming.note });
			const label = `server ${incoming.hash?.slice(0, 7) ?? 'deleted'}`;
			return { ...take(incoming.text), mine: integrate(path, base, incoming.text, file.mine, label) };
		};

		// Another note now holds the path: unsent edits of the old one are kept beside it, never merged in.
		if (file.note !== undefined && incoming.note !== null && incoming.note !== file.note) {
			const unsent = file.gone === true || file.mine !== file.base;
			if (unsent && file.mine !== null) keepBeside(path, file.mine);
			set(take(incoming.text));
			return;
		}
		if (file.gone) {
			// Still deleted, or brought back as the same note elsewhere: then the edits merge onto it.
			if (incoming.text !== null) set(merged(file.base));
			return;
		}
		if (file.base === incoming.text) {
			set({ ...file, ...note });
			return;
		}
		if (file.mine === file.base) {
			set(take(incoming.text));
			return;
		}
		const next = merged(file.base);
		if (incoming.text === null && next.mine !== null) {
			set({ base: file.base, mine: next.mine, gone: true, ...(file.note === undefined ? {} : { note: file.note }) });
			return;
		}
		set(next);
	}

	function onAnswer(answer: WriteAnswer) {
		const sent = state.inflight ?? [];
		switch (answer.kind) {
			case 'applied': {
				stats.applied++;
				state.inflight = null;
				for (const file of sent) {
					const record = files.get(file.path) ?? { base: null, mine: null };
					const note = answer.notes[file.path];
					const next: FileRecord = { base: file.text, mine: record.mine, ...(note == null ? {} : { note }) };
					if (next.base === null && next.mine === null) files.delete(file.path);
					else files.set(file.path, next);
				}
				if (answer.prior === state.at) {
					for (const file of sent) delete state.ahead[file.path];
					state.at = answer.tree;
				} else {
					// Others wrote since this device's tree: its tree no longer holds these bases.
					for (const file of sent) state.ahead[file.path] = true;
					needCatchUp = true;
				}
				break;
			}
			case 'stale': {
				stats.stale++;
				if (mode === 'agent') {
					// An agent is told, and its change is dropped: it reads again and redoes its task.
					for (const file of sent) {
						const record = files.get(file.path);
						if (record === undefined) continue;
						if (record.gone || record.base === null) files.delete(file.path);
						else files.set(file.path, { ...record, mine: record.base });
					}
					state.refusals.push({ paths: answer.files.map((f) => f.path), reason: 'stale' });
				}
				for (const incoming of answer.files) {
					receive(incoming);
					if (answer.tree !== state.at) state.ahead[incoming.path] = true;
				}
				if (answer.tree !== state.at) needCatchUp = true;
				state.inflight = null;
				break;
			}
			case 'refused':
			case 'precondition-required': {
				state.inflight = null;
				state.refusals.push({ paths: [answer.path], reason: answer.kind === 'refused' ? answer.reason : 'no expectation' });
				for (const file of sent) {
					const record = files.get(file.path);
					if (record === undefined) continue;
					if (mode === 'agent') files.set(file.path, { ...record, mine: record.base });
					else files.set(file.path, { ...record, refused: hashOf(record.mine) ?? '' });
				}
				break;
			}
			default:
				answer satisfies never;
		}
	}

	/** Texts this device already holds, by hash, so a catch-up reads only what it lacks. */
	function known() {
		const texts = new Map<string, string>();
		for (const file of files.values())
			for (const text of [file.base, file.mine]) if (text !== null) texts.set(gitBlobHash(text), text);
		for (const file of state.inflight ?? []) if (file.text !== null) texts.set(gitBlobHash(file.text), file.text);
		return texts;
	}

	function onCaughtUp(reply: CatchUp) {
		const have = known();
		const missing = [...new Set(reply.files.flatMap((f) => (f.hash !== null && !have.has(f.hash) ? [f.hash] : [])))];
		if (missing.length === 0) return applyCatchUp(reply, have);
		reading = reply;
		stats.fetches++;
		stats.fetchedTexts += missing.length;
		request({ type: 'fetch', rid: state.next++, hashes: missing });
	}

	function applyCatchUp(reply: CatchUp, texts: Map<string, string>) {
		const named = new Set(reply.files.map((f) => f.path));
		for (const { hash, ...rest } of reply.files) {
			const text = hash === null ? null : texts.get(hash);
			if (text === undefined) {
				needCatchUp = true;
				return;
			}
			const incoming: FileState = { ...rest, hash, text };
			const sent = sentFor(incoming.path);
			const file = files.get(incoming.path);
			// A lost reply: the server held what was sent after what it expected, so it landed and the merge starts there.
			if (sent !== undefined && file !== undefined && reply.landed.includes(incoming.path)) {
				const { gone: _, ...kept } = file;
				files.set(incoming.path, { ...kept, base: sent.text });
			}
			receive(incoming);
		}
		if (reply.full)
			for (const [path, file] of [...files]) if (!named.has(path) && heard(file) !== null) receive({ path, text: null, hash: null, note: null });
		state.at = reply.tree;
		state.ahead = {};
		state.inflight = null;
	}

	return {
		device,
		mode,
		/** What this device shows for a path, or null for no file. */
		read: (path: string) => files.get(path)?.mine ?? null,
		/** Every path this device shows. */
		paths: () => [...files].filter(([, f]) => f.mine !== null).map(([path]) => path).sort(),
		/** Every file's base and mine, for checks. */
		files: () => new Map([...files].map(([path, f]) => [path, { base: f.gone ? null : f.base, mine: f.mine, gone: f.gone === true }])),
		/**
		 * Save texts at once (null deletes); they go together in the next write.
		 * A rename is a delete of the old path and a write of the new one.
		 */
		write(changes: Record<string, string | null>) {
			for (const [path, text] of Object.entries(changes)) {
				const file = files.get(path) ?? { base: null, mine: null };
				if (text === null && (file.gone || file.base === null)) files.delete(path);
				else files.set(path, { ...file, mine: text });
			}
			save();
			pump();
		},
		/** Files this device holds back because they would break parsing. */
		held: () => [...files].filter(([path, f]) => !f.gone && f.mine !== f.base && breaksParsing(path, f.base, f.mine)).map(([path]) => path),
		/** Whether anything is ready to send, waiting for an answer, or not yet caught up. */
		busy: () => pending !== null || needCatchUp || state.inflight !== null || [...files].some(([path, f]) => isReady(path, f)),
		notices: () => [...state.notices],
		refusals: () => [...state.refusals],
		tree: () => state.at,
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
		/** A notification is a hint: a tree other than this device's sends a catch-up. */
		notify(event: Event) {
			if (!alive) return;
			stats.notifications++;
			if (event.tree === state.at) return;
			stats.hints++;
			needCatchUp = true;
			pump();
		},
		reply(message: Reply) {
			if (!alive) return;
			// A reply to a request that timed out is ignored: what it said is found again by the next catch-up.
			if (pending?.rid !== message.rid) {
				stats.late++;
				return;
			}
			pending = null;
			switch (message.type) {
				case 'answer':
					onAnswer(message.answer);
					break;
				case 'caught-up':
					onCaughtUp(message.catchUp);
					break;
				case 'fetched': {
					const catchUp = reading;
					reading = null;
					if (catchUp !== null) applyCatchUp(catchUp, new Map([...known(), ...Object.entries(message.texts)]));
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
