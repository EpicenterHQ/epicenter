import type {
	FileListing,
	FilesObservation,
	GitSnapshot,
	SyncError,
	SyncOutcome,
} from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { readTextFile, withFileNewlines } from '@epicenter/folder/file-browser';
import { createTextEditor, type TextEditor } from '@epicenter/folder/svelte';
import { describeSync } from '@epicenter/svelte/sync-line';
import type { Result } from 'wellcrafted/result';

export type WorkingCopy = NonNullable<
	Awaited<ReturnType<typeof openWorkingCopy>>
>;

export async function openWorkingCopy(copy: string, remote: string) {
	remote = remote.trim();
	if (remote) {
		const url = new URL(remote);
		if (!['http:', 'https:'].includes(url.protocol))
			throw new Error('Use an HTTP or HTTPS Git remote');
	}
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(remote),
	);
	const key = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
	const id = `so.epicenter.git.${key}.${copy}`;
	// A working copy is an existing folder, not this app's data: it opens with
	// its own table schemas, if any, and saving never writes them.
	const opened = await openFolder({
		id,
		browser: {
			author: {
				name: `Working copy ${copy.toUpperCase()}`,
				email: `${copy}@git-lab.localhost`,
			},
		},
	});
	if (opened.error !== null) throw new Error(opened.error.message);
	const folder = opened.data;
	let listing = $state.raw<FileListing>({ files: [], directories: [] });
	let changes = $state.raw<FilesObservation['changes']>([]);
	let snapshot = $state.raw<GitSnapshot>(folder.git.snapshot);
	let selected = $state('');
	/** The file's text as the editor last read or wrote it. */
	let saved = $state('');
	/** Whether the selected file is open as text. */
	let editable = $state(false);
	/** The selected file's text editor, which holds what is typed and saves it. */
	let editor = $state.raw<TextEditor | undefined>();
	let saveMessage = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reading: Promise<void> | undefined;
	let readAgain = false;
	let readFileAgain = false;
	let readError = $state('');
	let closed = false;
	let selectGeneration = 0;
	let running = $state(false);
	let output = $state('');
	/**
	 * Sync with the remote: commit, fetch, merge, and push. It asks nothing:
	 * what both copies changed merges, this copy's version winning (ADR-0576).
	 */
	let syncing = $state(false);
	const syncLocked = () => syncing;

	/** One folder sync call: saved text lands first, and the copy is read again after. */
	async function syncStep(
		call: () => Promise<Result<SyncOutcome, SyncError>>,
	): Promise<Result<SyncOutcome, SyncError>> {
		syncing = true;
		try {
			await flush();
			return await call();
		} finally {
			syncing = false;
			await refresh();
		}
	}

	function report(result: Result<SyncOutcome, SyncError>) {
		const line = describeSync(result);
		output += `${line.label}${line.detail ? `\n${line.detail}` : ''}\n`;
	}

	/** Whether text is typed into the open file that its file does not hold. */
	const isDirty = () => editor?.typed !== undefined && editor.typed !== saved;

	/**
	 * The text editor of the file at `path`: each save writes the typed text
	 * as the change from the text it started from, which the write merges with
	 * whatever changed elsewhere since, by line, the typed lines winning where
	 * both changed the same lines (ADR-0576).
	 */
	function editorOf(path: string) {
		return createTextEditor({
			current: () => (editable && path === selected ? saved : undefined),
			async write({ from, to }) {
				saveMessage = 'Saving…';
				const result = await folder.write(path, from, to);
				if (result.error !== null) {
					saveMessage = result.error.message;
					throw new Error(result.error.message);
				}
				// A delete beats an edit it never saw: the text stays typed.
				if (result.data.file === null) {
					saveMessage = `No file exists at '${path}', so the edit was not saved.`;
					return 'gone';
				}
				saved = new TextDecoder().decode(result.data.file.bytes);
				saveMessage = 'Saved';
				return 'landed';
			},
		});
	}

	async function readSelected() {
		const path = selected;
		const generation = selectGeneration;
		// Typed text is never read over: its save merges with what changed.
		const typing = () => editor?.typed !== undefined || editor?.saving;
		if (!path || typing()) return;
		const result = await readTextFile(folder.files, path, 2 * 1024 * 1024);
		if (
			closed ||
			generation !== selectGeneration ||
			path !== selected ||
			typing()
		)
			return;
		if (result.error !== null) {
			saveMessage = result.error.message;
			if (result.error.name === 'NotFound') {
				editable = false;
				saved = '';
			}
			return;
		}
		if (result.data.kind !== 'text') {
			saveMessage = 'This file is binary or too large to edit here.';
			editable = false;
			saved = '';
			return;
		}
		editable = true;
		saved = result.data.text;
		saveMessage = 'Saved';
	}

	async function refreshOnce(readFile: boolean) {
		const [files, status] = await Promise.all([
			folder.files.list(),
			folder.git.status(),
		]);
		if (closed) return;
		if (files.error !== null) throw new Error(files.error.message);
		if (status.error !== null) throw new Error(status.error.message);
		listing = files.data;
		changes = status.data.changes;
		if (readFile) await readSelected();
	}
	/**
	 * Read the listing and status again, and the open file when `readFile`.
	 * Calls during a read join it and run once more after; the open file is
	 * read in that run if any of them asked for it.
	 */
	async function refresh(readFile = true): Promise<void> {
		readFileAgain ||= readFile;
		if (reading) {
			readAgain = true;
			return reading;
		}
		reading = (async () => {
			do {
				readAgain = false;
				const file = readFileAgain;
				readFileAgain = false;
				await refreshOnce(file);
			} while (readAgain && !closed);
		})();
		try {
			await reading;
			readError = '';
		} finally {
			reading = undefined;
		}
	}
	/**
	 * Save what is typed until nothing typed is unsent; one save runs at a
	 * time, and callers meanwhile share it. Rejects with what the save
	 * answered when the typed text could not be saved, which stays typed.
	 */
	async function flush() {
		clearTimeout(timer);
		const open = editor;
		if (open === undefined) return;
		await open.save();
		if (open.typed !== undefined) throw new Error(saveMessage);
	}
	/** What a Git call returned, as the output shows it. */
	function outcome(result: unknown): string {
		if (typeof result !== 'object' || result === null) return `${result}\n`;
		if ('error' in result && result.error !== null)
			return `${(result.error as { message: string }).message}\n`;
		const value = 'data' in result ? result.data : result;
		return `${JSON.stringify(value, null, 2)}\n`;
	}
	/** One Git call, reported in the output under its label. */
	const action = (label: string, call: () => Promise<unknown>) => () =>
		execute(label, async () => outcome(await call()));
	async function execute(label: string, work: () => Promise<string>) {
		if (running || closed || syncLocked()) return;
		running = true;
		output += `\n$ ${label}\n`;
		try {
			await flush();
			output += await work();
			await refresh();
		} catch (error) {
			output += `${error instanceof Error ? error.message : String(error)}\n`;
		} finally {
			running = false;
		}
	}
	const stopGit = folder.git.subscribe((next) => {
		snapshot = next;
	});
	// Changes made outside this handle, and the files its own Sync wrote. The
	// open file is read again only when the change names it, and never over
	// typed input: an edited buffer keeps the version it started from, and
	// its save merges with what changed since.
	const stopChanges = folder.onFilesChanged((change) => {
		if (closed) return;
		const readFile =
			change === 'everything' || (selected !== '' && change.includes(selected));
		void refresh(readFile).catch((error) => {
			if (!closed)
				readError = error instanceof Error ? error.message : String(error);
		});
	});
	try {
		await refresh();
		// A copy with no origin yet connects, once, to the remote it was
		// opened with: an empty copy takes the remote's history, and one with
		// files sends them. The origin lives in the copy's Git configuration,
		// so a reopened copy keeps it.
		if (remote && folder.git.snapshot.remote === undefined) {
			output = '$ Connect\n';
			report(await syncStep(() => folder.sync.connect(remote)));
		}
	} catch (error) {
		stopChanges();
		stopGit();
		await folder.close();
		throw error;
	}
	return {
		folder,
		get listing() {
			return listing;
		},
		/** What changed since the last version, by path. */
		get changes() {
			return changes;
		},
		get snapshot() {
			return snapshot;
		},
		get selected() {
			return selected;
		},
		get buffer() {
			return editor?.text ?? '';
		},
		get dirty() {
			return isDirty();
		},
		get saveMessage() {
			return saveMessage;
		},
		get editable() {
			return editable;
		},
		get running() {
			return running;
		},
		/** Why the last read after an outside change failed, until a read succeeds. */
		get readError() {
			return readError;
		},
		/** Whether a Sync is in flight. */
		get syncing() {
			return syncing;
		},
		/** Whether the editor and the Git actions wait for work in flight. */
		get locked() {
			return running || syncLocked();
		},
		/** Sync, reporting the result in the output. */
		async sync() {
			if (running || closed || syncLocked()) return;
			running = true;
			output += '\n$ Sync\n';
			try {
				report(await syncStep(() => folder.sync.run()));
			} finally {
				running = false;
			}
		},
		get output() {
			return output;
		},
		async select(path: string) {
			const generation = ++selectGeneration;
			await flush();
			if (generation !== selectGeneration || closed) return;
			selected = path;
			editable = false;
			saved = '';
			editor = editorOf(path);
			saveMessage = 'Opening…';
			await readSelected();
		},
		input(text: string) {
			if (closed || !editable || syncLocked() || editor === undefined) return;
			editor.change(withFileNewlines(text, saved));
			saveMessage = isDirty() ? 'Unsaved changes' : 'Saved';
			// Saved a second after the last keystroke, or at once on blur.
			clearTimeout(timer);
			timer = setTimeout(() => {
				void flush().catch(() => {});
			}, 1000);
		},
		async useSavedText() {
			clearTimeout(timer);
			// A save already running finishes; nothing typed is sent after it,
			// since what is typed is dropped before waiting for it.
			const running = editor?.saving ? editor.save() : undefined;
			editor?.discard();
			await running;
			await readSelected();
		},
		flush,
		status: action('Status', () => folder.git.status()),
		commit: action('Save version', () => folder.git.commit()),
		/** Create an empty file at a folder-relative path and open it; a file already there is refused. */
		async create(path: string) {
			path = path.trim();
			if (!path) return;
			await execute(`New file ${path}`, async () => {
				const created = await folder.write(path, null, '');
				if (created.error !== null) throw new Error(created.error.message);
				return '';
			});
			await this.select(path);
		},
		async close() {
			await flush();
			closed = true;
			clearTimeout(timer);
			stopChanges();
			stopGit();
			await folder.close();
		},
	};
}
