import { InstantString } from '@epicenter/app/field';
import type { RowAbsentError } from '@epicenter/app/store';
import {
	fromSubscription,
	type ReactiveData,
	type Tracked,
} from '@epicenter/svelte';
import { createContext } from 'svelte';
import {
	deleteHoneycrispFolder,
	type FolderId,
	type HoneycrispData,
	type Note,
	type NoteId,
} from '$lib/data';
import { notePreview, noteTitle } from './editor/node-text.js';
import { navigation } from './navigation.svelte.js';

/**
 * The reactive Honeycrisp application, for one mounted app generation.
 *
 * The opened database is a route's yield: one document, optional attached
 * sync, and the disposal that closes it (ADR-0233). This is the application
 * built on top of that one document, and the one object the UI consumes. It
 * owns the reactive named tables over that document (`fromData`),
 * Honeycrisp's domain operations (`tables.notes`, `tables.folders`), the one
 * derivation that needs both those tables and where the user is
 * (`visibleNotes`), and the narrow account and store capabilities the UI
 * actually needs.
 *
 * The store's own handles do not cross this boundary. `tables.notes` and
 * `tables.folders` are the whole vocabulary a component gets, and they are
 * this application's verbs rather than the store's, so nothing downstream can
 * reach a raw write verb or the `kv` root. The container keeps the name the
 * data uses, because these are those tables: one shape to learn, at both
 * levels.
 *
 * Where the user is looking is deliberately NOT here. That lives in the URL,
 * and `navigation.svelte.ts` is its module singleton, imported directly by the
 * components that navigate. A note selection is not a fact about which
 * document is open, so routing it through this object bought a rename and
 * nothing else.
 *
 * The route chooses the document before this function is called. There is no
 * fallback and no account/local decision below this boundary.
 *
 * One instance per mounted route generation, created by the route's provider
 * and reached through `getHoneycrisp`, never a module-global singleton.
 * Nothing here needs disposing, and not because anything is ref-counted: the
 * adapter holds each table's projection and its subscription for as long as
 * the document is open, and both die with it.
 */
export function createHoneycrisp({
	data,
}: {
	data: ReactiveData<HoneycrispData>;
}) {
	// Already awake. The shell adapts the store before this is built, so
	// this used to call `fromData` a second time and get a second projection of
	// every table, each with its own permanent subscription.
	//
	// Folders takes the whole database because deleting one re-parents the notes
	// that were in it, which is a write to the other table. Notes takes its own
	// table: a node is watched through the table that hands out the type, so
	// nothing in it reaches across any more.
	const folders = createFolders(data);
	const notes = createNotes(data.tables.notes, data.signal);

	/**
	 * The notes the user is currently looking at, in the order they appear.
	 *
	 * The one place the tables and the URL meet. Recently Deleted is its own
	 * list rather than a filter over the same one, because the folder and the
	 * query do not apply to it.
	 *
	 * Search covers the title, and only the title. It used to also match a
	 * stored `preview`, which sounded like body search and was not: it found a
	 * phrase in a note's first hundred characters and silently missed it
	 * everywhere else. Nothing is stored to match against now, and reading every
	 * note's text on every keystroke is not what this query is for. A real body
	 * search would walk the fragments deliberately, once, and is a different
	 * feature than a filter box.
	 */
	const visibleNotes = $derived.by(() => {
		if (navigation.isDeletedView) return notes.deleted.toSorted(byRecentEdit);

		const folderId = navigation.folderId;
		const q = navigation.query.trim().toLowerCase();
		return notes.all
			.filter((note) => folderId === null || note.folderId === folderId)
			.filter((note) => {
				if (!q) return true;
				return note.title.toLowerCase().includes(q);
			})
			.toSorted(byRecentEdit);
	});

	return {
		/**
		 * The two tables, each wearing this application's vocabulary.
		 *
		 * Under `tables` because that is the shape the data has, and these ARE
		 * those tables: every verb on them is a row operation on `notes` or
		 * `folders`. A second name for one thing at a second level would teach
		 * two shapes for the same table. What is genuinely not a table sits
		 * beside this container, exactly as `kv` and `transact` sit beside the
		 * data's own `tables`.
		 */
		tables: { folders, notes },
		get visibleNotes() {
			return visibleNotes;
		},
		/**
		 * Create a note in the folder the user is looking at and open it in the
		 * editor. Lives here rather than on `notes` because it is the one command
		 * that spans the tables and the URL, and every create surface (⌘N, the
		 * list's + button, the palette) means exactly this composition.
		 */
		createNote(): void {
			navigation.selectNote(notes.create(navigation.folderId));
		},
	};
}

export type Honeycrisp = ReturnType<typeof createHoneycrisp>;

export const [getHoneycrisp, setHoneycrisp] = createContext<Honeycrisp>();

