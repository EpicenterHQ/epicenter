import {
	type FileListing,
	type GitSnapshot,
	type PathStatus,
	type SavedFile,
	type SyncAttempt,
	type SyncChoiceProblem,
	type SyncChoices,
	type SyncError,
	type SyncOutcome,
	type TextCapture,
} from '@epicenter/folder';
// The lab drives Git one step at a time, which only the browser folder offers.
import { openDataFolder } from '@epicenter/folder/browser';
import { readTextFile, withFileNewlines } from '@epicenter/folder/file-browser';
import {
	createTextDraft,
	type TextDraft,
	writtenFile,
} from '@epicenter/folder/query';
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
	// its own epicenter.json, if any, and saving never writes that file.
	const opened = await openDataFolder({
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
	let paths = $state.raw<PathStatus[]>([]);
	let snapshot = $state.raw<GitSnapshot>(folder.git.snapshot);
	let selected = $state('');
	let buffer = $state('');
	let saved = '';
	/** The version the editor shows: its text is `saved`. */
	let capture = $state.raw<TextCapture>();
	/** The typed text and the version it started from, apart from `capture`. */
	let draft: TextDraft = createTextDraft();
	let saveMessage = $state('');
	let dirty = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	let reading: Promise<void> | undefined;
	let readAgain = false;
	let readFileAgain = false;
	let readError = $state('');
	let closed = false;
	let selectGeneration = 0;
	let running = $state(false);
	let output = $state('');
	/**
	 * Sync with the remote: commit, fetch, merge, and push, asking before a
	 * conflict is written. A run or Apply in flight, and the attempt a sync
	 * that needs choices left for the review. The review is modal: the
	 * editor and the Git actions take no input until it is applied or
	 * cancelled. Nothing outlives an attempt.
	 */
	let syncing = $state(false);
	let attempt = $state.raw<SyncAttempt | undefined>();
	let problems = $state.raw<readonly SyncChoiceProblem[]>([]);
	const syncLocked = () => syncing || attempt !== undefined;

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

	async function readSelected() {
		const path = selected;
		const generation = selectGeneration;
		if (!path || dirty || saving) return;
		const result = await readTextFile(folder.files, path, 2 * 1024 * 1024);
		if (
			closed ||
			generation !== selectGeneration ||
			path !== selected ||
			dirty ||
			saving
		)
			return;
		if (result.error !== null) {
			saveMessage = result.error.message;
			if (result.error.name === 'NotFound') {
				capture = undefined;
				buffer = '';
				saved = '';
			}
			return;
		}
		if (result.data.kind !== 'text') {
			saveMessage = 'This file is binary or too large to edit here.';
			capture = undefined;
			buffer = '';
			saved = '';
			return;
		}
		capture = result.data.file;
		draft = createTextDraft();
		saved = result.data.file.text;
		buffer = saved;
		saveMessage = 'Saved';
	}

	async function refreshOnce(readFile: boolean) {
		const [files, statuses] = await Promise.all([
			folder.files.list(),
			folder.git.paths(),
		]);
		if (closed) return;
		if (files.error !== null) throw new Error(files.error.message);
		if (statuses.error !== null) throw new Error(statuses.error.message);
		listing = files.data;
		paths = statuses.data;
		await folder.git.status();
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
	/** The editor shows what a save wrote: the file's text now. */
	function showWritten(written: SavedFile) {
		const text = new TextDecoder().decode(written.stored.bytes);
		capture = {
			path: written.stored.path,
			sha256: written.stored.sha256,
			text,
		};
		saved = text;
	}
	/**
	 * Save the typed text over the version it started from. A file changed
	 * elsewhere since is merged with it by line (ADR-0551): the editor shows
	 * the merge, and text typed during the save is carried onto it.
	 */
	async function saveOnce() {
		const sent = draft.toSave();
		if (!sent || !dirty) return;
		saveMessage = 'Saving…';
		const result = await folder.files.save(sent.base, sent.content);
		if (result.error !== null) {
			saveMessage = result.error.message;
			throw new Error(result.error.message);
		}
		await draft.saved(sent, writtenFile(result.data));
		showWritten(result.data);
		buffer = draft.text ?? saved;
		dirty = buffer !== saved;
		saveMessage = dirty ? 'Unsaved changes' : 'Saved';
	}
	async function flush() {
		clearTimeout(timer);
		while (dirty || saving) {
			if (!saving)
				saving = saveOnce().finally(() => {
					saving = undefined;
				});
			await saving;
		}
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
		get paths() {
			return paths;
		},
		get snapshot() {
			return snapshot;
		},
		get selected() {
			return selected;
		},
		get buffer() {
			return buffer;
		},
		get dirty() {
			return dirty;
		},
		get saveMessage() {
			return saveMessage;
		},
		get editable() {
			return capture !== undefined;
		},
		get running() {
			return running;
		},
		/** Why the last read after an outside change failed, until a read succeeds. */
		get readError() {
			return readError;
		},
		/** The attempt whose review shows, while one waits for choices. */
		get syncAttempt() {
			return attempt;
		},
		/** What the folder refused in the last Apply, shown beside its rows. */
		get syncProblems() {
			return problems;
		},
		/** Whether an Apply is in flight. */
		get syncing() {
			return syncing;
		},
		/** Whether anything but the review takes input now. */
		get locked() {
			return running || syncLocked();
		},
		/** Sync, reporting the result in the output. A conflict opens the review. */
		async sync() {
			if (running || closed || syncLocked()) return;
			running = true;
			output += '\n$ Sync\n';
			try {
				const ran = await syncStep(() => folder.sync.run());
				if (ran.error?.name === 'NeedsChoices') attempt = ran.error.attempt;
				report(ran);
			} finally {
				running = false;
			}
		},
		/**
		 * Apply the review's choices, reporting the result in the
		 * output. Refused choices stay in the review with what to fix; any
		 * other result ends the attempt.
		 */
		async applySync(answered: SyncAttempt, choices: SyncChoices) {
			if (syncing || closed) return;
			const resolved = await syncStep(() =>
				folder.sync.resolve(answered, choices),
			);
			if (resolved.error?.name === 'InvalidChoices')
				problems = resolved.error.problems;
			else if (attempt?.id === answered.id) {
				attempt = undefined;
				problems = [];
			}
			report(resolved);
		},
		/** Forget the waiting attempt and its choices; nothing is written. */
		cancelSync() {
			if (syncing) return;
			attempt = undefined;
			problems = [];
		},
		get output() {
			return output;
		},
		async select(path: string) {
			const generation = ++selectGeneration;
			await flush();
			if (generation !== selectGeneration || closed) return;
			selected = path;
			capture = undefined;
			draft = createTextDraft();
			buffer = '';
			saved = '';
			saveMessage = 'Opening…';
			await readSelected();
		},
		input(text: string) {
			if (closed || !capture || syncLocked()) return;
			buffer = withFileNewlines(text, saved);
			draft.change(capture, buffer);
			dirty = buffer !== saved;
			saveMessage = dirty ? 'Unsaved changes' : 'Saved';
			// Saved a second after the last keystroke, or at once on blur.
			clearTimeout(timer);
			timer = setTimeout(() => {
				void flush().catch(() => {});
			}, 1000);
		},
		async useSavedText() {
			clearTimeout(timer);
			if (saving) await saving.catch(() => {});
			dirty = false;
			draft = createTextDraft();
			await readSelected();
		},
		flush,
		status: action('Status', () => folder.git.status()),
		commit: action('Save version', () => folder.git.commit()),
		fetch: action('Fetch', () => folder.git.fetch()),
		pull: action('Pull', () => folder.git.pullFastForward()),
		merge: action('Merge', () => folder.git.mergeIncoming()),
		push: action('Push', () => folder.git.push()),
		/** Create an empty file at a folder-relative path and open it. */
		async create(path: string) {
			path = path.trim();
			if (!path) return;
			await execute(`New file ${path}`, async () => {
				const created = await folder.files.create(path, '');
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
