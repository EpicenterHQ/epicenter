/**
 * Detect folders kept by the former OPFS opener before showing an empty
 * IndexedDB folder. Detection never creates, changes, or migrates OPFS data.
 * Remove this boundary when a verified importer can read those directories.
 */
export async function legacyOpfsFolders(): Promise<string[]> {
	const getDirectory = globalThis.navigator?.storage?.getDirectory;
	if (getDirectory === undefined) return [];
	const root = (await getDirectory.call(globalThis.navigator.storage)) as FileSystemDirectoryHandle & {
		values(): AsyncIterable<FileSystemHandle>;
	};
	const names: string[] = [];
	for await (const entry of root.values()) {
		if (entry.kind !== 'directory') continue;
		const folder = entry as FileSystemDirectoryHandle;
		if (entry.name.startsWith('so.epicenter.')) {
			names.push(entry.name);
			continue;
		}
		if (entry.name === 'Epicenter' || entry.name === 'Epicenter Dev') {
			try {
				const local = (await folder.getDirectoryHandle('local')) as FileSystemDirectoryHandle & {
					values(): AsyncIterable<FileSystemHandle>;
				};
				for await (const old of local.values())
					if (old.kind === 'directory' && old.name.startsWith('so.epicenter.'))
						names.push(`${entry.name}/local/${old.name}`);
			} catch (cause) {
				if ((cause as { name?: unknown })?.name !== 'NotFoundError') throw cause;
			}
		}
		for (const marker of ['epicenter.json', '.git']) {
			try {
				if (marker === '.git') await folder.getDirectoryHandle(marker);
				else await folder.getFileHandle(marker);
				names.push(entry.name);
				break;
			} catch (cause) {
				if ((cause as { name?: unknown })?.name !== 'NotFoundError') throw cause;
			}
		}
	}
	return names.sort();
}