// ─────────────────────────────────────────────────────────────────────────────
// The pieces the application above is made of. Nothing below is exported: they
// are one caller each, and reading them is optional until you need the detail.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An update landed, or the row was already gone, which is not news.
 *
 * Honeycrisp reports no write failures at all, and that is a claim about what
 * can actually go wrong rather than a shrug. An update is refused three ways.
 * `UnknownField` is a compile error before it is a runtime one. `Nonconforming`
 * needs a value that fails its declared field descriptor, and every value this file
 * writes is statically that type: a `boolean` into `'boolean'`, an
 * `InstantString.now()` into `'string.date.iso'`. That leaves `RowAbsent`,
 * which means another device deleted the row between the render and the click.
 *
 * That one is ordinary, and this app already ruled on it twice:
 * `permanentlyDelete` calls an absent row "a no-op fact, not an error", and
 * `togglePin` returns early on one. The reactive list is about to drop the row
 * on its own, so a sentence would only ask the person to care about a race they
 * cannot lose. Silence is the honest answer, and it is what deleted the toast
 * wrapper every call site used to carry.
 *
 * It is also the ONLY one. `update` refuses an absent address and nothing else,
 * which the `UpdateRowError` alias used to hide: this function's `throw` was
 * documented as catching two other failures where a declaration and this file
 * disagree, and neither exists. The throw is unreachable today and stays
 * anyway, because a variant the store grows later should surface here rather
 * than be swallowed by a guard written when there was only one.
 */
function updated(error: RowAbsentError | null): void {
	if (error === null || error.name === 'RowAbsent') return;
	throw error;
}

/**
 * The one order notes appear in: newest edit first.
 *
 * There is no user-selectable sort by decision; the earlier sort control was
 * inert (the list re-sorted by `updatedAt` regardless) and nobody noticed, so
 * the feature was deleted rather than repaired. This is ordering's single
 * owner: the list component groups (pinned, date labels) without ever
 * re-sorting.
 */
