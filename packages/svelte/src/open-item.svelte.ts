/**
 * The items a page has open, one per slot, and how each is left.
 *
 * A slot shows one file at a time: the item its loader built, and the edit
 * session inside it, if any. Opening another item in a slot waits for the
 * open one's saves, then releases its session. When a save failed, or the
 * app says the item holds something unsent, opening answers `unsaved` with
 * the session it means, and the app asks the person; opening again with
 * `{ discard: session }` lets that draft go. A load that answers after a
 * newer open, leave, or forget of its slot is released and never shown.
 * Opening the item already shown does nothing.
 *
 * `resolve` acts only on the session it is given, and only while it is
 * open in its slot. It answers that session's review; an item whose file
 * was left deleted closes, and one whose file can no longer be shown as the
 * session's value opens again through the loader. `removeOpen` releases the session, waits for
 * its saves, and removes what the last one confirmed.
 *
 * `createOpenItems` keeps a slot per key, for a page with several items open
 * at once (a pane each, or a file beside another). A slot exists while it
 * shows something or an operation on it runs. `createOpenItem` is one slot.
 *
 * What an item is, how it loads, listings, refusals, and what a person is
 * told stay with the app.
 */
import type { FileCapture, SaveState, SyncChoices } from '@epicenter/folder';
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Resolved } from './edit-session.svelte.js';

type Failure = { readonly name: string; readonly message: string };

/** What the slot needs of an item's edit session. */
export type OpenSession = {
	readonly path: string;
	readonly state: SaveState<Failure>;
	settled(): Promise<SaveState<Failure>>;
	release(): void;
	adopt(): Promise<boolean>;
	resolve(choices: SyncChoices): Promise<Result<Resolved, Failure>>;
};

/** What the slot shows: an item still loading, or the open item. */
export type Shown<TKey, TItem> =
	| { readonly status: 'loading'; readonly key: TKey }
	| { readonly status: 'open'; readonly key: TKey; readonly item: TItem };

/** How an open (or leave) ended. */
export type Opening<TSession> =
	/** It happened. `left` says whether an item was left, so the app can list again. */
	| { readonly kind: 'done'; readonly left: boolean }
	/** The open item holds a draft it could not save; ask, then discard this session. */
	| { readonly kind: 'unsaved'; readonly session: TSession }
	/** A newer open, leave, forget, or close of the slot took over; nothing more was done. */
	| { readonly kind: 'superseded' };

/** What resolving the open item's review did to it. */
export type Reloaded = 'shown' | 'closed' | 'reopened';

/** How a slot loads, compares, and judges its items. */
export type OpenItemOptions<TKey, TItem, TSession extends OpenSession> = {
	/** Build the item for `key` from a fresh read; the app maps invalid rows, binary files, and failures. */
	load(key: TKey): Promise<TItem>;
	sessionOf(item: TItem): TSession | undefined;
	/**
	 * The key an item is shown under now, read whenever the slot compares or
	 * reloads: when `load` opened something other than what was asked (a row
	 * whose text is not valid, opened as text), or the item moved since (a
	 * rename keeps its session at a new path). Defaults to the asked key.
	 */
	keyOf?(item: TItem, asked: TKey): TKey;
	sameKey?(a: TKey, b: TKey): boolean;
	/** Whether the item holds input outside its session that leaving would lose. */
	holds?(item: TItem): boolean;
	/** Whether the page is closing: nothing new opens. */
	closed?(): boolean;
};

