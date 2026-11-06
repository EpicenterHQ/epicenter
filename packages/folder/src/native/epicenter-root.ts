/**
 * The Epicenter folder in a Tauri window (ADR-0813, ADR-0819, ADR-0822,
 * ADR-0825): the `EpicenterRoot` the platform's functions take, over the
 * folder plugin of the shell that named the Epicenter folder (the Epicenter
 * app). The shell lists the real directories directly inside it, hidden
 * names skipped, each with its identity (inode and birth time) and whether
 * Git keeps it, and the links there as outside it; each directory opens as
 * a root of its own, `{ Folder: <name> }`,
 * whose store is the shell's storage commands and whose changes are the
 * shell's watch of it. The Epicenter folder's own `.epicenter`, with the
 * records and hash caches, is the root `Epicenter`.
 *
 * A folder's root opens when a listing first finds it, and again when its
 * identity changed (a folder replaced); one that does not open is listed as
 * unreadable, with why. The shell's open
 * sweeps stale saves and recovers what an older build left in it.
 */
import { ClientError } from '@epicenter/definition/contract';
import { listen } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Changed, Unavailable } from '../device/store.js';
import { tauriStore } from '../device/tauri-store.js';
import { type FolderIdentity, sameIdentity } from '../identity.js';
import type {
	EpicenterRoot,
	LocalFolder,
	OutsideLink,
} from '../platform/epicenter-folder.js';
import { type Records, recordsIn } from '../platform/records.js';
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

/**
 * The Epicenter folder the shell named. Its `path` is known once it listed;
 * before, it is empty.
 */
export function epicenterRoot(): EpicenterRoot {
	let path = '';
	/** Each root's listeners, by its header; they outlive a root opened again. */
	const listeners = new Map<string, Set<Changed>>();
	/** The folders whose roots opened, by name, with the identity they opened at. */
	const opened = new Map<
		string,
		{ identity: FolderIdentity | null; folder: LocalFolder }
	>();
	let listening: Promise<void> | undefined;
	let records: Promise<Result<Records, Unavailable>> | undefined;

	/** Hear every root's changes from the shell, once, before a root opens. */
	function hear() {
		listening ??= listen<FolderEvent>('folder-changed', ({ payload }) => {
			const key =
				typeof payload.root === 'string'
					? payload.root
					: `Folder/${payload.root.Folder}`;
			for (const listener of listeners.get(key) ?? [])
				listener(payload.paths ?? 'all');
		}).then(() => {});
		return listening;
	}

	/** Hear the root `key` names, for as long as the answered stop is not called. */
	const listenTo = (key: string) => (changed: Changed) => {
		let set = listeners.get(key);
		if (set === undefined) {
			set = new Set();
			listeners.set(key, set);
		}
		set.add(changed);
		return () => {
			set.delete(changed);
		};
	};

	/** The Epicenter folder's own `.epicenter`, opened once. */
	function openRecords() {
		records ??= (async () => {
			try {
				await hear();
			} catch (cause) {
				return unavailable(cause);
			}
			const root: Root = 'Epicenter';
			const answer = await ask<string>(() => commands.openRoot(root));
			if (answer.error !== null) {
				records = undefined;
				return unavailable(answer.error.cause);
			}
			return Ok(recordsIn(tauriStore({ root, listen: listenTo('Epicenter') })));
		})();
		return records;
	}

	/** The folder `entry` names, its root opened when it is new or moved. */
	async function open(
		entry: EpicenterEntry,
	): Promise<Result<LocalFolder, string>> {
		const kept = opened.get(entry.name);
		if (kept !== undefined && sameIdentity(kept.identity, entry.identity))
			return Ok({ ...kept.folder, git: entry.git });
		const held = await openRecords();
		if (held.error !== null) return Err(held.error.message);
		const root: Root = { Folder: entry.name };
		const answer = await ask<string>(() => commands.openRoot(root));
		if (answer.error !== null) {
			opened.delete(entry.name);
			return Err(rootRefusal(answer.error.cause).error.message);
		}
		const identity = entry.identity;
		const folder: LocalFolder = {
			name: entry.name,
			path: answer.data,
			identity,
			git: entry.git,
			store: tauriStore({
				root,
				listen: listenTo(`Folder/${entry.name}`),
				hashes: identity === null ? null : held.data.hashes(identity),
			}),
		};
		opened.set(entry.name, { identity, folder });
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
			const outside: OutsideLink[] = listed.data.outside.map(
				({ name, target }) => ({ name, path: `${path}/${name}`, target }),
			);
			return Ok({ folders, outside, unreadable, git: listed.data.git });
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
		records: openRecords,
	};
}