function byRecentEdit(
	a: { updatedAt: string },
	b: { updatedAt: string },
): number {
	return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * Honeycrisp's own folder concepts, over the reactive `folders` table.
 *
 * Same job as `createNotes`: the reactive table answers "what rows are here",
 * so what remains is domain, which here is the new-folder defaults, renaming,
 * and the delete that re-parents notes and cleans up the URL.
 *
 * It takes the whole database where `createNotes` takes one table, and that
 * difference is the point rather than an oversight: deleting a folder has to
 * reach the notes in it.
 */
function createFolders(data: ReactiveData<HoneycrispData>) {
	const table = data.tables.folders;

	// Name order, and nothing durable about order at all: it is deterministic
	// on every device without a schema field, and every surface that lists
	// folders (sidebar, move-to menu, palette) wants the same answer.
	const all = $derived(
		table.rows.toSorted((a, b) => a.name.localeCompare(b.name)),
	);

	return {
		get(id: FolderId) {
			return table.rows.find((folder) => folder.id === id);
		},
		get all() {
			return all;
		},

		// Nothing is returned because nothing wants it: all three create surfaces
		// make a folder and leave the person where they are. A note is different,
		// and says so by handing back its id.
		create(): void {
			table.create({ name: 'New Folder', icon: null });
		},

		rename(folderId: FolderId, name: string): void {
			const { error } = table.update(folderId, { name });
			updated(error);
		},

		/**
		 * Set this folder's emoji, or clear it with `null`.
		 *
		 * One native emoji string, stored as-is. Not a shortcode and not an icon
		 * name: the row has to carry a value that renders on every device without
		 * this release agreeing with the next one about a lookup table, and an
		 * emoji is already that. It is also why the field is `string|null` rather
		 * than an enum of the icons this version happens to ship.
		 */
		setIcon(folderId: FolderId, icon: string | null): void {
			const { error } = table.update(folderId, { icon });
			updated(error);
		},

		delete(folderId: FolderId): void {
			// Re-parents this folder's notes and then removes it. Both tables
			// invalidate on their own, so nothing has to be told to re-read.
			deleteHoneycrispFolder(data, folderId);
			navigation.folderRemoved(folderId);
		},
	};
}

/**
 * Honeycrisp's own note concepts, over the reactive `notes` table.
 *
 * The table already answers "what rows are here right now" reactively
 * (`fromData`): a read inside `$derived` re-runs on any commit that changed
 * the table's SHAPE, local writes and bytes from another device alike
 * (ADR-0221), and a read in an event handler is fresh. Text typed into a
 * note does NOT re-run it, deliberately; that is `table.watch`'s job, and it is
 * why `previewOf` below exists.
 *
 * What this adds is what the platform cannot know: which rows count as
 * deleted, per-folder counts, where a note's node is, and the domain commands
 * (soft delete, pinning, re-parenting) with their URL cleanup.
 */
function createNotes(
	table: ReactiveData<HoneycrispData>['tables']['notes'],
	signal: AbortSignal,
) {
	const all = $derived(table.rows.filter((note) => note.deletedAt === null));
	const deleted = $derived(
		table.rows.filter((note) => note.deletedAt !== null),
	);
	const countsByFolder = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of all) {
			if (note.folderId)
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
		}
		return counts;
	});

	/** Merge fields into a note, silently if the note is gone ({@link updated}). */
	function update(noteId: NoteId, changes: Partial<Note>): void {
		const { error } = table.update(noteId, changes);
		updated(error);
	}

	/**
	 * Open this note's node for the editor to bind to, and keep the row's
	 * derived fields moving while it is open.
	 *
	 * Synchronous, and there is nothing left to await: the content is a nested
	 * type on the row, in the one document this store already holds
	 * (ADR-0295). `undefined` means this note is no longer here.
	 *
	 * What is returned is not just the type. The store writes no derived fields
	 * and no timestamps any more (ADR-0297), so `title` and `updatedAt` are
	 * Honeycrisp's to write, hung on the body's own change signal. `close` stops
	 * that subscription; the pane holds exactly one note open at a time, and the
	 * type itself outlives it either way.
	 */
	function openContent(id: NoteId) {
		const content = table.get(id)?.content;
		if (content === undefined) return undefined;
		// Coalesced to one write per animation-frame-ish burst, because a
		// keystroke is a commit and writing the row on each one would write a row
		// per character. Reading the title itself is cheap now (`noteTitle` slices
		// the first block), so what this defends is the WRITE, not the read.
		// A `setTimeout(0)` rather than a debounce with a delay:
		// what is being avoided is one write per keystroke inside a burst, not
		// writes during sustained typing, and a person who stops typing and
		// closes the tab should not lose their title to a pending timer.
		let queued: ReturnType<typeof setTimeout> | undefined;
		let isClosed = false;
		const flush = () => {
			if (queued === undefined) return;
			clearTimeout(queued);
			queued = undefined;
			// The row may have disappeared since this body's edit was queued.
			table.update(id, {
				title: noteTitle(content),
				updatedAt: InstantString.now(),
			});
		};
		const stop = table.watch(content, () => {
			if (isClosed || queued !== undefined) return;
			queued = setTimeout(flush, 0);
		});
		function close() {
			if (isClosed) return;
			isClosed = true;
			stop();
			signal.removeEventListener('abort', close);
			if (signal.aborted) {
				clearTimeout(queued);
				queued = undefined;
				return;
			}
			flush();
		}
		// Retirement fences the store before UI teardown. Its pending derivations
		// belong to the old library and must be cancelled before close can flush.
		signal.addEventListener('abort', close, { once: true });
		return {
			content,
			close,
		};
	}

	/**
	 * One note's preview, read live off its node and never stored.
	 *
	 * A card calls this once and renders `.current`; the reader slices the first
	 * hundred characters rather than walking the note (`node-text.ts`). The
	 * subscription is the row's OWN field signal, so a card re-renders when its
	 * note's body changes and not when any other note's does. That is what the
	 * per-field signal is for, and it is the ONLY signal that carries a node's
	 * content:
	 * the table subscription the list already has reports the table's shape and
	 * deliberately not an edit inside a field, so riding it would never
	 * re-render this at all.
	 *
	 * `fromSubscription` ref-counts, so a card that is scrolled out of view
	 * detaches and a note nobody is looking at costs nothing.
	 */
	function previewOf(id: NoteId): Tracked<string> {
		const body = table.get(id)?.content;
		if (body === undefined) return { current: '' };
		return fromSubscription(
			(update) => table.watch(body, update),
			() => notePreview(body),
		);
	}

	return {
		/**
		 * Exposed as a verb so the raw `tables` never has to be. The editor pane
		 * wanted this one call and was given the whole store shape to make it.
		 */
		openContent,
		previewOf,
		get all() {
			return all;
		},
		get deleted() {
			return deleted;
		},
		get countsByFolder() {
			return countsByFolder;
		},
		get nonconforming() {
			return table.nonconforming;
		},

		create(folderId: FolderId | null): NoteId {
			const now = InstantString.now();
			const row = table.create({
				folderId,
				title: '',
				pinned: false,
				createdAt: now,
				updatedAt: now,
				deletedAt: null,
			});
			return row.id;
		},

		softDelete(noteId: NoteId): void {
			update(noteId, { deletedAt: InstantString.now() });
			navigation.noteRemoved(noteId);
		},

		restore(noteId: NoteId): void {
			update(noteId, { deletedAt: null });
		},

		permanentlyDelete(noteId: NoteId): void {
			// Deleting an absent note is a no-op fact, not an error.
			table.delete(noteId);
			navigation.noteRemoved(noteId);
		},

		togglePin(noteId: NoteId): void {
			const note = table.rows.find((candidate) => candidate.id === noteId);
			if (!note) return;
			update(noteId, { pinned: !note.pinned });
		},

		moveToFolder(noteId: NoteId, folderId: FolderId | null): void {
			update(noteId, { folderId });
		},
	};
}
