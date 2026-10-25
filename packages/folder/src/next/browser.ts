/**
 * `@epicenter/folder/next/browser`: this web origin's default local folder,
 * kept in IndexedDB as a Git working tree. A blob's oid is both its content
 * version and its change token, and other tabs' saves arrive as hints.
 */
import { isTauri } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import { openRepository } from '../browser/repository.js';
import { snapshotContent } from '../browser/storage.js';
import { OpenFolderError } from '../errors.js';
import { ReadError } from '../shared/errors.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import type { Fetched, FolderHost } from './storage.js';

export * from './index.js';

/** The same fixed key as the browser's default folder, so its files carry over. */
const DEFAULT_KEY = 'default';

export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	// The desktop app opens its window's directory through the Tauri entry.
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof indexedDB === 'undefined')
		return OpenFolderError.Unavailable({
			cause: new Error('IndexedDB is not available in this page'),
		});
	let repository: Awaited<ReturnType<typeof openRepository>>;
	try {
		repository = await openRepository(DEFAULT_KEY);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return createFolder(repositoryHost(repository), options);
}

function repositoryHost(
	repository: Awaited<ReturnType<typeof openRepository>>,
): FolderHost {
	const { storage } = repository;
	return {
		async list() {
			try {
				// An empty scope walks every tree and loads no blob.
				const snapshot = await storage.capture([]);
				const listed = new Map<string, { token: string }>();
				for (const [path, entry] of snapshot.files)
					if (entry.mode !== '160000') listed.set(path, { token: entry.oid });
				return Ok(listed);
			} catch (cause) {
				return ReadError.StorageFailed({ cause });
			}
		},
		async read(paths) {
			try {
				const snapshot = await storage.capture(paths);
				return new Map(
					paths.map((path) => {
						const entry = snapshot.files.get(path);
						const bytes = snapshotContent(snapshot, path);
						const fetched: Fetched =
							entry === undefined || bytes === null
								? null
								: {
										bytes: bytes.slice(),
										version: entry.oid,
										token: entry.oid,
									};
						return [path, Ok(fetched)];
					}),
				);
			} catch (cause) {
				const failed = ReadError.StorageFailed({ cause });
				return new Map(paths.map((path) => [path, failed]));
			}
		},
		async put(path, bytes, expected) {
			const { data, error } = await repository.put(path, bytes, expected);
			if (error !== null) return { data: null, error };
			if (data === 'stale') return Ok('stale');
			const { landed } = data;
			return Ok({
				landed:
					landed === null
						? null
						: { version: landed.version, token: landed.version },
			});
		},
		hints: (listener) =>
			repository.onChange(({ paths, origin }) => {
				if (origin === 'other-handle') listener(paths);
			}),
		close: repository.close,
	};
}
