/**
 * `Files` in memory, for tests: a map from path to bytes and when each was
 * written. Each read and write copies, so a caller that changes its array
 * changes nothing kept.
 */
import { Ok } from 'wellcrafted/result';
import { checkPath, type Entry, type Files, isPlainName } from './files.js';

export function memoryFiles(initial: Record<string, Uint8Array> = {}): Files {
	/** A clock that always moves forward, so each write is a change a listing shows. */
	let clock = 0;
	const tick = () => (clock = Math.max(clock + 1, Date.now()));
	const kept = new Map(
		Object.entries(initial).map(([path, bytes]) => [
			path,
			{ bytes: bytes.slice(), modifiedMs: tick() },
		]),
	);
	return {
		async read(path) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			return Ok(kept.get(path)?.bytes.slice() ?? null);
		},
		async readMany(paths) {
			const read = new Map<string, Uint8Array>();
			for (const path of paths) {
				const checked = checkPath(path);
				if (checked.error !== null) return checked;
				const file = kept.get(path);
				if (file !== undefined) read.set(path, file.bytes.slice());
			}
			return Ok(read);
		},
		async write(path, bytes) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			kept.set(path, { bytes: bytes.slice(), modifiedMs: tick() });
			return Ok(undefined);
		},
		async list(dir) {
			const checked = checkPath(dir, { directory: true });
			if (checked.error !== null) return checked;
			const prefix = dir === '' ? '' : `${dir}/`;
			const entries: Entry[] = [];
			for (const [path, file] of kept) {
				if (!path.startsWith(prefix)) continue;
				const name = path.slice(prefix.length);
				if (name.includes('/') || !isPlainName(name)) continue;
				entries.push({
					name,
					size: file.bytes.length,
					modifiedMs: file.modifiedMs,
				});
			}
			return Ok(entries.sort((a, b) => (a.name < b.name ? -1 : 1)));
		},
		async remove(path) {
			const checked = checkPath(path);
			if (checked.error !== null) return checked;
			kept.delete(path);
			return Ok(undefined);
		},
	};
}
