import type {
	ConstrainedUpdate,
	NonconformingRowError,
} from '@epicenter/data/runtime';
import { InstantString } from '@epicenter/field';
import type {
	FolderId,
	HoneycrispData,
	Note,
	NoteId,
	notesTable,
} from '@epicenter/honeycrisp';
import type { createFolders } from './folders.svelte.js';
import { searchParams } from './search-params.svelte.js';

export function createNotes({
	folders,
	honeycrisp,
}: {
	folders: ReturnType<typeof createFolders>;
	honeycrisp: HoneycrispData;
}) {
	let rows = $state.raw<Note[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let refreshGeneration = 0;

	const all = $derived(rows.filter((note) => note.deletedAt === undefined));
	const deleted = $derived(rows.filter((note) => note.deletedAt !== undefined));
	const countsByFolder = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of all) {
			if (note.folderId) {
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
			}
		}
		return counts;
	});

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		try {
			const { rows: nextRows, nonconforming: nextNonconforming } =
				await honeycrisp.notes.scan();
			if (generation !== refreshGeneration) return;
			rows = nextRows;
			nonconforming = nextNonconforming;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
	}

	async function update<const TChanges extends Record<string, unknown>>(
		noteId: NoteId,
		changes: TChanges & ConstrainedUpdate<typeof notesTable, TChanges>,
	): Promise<void> {
		const result = await honeycrisp.notes.record(noteId).update(changes);
		if (result.error !== null) throw result.error;
		await refresh();
	}

	return {
		refresh,
		get(id: NoteId) {
			return rows.find((note) => note.id === id);
		},
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
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},

		async create(folderId: FolderId | null): Promise<{ id: NoteId }> {
			const now = InstantString.now();
			const note = await honeycrisp.notes.create({
				...(folderId === null ? {} : { folderId }),
				title: '',
				preview: '',
				pinned: false,
				createdAt: now,
				updatedAt: now,
			});
			await refresh();
			return { id: note.id };
		},

		async softDelete(noteId: NoteId): Promise<void> {
			await update(noteId, { deletedAt: InstantString.now() });
			if (searchParams.note === noteId) {
				searchParams.update({ note: null });
			}
		},

		async restore(noteId: NoteId): Promise<void> {
			const note = rows.find((candidate) => candidate.id === noteId);
			if (!note) return;
			const folderExists = note.folderId
				? folders.all.some((folder) => folder.id === note.folderId)
				: true;
			await update(noteId, {
				deletedAt: undefined,
				...(folderExists ? {} : { folderId: undefined }),
			});
		},

		async permanentlyDelete(noteId: NoteId): Promise<void> {
			await honeycrisp.notes.record(noteId).delete();
			await refresh();
			if (searchParams.note === noteId) {
				searchParams.update({ note: null });
			}
		},

		async togglePin(noteId: NoteId): Promise<void> {
			const note = rows.find((candidate) => candidate.id === noteId);
			if (!note) return;
			await update(noteId, { pinned: !note.pinned });
		},

		async moveToFolder(
			noteId: NoteId,
			folderId: FolderId | null,
		): Promise<void> {
			await update(noteId, {
				folderId: folderId === null ? undefined : folderId,
			});
		},

		async updateContent(
			noteId: NoteId,
			content: Pick<Note, 'title' | 'preview'> & { wordCount: number },
		): Promise<void> {
			await update(noteId, {
				...content,
				updatedAt: InstantString.now(),
			});
		},
	};
}
