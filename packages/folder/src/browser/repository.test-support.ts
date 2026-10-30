/** Storage captures used by repository and sync tests without a Folder view. */
import { type TSchema as Schema, Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { readablePath } from '../paths.js';
import { readRow } from '../shared/row.js';
import type { LocalRepository } from './repository.js';
import { snapshotContent } from './storage.js';

export const anyFields = Type.Record(Type.String(), Type.Unknown());

export async function captureFile(repository: LocalRepository, path: string) {
	if (!readablePath(path)) return Ok(undefined);
	const bytes = snapshotContent(await repository.storage.capture([path]), path);
	return Ok(
		bytes === null
			? undefined
			: { path, content: new Blob([new Uint8Array(bytes)]) },
	);
}

export async function capturePaths(repository: LocalRepository, prefix = '') {
	if (prefix !== '' && !readablePath(prefix.replace(/\/$/, ''))) return Ok([]);
	const snapshot = await repository.storage.capture({ prefix });
	return Ok(
		[...snapshot.files.keys()]
			.filter(
				(path) =>
					snapshot.files.get(path)?.mode !== '160000' &&
					path.startsWith(prefix),
			)
			.sort(),
	);
}

export async function captureRow<TSchema extends Schema>(
	repository: LocalRepository,
	table: string,
	id: string,
	schema: TSchema,
) {
	const path = `${table}/${id}.md`;
	if (id.includes('/') || !readablePath(path)) return Ok(undefined);
	const bytes = snapshotContent(await repository.storage.capture([path]), path);
	return Ok(bytes === null ? undefined : readRow(id, bytes, schema));
}

export async function captureRows(repository: LocalRepository, table: string) {
	const snapshot = await repository.storage.capture({ rows: table });
	const rows = [];
	for (const path of [...snapshot.files.keys()].sort()) {
		if (!path.startsWith(`${table}/`) || !path.endsWith('.md')) continue;
		const id = path.slice(table.length + 1, -3);
		if (id === '' || id.includes('/')) continue;
		const bytes = snapshotContent(snapshot, path);
		if (bytes !== null) rows.push(readRow(id, bytes, anyFields));
	}
	return Ok(rows);
}
