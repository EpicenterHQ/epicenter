import {
	defineFolder,
	type FileCapture,
	type FileListing,
	type GitSnapshot,
	openFolder,
	type PathStatus,
} from '@epicenter/folder';
import { readTextFile, withFileNewlines } from '@epicenter/folder/file-browser';
import { createSyncController } from '@epicenter/svelte/sync';
import { describeSync } from '@epicenter/svelte/sync-line';
import { invoke, isTauri } from '@tauri-apps/api/core';

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
	let command = $state('');
	let running = $state(false);
	let output = $state('');
	const terminal = folder.terminal();
	/**
	 * Sync with the remote: commit, fetch, merge, and push, asking before a
	 * conflict is written. The review is modal: the editor and the terminal
	 * take no input until it is applied or cancelled.
	 */
	const syncs = createSyncController({
		folder,
		beforeSync: () => flush(),
		afterSync: () => refresh(),
		refused: () => (closed ? 'The working copy is closed.' : undefined),
	});

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
			saveMessage =
				'This file is binary or too large to edit. Use the terminal to inspect it.';
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
	async function execute(label: string, work: () => Promise<string>) {
		if (running || closed || syncs.locked) return;
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
			output = '$ git pull --ff-only\n';
			const result = await terminal.exec('git pull --ff-only');
			output += result.stdout + result.stderr;
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
		get command() {
			return command;
		},
		set command(next: string) {
			command = next;
		},
		get running() {
			return running;
		},
		/** The sync controller: its attempt, while one waits, is the modal review. */
		syncs,
		/** Whether anything but the review takes input now. */
		get locked() {
			return running || syncs.locked;
		},
		/** Sync, reporting the result in the terminal output. */
		async sync() {
			if (running || closed || syncs.locked) return;
			running = true;
			output += '\n$ Sync\n';
			try {
				const ran = await syncs.run();
				const line = describeSync(ran);
				output += `${line.label}${line.detail ? `\n${line.detail}` : ''}\n`;
			} finally {
				running = false;
			}
		},
		/** Apply the review's choices, reporting the result in the terminal output. */
		async applySync(...[attempt, choices]: Parameters<typeof syncs.apply>) {
			const resolved = await syncs.apply(attempt, choices);
			const line = describeSync(resolved);
			output += `${line.label}${line.detail ? `\n${line.detail}` : ''}\n`;
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
			if (closed || !capture || syncs.locked) return;
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
		async run(line = command) {
			if (running || closed || !line.trim()) return;
			command = '';
			await execute(line, async () => {
				const result = await terminal.exec(line);
				return (
					result.stdout +
					result.stderr +
					(result.exitCode ? `[exit ${result.exitCode}]\n` : '')
				);
			});
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