/** One slot: what it shows, and the commands that open, leave, and resolve it. */
function createSlot<TKey, TItem, TSession extends OpenSession>({
	load,
	sessionOf,
	keyOf,
	sameKey = Object.is,
	holds = () => false,
	closed = () => false,
}: OpenItemOptions<TKey, TItem, TSession>) {
	let shown = $state.raw<Shown<TKey, TItem> | undefined>();
	/** Advanced by every open, forget, and reload, so a late load shows nothing. */
	let sequence = 0;

	const item = () => (shown?.status === 'open' ? shown.item : undefined);
	/** The key what is shown is under now. */
	const keyNow = (): TKey | undefined =>
		shown === undefined
			? undefined
			: shown.status === 'open' && keyOf !== undefined
				? keyOf(shown.item, shown.key)
				: shown.key;
	const current = () => {
		const it = item();
		return it === undefined ? undefined : sessionOf(it);
	};

	function holdsUnsaved(it: TItem, state: SaveState<Failure> | undefined) {
		return state?.status === 'error' || holds(it);
	}

	/** Show what `load` builds for `key`, unless something newer took over. */
	async function show(key: TKey, mine: number): Promise<boolean> {
		shown = { status: 'loading', key };
		const loaded = await load(key);
		if (mine !== sequence || closed()) {
			sessionOf(loaded)?.release();
			return false;
		}
		shown = { status: 'open', key, item: loaded };
		return true;
	}

	/** Leave what is shown. Run with the caller's sequence number. */
	async function leave(
		mine: number,
		discard: TSession | undefined,
	): Promise<Opening<TSession>> {
		const was = shown;
		if (was === undefined) return { kind: 'done', left: false };
		if (was.status === 'loading') {
			shown = undefined;
			return { kind: 'done', left: true };
		}
		const session = sessionOf(was.item);
		const state = await session?.settled();
		if (mine !== sequence || shown !== was) return { kind: 'superseded' };
		if (
			session !== undefined &&
			holdsUnsaved(was.item, state) &&
			discard !== session
		)
			return { kind: 'unsaved', session };
		session?.release();
		shown = undefined;
		return { kind: 'done', left: true };
	}

	function forget() {
		current()?.release();
		sequence += 1;
		shown = undefined;
	}

	async function reload(): Promise<boolean> {
		const was = shown;
		const key = keyNow();
		if (was === undefined || key === undefined || closed()) return false;
		const mine = ++sequence;
		if (was.status === 'open') sessionOf(was.item)?.release();
		return show(key, mine);
	}

	return {
		/** What is shown: loading, or the open item, under the key it is shown under now. */
		get shown(): Shown<TKey, TItem> | undefined {
			const key = keyNow();
			if (shown === undefined || key === undefined) return undefined;
			return shown.status === 'open'
				? { status: 'open', key, item: shown.item }
				: shown;
		},
		get item() {
			return item();
		},
		get session() {
			return current();
		},
		/** A save is running or failed, or the item holds unsent input. */
		get unsaved() {
			const it = item();
			if (it === undefined) return false;
			const state = sessionOf(it)?.state;
			return state?.status === 'saving' || holdsUnsaved(it, state);
		},
		/** Open `key`: leave the open item, then show what the loader builds. */
		async open(
			key: TKey,
			{ discard }: { discard?: TSession } = {},
		): Promise<Opening<TSession>> {
			if (closed()) return { kind: 'superseded' };
			const now = keyNow();
			if (now !== undefined && sameKey(now, key))
				return { kind: 'done', left: false };
			const mine = ++sequence;
			const left = await leave(mine, discard);
			if (left.kind !== 'done') return left;
			if (!(await show(key, mine))) return { kind: 'superseded' };
			return left;
		},
		/** Leave the open item and show nothing. */
		leave({ discard }: { discard?: TSession } = {}) {
			return leave(++sequence, discard);
		},
		/** Close the open item without saving more; given a session, only while it is the open one. */
		forget(session?: TSession) {
			if (session === undefined || current() === session) forget();
		},
		/** Read the open item again as it is now, in a new session; nothing unsent is asked about. */
		reload,
		/**
		 * Answer `session`'s review with `choices`. A file left deleted closes
		 * the item; one that can no longer be shown as the session's value
		 * opens again through the loader. `undefined` when `session` is no
		 * longer the open one.
		 */
		async resolve(
			session: TSession,
			choices: SyncChoices,
		): Promise<Result<Reloaded, Failure> | undefined> {
			if (current() !== session) return undefined;
			const { data: resolved, error } = await session.resolve(choices);
			if (error !== null) return Err(error);
			if (current() !== session) return undefined;
			if (resolved === 'gone') {
				forget();
				return Ok('closed');
			}
			if (resolved === 'other') {
				await reload();
				return Ok('reopened');
			}
			return Ok('shown');
		},
		/** Take a newer version of the open item when it holds nothing unsaved. */
		async adopt(): Promise<boolean> {
			const it = item();
			if (it === undefined || holds(it)) return false;
			return (await sessionOf(it)?.adopt()) ?? false;
		},
		/**
		 * Remove the open item's file: release its session, wait for its saves,
		 * and remove what the last one confirmed. On success the item closes;
		 * when refused, it opens again as the file is now. `undefined` when
		 * `session` is no longer the open one. Admit the whole call.
		 */
		async removeOpen<TError>(
			session: TSession,
			remove: (file: FileCapture) => Promise<Result<undefined, TError>>,
		): Promise<Result<undefined, TError> | undefined> {
			if (current() !== session) return undefined;
			session.release();
			const { file } = await session.settled();
			const removed = await remove(file);
			if (current() === session) {
				if (removed.error === null) forget();
				else await reload();
			}
			return removed;
		},
		/**
		 * Wait for the open item's saves and release it. Answers its path when
		 * a draft could not be saved, which ends with the page.
		 */
		async close(): Promise<string | undefined> {
			sequence += 1;
			const it = item();
			const session = it === undefined ? undefined : sessionOf(it);
			const state = await session?.settled();
			session?.release();
			return state?.status === 'error' ? state.file.path : undefined;
		},
	};
}

