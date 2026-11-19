/**
 * `Files` in memory, for tests: a map from path to bytes. Each read and
 * write copies, so a caller that changes its array changes nothing kept.
 */
import { Ok } from 'wellcrafted/result';
import { checkPath, type Files, isPlainName, toBytes } from './files';

export function memoryFiles(initial: Record<string, string> = {}): Files {
	const kept = new Map(
		Object.entries(initial).map(([path, text]) => [path, toBytes(text)]),
	);
	const decoder = new TextDecoder();
	return {
		async list(dir) {
			const checked = checkPath(dir, { directory: true });
			if (checked.error) return checked;
			const prefix = dir === '' ? '' : `${dir}/`;
			const names = [...kept.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length))
				.filter((name) => !name.includes('/') && isPlainName(name));
			return Ok(names.sort());
		},
		async readMany(paths) {
			const read = new Map<string, string>();
			for (const path of paths) {
				const checked = checkPath(path);
				if (checked.error) return checked;
				const bytes = kept.get(path);
				if (bytes) read.set(path, decoder.decode(bytes));
			}
			return Ok(read);
		},
		async write(path, contents) {
			const checked = checkPath(path);
			if (checked.error) return checked;
			kept.set(path, toBytes(contents).slice());
			return Ok(undefined);
		},
		async remove(path) {
			const checked = checkPath(path);
			if (checked.error) return checked;
			kept.delete(path);
			return Ok(undefined);
		},
		async url(path) {
			const checked = checkPath(path);
			if (checked.error) return checked;
			return Ok(`memory:${path}`);
		},
	};
}
