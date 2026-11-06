/**
 * The Epicenter folder in a Tauri window (ADR-0813, ADR-0819): the
 * `EpicenterRoot` the platform's functions take, over the folder plugin of a
 * shell that named the Epicenter folder (the Epicenter app). The shell lists
 * the directories directly inside it, links followed and hidden names
 * skipped, each with its identity (device and inode); each directory opens
 * as a root of its own, `{ Folder: <name> }`, whose store is the shell's
 * storage commands and whose changes are the shell's watch of it. So a copy
 * is told from a move here as `epicenterRoot` from `@epicenter/folder/node`
 * tells it in Bun.
 *
 * A folder's root opens when a listing first finds it, and again when its
 * identity changed (a folder replaced, or a link pointed elsewhere); one
 * that does not open is listed as unreadable, with why.
 */
import { ClientError } from '@epicenter/definition/contract';
import { listen } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Changed, Unavailable } from '../device/store.js';
import { tauriStore } from '../device/tauri-store.js';
import type {
	EpicenterRoot,
	LocalFolder,
} from '../platform/epicenter-folder.js';
import type { RootIdentity } from '../sync/sync.js';
import {
	commands,
	type EpicenterEntry,
	type EpicenterListing,
	type FolderEvent,
	type Root,
} from './bindings.gen.js';
import { rootRefusal } from './open-refusal.js';

/** A typed command's answer, or what it refused or rejected with. */
async function ask<T>(
	call: () => Promise<
		{ data: T; error: null } | { data: null; error: unknown }
	>,
): Promise<Result<T, { cause: unknown }>> {
	try {
		const answer = await call();
		return answer.error === null
			? Ok(answer.data as T)
			: Err({ cause: answer.error });
	} catch (cause) {
		return Err({ cause });
	}
}

/** What the shell refused or failed, as `Unavailable` saying why. */
const unavailable = (cause: unknown) =>
	ClientError.Unavailable({ cause: rootRefusal(cause).error.message });

const sameIdentity = (a: RootIdentity | null, b: RootIdentity | null) =>
	a?.device === b?.device && a?.inode === b?.inode;

/**
 * The Epicenter folder the shell named. Its `path` is known once it listed;
 * before, it is empty.
 */
export function epicenterRoot(): EpicenterRoot {
	let path = '';
	/** Each folder's listeners, by name; they outlive a root opened again. */
	const listeners = new Map<string, Set<Changed>>();
	/** The folders whose roots opened, by name, with the identity they opened at. */
	const opened = new Map<
		string,
		{ identity: RootIdentity | null; folder: LocalFolder }
	>();
	let listening: Promise<void> | undefined;

	/** Hear every folder's changes from the shell, once, before a root opens. */
	function hear() {
		listening ??= listen<FolderEvent>('folder-changed', ({ payload }) => {
			if (typeof payload.root === 'string') return;
			for (const listener of listeners.get(payload.root.Folder) ?? [])
				listener(payload.paths ?? 'all');
		}).then(() => {});
		return listening;
	}

	/** The folder `entry` names, its root opened when it is new or moved. */
	async function open(
		entry: EpicenterEntry,
	): Promise<Result<LocalFolder, string>> {
		const kept = opened.get(entry.name);
		if (kept !== undefined && sameIdentity(kept.identity, entry.identity))
			return Ok(kept.folder);
		const root: Root = { Folder: entry.name };
		const answer = await ask<string>(() => commands.openRoot(root));
		if (answer.error !== null) {
			opened.delete(entry.name);
			return Err(rootRefusal(answer.error.cause).error.message);
		}
		const folder: LocalFolder = {
			name: entry.name,
			path: answer.data,
			identity: entry.identity,
			store: tauriStore({
				root,
				listen(changed) {
					let set = listeners.get(entry.name);
					if (set === undefined) {
						set = new Set();
						listeners.set(entry.name, set);
					}
					set.add(changed);
					return () => {
						set.delete(changed);
					};
				},
			}),
		};
		opened.set(entry.name, { identity: entry.identity, folder });
		return Ok(folder);
	}

	return {
		get path() {
			return path;
		},
		async list() {
			try {
				await hear();
			} catch (cause) {
				return unavailable(cause);
			}
			const listed = await ask<EpicenterListing>(() =>
				commands.listEpicenter(),
			);
			if (listed.error !== null) return unavailable(listed.error.cause);
			path = listed.data.path;
			const folders: LocalFolder[] = [];
			const unreadable = [...listed.data.unreadable];
			const present = new Set<string>();
			for (const entry of listed.data.folders) {
				present.add(entry.name);
				const folder = await open(entry);
				if (folder.error !== null)
					unreadable.push({ name: entry.name, reason: folder.error });
				else folders.push(folder.data);
			}
			for (const name of opened.keys())
				if (!present.has(name)) opened.delete(name);
			return Ok({ folders, unreadable });
		},
		async make(name): Promise<Result<LocalFolder, Unavailable>> {
			try {
				await hear();
			} catch (cause) {
				return unavailable(cause);
			}
			const made = await ask<EpicenterEntry>(() =>
				commands.makeEpicenterFolder(name),
			);
			if (made.error !== null) return unavailable(made.error.cause);
			const folder = await open(made.data);
			if (folder.error !== null)
				return ClientError.Unavailable({ cause: folder.error });
			return folder;
		},
	};
}