type Slot<TKey, TItem, TSession extends OpenSession> = ReturnType<
	typeof createSlot<TKey, TItem, TSession>
>;

/**
 * A slot per key, each one open item. `slot(key)` answers that slot's
 * commands; the slot is made by its first command and dropped once it shows
 * nothing and no command on it runs, so a load still running always finds
 * the slot it was started in.
 */
export function createOpenItems<
	TSlot,
	TKey,
	TItem,
	TSession extends OpenSession,
>(options: OpenItemOptions<TKey, TItem, TSession>) {
	type Entry = { readonly slot: Slot<TKey, TItem, TSession>; running: number };
	const slots = new SvelteMap<TSlot, Entry>();

	/** Drop `entry` once it shows nothing and nothing on it runs. */
	function prune(entry: Entry) {
		if (entry.running > 0 || entry.slot.shown !== undefined) return;
		for (const [name, held] of slots) if (held === entry) slots.delete(name);
	}

	/**
	 * Run `command` on the slot named `name`, making it if needed. The command
	 * starts at once, before anything is awaited, so commands keep the order
	 * of their calls.
	 */
	async function run<T>(
		name: TSlot,
		command: (slot: Slot<TKey, TItem, TSession>) => Promise<T>,
	): Promise<T> {
		let entry = slots.get(name);
		if (entry === undefined) {
			entry = { slot: createSlot(options), running: 0 };
			slots.set(name, entry);
		}
		entry.running += 1;
		try {
			return await command(entry.slot);
		} finally {
			entry.running -= 1;
			prune(entry);
		}
	}

	/** The slot whose open item's session is `session`. */
	function holding(session: TSession): TSlot | undefined {
		for (const [name, entry] of slots)
			if (entry.slot.session === session) return name;
		return undefined;
	}

	/** One slot's view and commands, under `name`. */
	function slot(name: TSlot) {
		const now = () => slots.get(name)?.slot;
		return {
			/** What is shown: loading, or the open item, under the key it is shown under now. */
			get shown(): Shown<TKey, TItem> | undefined {
				return now()?.shown;
			},
			get item(): TItem | undefined {
				return now()?.item;
			},
			get session(): TSession | undefined {
				return now()?.session;
			},
			/** A save is running or failed, or the item holds unsent input. */
			get unsaved(): boolean {
				return now()?.unsaved ?? false;
			},
			/** Open `key`: leave the open item, then show what the loader builds. */
			open(key: TKey, choice: { discard?: TSession } = {}) {
				return run(name, (it) => it.open(key, choice));
			},
			/** Leave the open item and show nothing. */
			leave(choice: { discard?: TSession } = {}) {
				return run(name, (it) => it.leave(choice));
			},
			/** Close the open item without saving more; given a session, only while it is the open one. */
			forget(session?: TSession) {
				const entry = slots.get(name);
				if (entry === undefined) return;
				entry.slot.forget(session);
				prune(entry);
			},
			/** Read the open item again as it is now, in a new session; nothing unsent is asked about. */
			async reload(): Promise<boolean> {
				if (now() === undefined) return false;
				return run(name, (it) => it.reload());
			},
			/** Answer `session`'s review; `undefined` when it is no longer the open one. */
			async resolve(
				session: TSession,
				choices: SyncChoices,
			): Promise<Result<Reloaded, Failure> | undefined> {
				if (now()?.session !== session) return undefined;
				return run(name, (it) => it.resolve(session, choices));
			},
			/** Take a newer version of the open item when it holds nothing unsaved. */
			async adopt(): Promise<boolean> {
				if (now() === undefined) return false;
				return run(name, (it) => it.adopt());
			},
			/**
			 * Remove the open item's file: release its session, wait for its saves,
			 * and remove what the last one confirmed. On success the item closes;
			 * when refused, it opens again as the file is now. `undefined` when
			 * `session` is no longer the open one. Admit the whole call.
			 */
			async removeOpen<TError>(
				session: TSession,
				remove: (file: FileCapture) => Promise<Result<undefined, TError>>,
			): Promise<Result<undefined, TError> | undefined> {
				if (now()?.session !== session) return undefined;
				return run(name, (it) => it.removeOpen(session, remove));
			},
			/**
			 * Wait for the open item's saves and release it. Answers its path when
			 * a draft could not be saved, which ends with the page.
			 */
			async close(): Promise<string | undefined> {
				if (now() === undefined) return undefined;
				return run(name, (it) => it.close());
			},
		};
	}

	/** The slots that show something or have a command running. */
	const keys = (): TSlot[] => [...slots.keys()];

	return {
		slot,
		keys,
		/** Each open item's session, in every slot. */
		sessions(): TSession[] {
			return [...slots.values()].flatMap(({ slot: it }) =>
				it.session === undefined ? [] : [it.session],
			);
		},
		/** The slot whose open item's session is `session`, if any. */
		holding,
		/**
		 * The slot `from` is now named `to`, as when its file moved. Refused,
		 * changing nothing, when `to` is taken.
		 */
		move(from: TSlot, to: TSlot): boolean {
			const entry = slots.get(from);
			if (entry === undefined || slots.has(to)) return false;
			slots.delete(from);
			slots.set(to, entry);
			return true;
		},
		/** Answer `session`'s review, in whichever slot has it open; `undefined` when none does. */
		async resolve(
			session: TSession,
			choices: SyncChoices,
		): Promise<Result<Reloaded, Failure> | undefined> {
			const name = holding(session);
			return name === undefined
				? undefined
				: slot(name).resolve(session, choices);
		},
		/** Take a newer version of each open item that holds nothing unsaved. */
		async adopt(): Promise<void> {
			await Promise.all(keys().map((name) => slot(name).adopt()));
		},
		/**
		 * Wait for every slot's saves and release them. Answers the paths whose
		 * draft could not be saved, which end with the page.
		 */
		async close(): Promise<string[]> {
			const failed = await Promise.all(
				keys().map((name) => slot(name).close()),
			);
			return failed.filter((path) => path !== undefined);
		},
	};
}

export type OpenItems<
	TSlot,
	TKey,
	TItem,
	TSession extends OpenSession,
> = ReturnType<typeof createOpenItems<TSlot, TKey, TItem, TSession>>;

/** The one item a page has open: a single slot of `createOpenItems`. */
export function createOpenItem<TKey, TItem, TSession extends OpenSession>(
	options: OpenItemOptions<TKey, TItem, TSession>,
) {
	return createOpenItems<'open', TKey, TItem, TSession>(options).slot('open');
}

export type OpenItem<TKey, TItem, TSession extends OpenSession> = ReturnType<
	typeof createOpenItem<TKey, TItem, TSession>
>;
