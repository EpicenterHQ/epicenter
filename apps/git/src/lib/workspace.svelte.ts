import {
	defineFolder,
	type FileCapture,
	type FileListing,
	type GitSnapshot,
	openFolder,
	type PathStatus,
	type SyncAttempt,
	type SyncChoiceProblem,
	type SyncChoices,
	type SyncError,
	type SyncOutcome,
} from '@epicenter/folder';
import { readTextFile, withFileNewlines } from '@epicenter/folder/file-browser';
import { describeSync } from '@epicenter/svelte/sync-line';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Result } from 'wellcrafted/result';

const definition = defineFolder({ kv: {}, tables: {} });
export type WorkingCopy = NonNullable<
	Awaited<ReturnType<typeof openWorkingCopy>>
>;

export async function openWorkingCopy(copy: string, remote: string) {
	remote = remote.trim();
	let id: string;
	if (isTauri()) id = await invoke<string>('open_copy', { copy, remote });
	else {
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
		id = `so.epicenter.git.${key}.${copy}`;
	}
	const opened = await openFolder({
		id,
		definition,
		browser: {
			scope: { channel: 'development' },
			author: {
				name: `Working copy ${copy.toUpperCase()}`,
				email: `${copy}@git-lab.localhost`,
			},
			...(remote && { remote: { url: remote, branch: 'main' } }),
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
	let capture = $state.raw<FileCapture>();
	let saveMessage = $state('');
	let dirty = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	let reading: Promise<void> | undefined;
	let readAgain = false;
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
		saved = result.data.file.text;
		buffer = saved;
		saveMessage = 'Saved';
	}

	async function refreshOnce() {
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
		await readSelected();
	}
	async function refresh(): Promise<void> {
		if (reading) {
			readAgain = true;
			return reading;
		}
		reading = (async () => {
			do {
				readAgain = false;
				await refreshOnce();
			} while (readAgain && !closed);
		})();
		try {
			await reading;
		} finally {
			reading = undefined;
		}
	}
	async function saveOnce(mode: 'replace' | 'overwrite' = 'replace') {
		if (!capture || !dirty) return;
		const text = buffer;
		saveMessage = 'Saving…';
		const result =
			mode === 'replace'
				? await folder.files.replace(capture, text)
				: await folder.files.overwrite(capture.path, text);
		if (result.error !== null) {
			saveMessage = result.error.message;
			throw new Error(result.error.message);
		}
		capture = result.data;
		saved = text;
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
	const stopFiles = folder.onFilesChanged(() => {
		void refresh().catch((e) => {
			output += `\n${String(e)}\n`;
		});
	});
	const stopGit = folder.git.subscribe((next) => {
		snapshot = next;
	});
	try {
		await refresh();
		if (
			remote &&
			folder.git.snapshot.files.state === 'observed' &&
			folder.git.snapshot.files.value.head === undefined &&
			(await folder.files.list()).data?.files.length === 0
		) {
			output = '$ Fetch and pull\n';
			const fetched = await folder.git.fetch();
			output += outcome(fetched);
			if (fetched.error === null)
				output += outcome(await folder.git.pullFastForward());
			await refresh();
		}
	} catch (error) {
		stopFiles();
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
			buffer = '';
			saved = '';
			saveMessage = 'Opening…';
			await readSelected();
		},
		input(text: string) {
			if (closed || !capture || syncLocked()) return;
			buffer = withFileNewlines(text, saved);
			dirty = buffer !== saved;
			saveMessage = dirty ? 'Unsaved changes' : 'Saved';
			clearTimeout(timer);
			timer = setTimeout(() => {
				void flush().catch(() => {});
			}, 350);
		},
		async keepMyText() {
			clearTimeout(timer);
			while (saving) await saving.catch(() => {});
			if (!selected || !dirty) return;
			saving = saveOnce('overwrite').finally(() => {
				saving = undefined;
			});
			await saving;
			await refresh();
		},
		async useSavedText() {
			clearTimeout(timer);
			if (saving) await saving.catch(() => {});
			dirty = false;
			await readSelected();
		},
		flush,
		refresh,
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
		async recover() {
			await execute('Recover incoming update', async () => {
				const result = await folder.git.recoverIncoming();
				if (result.error !== null) throw new Error(result.error.message);
				return `Incoming recovery: ${result.data.status}\n`;
			});
		},
		async close() {
			await flush();
			closed = true;
			clearTimeout(timer);
			stopFiles();
			stopGit();
			await folder.close();
		},
	};
}
