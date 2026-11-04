/**
 * `@epicenter/local` under the `test` condition: every file in memory, for
 * the life of the process, empty at first. A test writes what it needs
 * through the same `localFile(name)` the code under test reads.
 */
import { Ok } from 'wellcrafted/result';
import { createListeners, type OpenLocalFile } from './local-file.js';

export {
	type LocalFile,
	LocalFileError,
	type LocalText,
} from './local-file.js';

const files = new Map<string, { text: string; version: string }>();
const own = createListeners();
let writes = 0;

/** The file `name` in this process's memory. */
export const localFile: OpenLocalFile = (name) => ({
	async read() {
		return Ok(files.get(name) ?? null);
	},
	async write(text, over) {
		const current = files.get(name);
		const holds =
			over === 'absent' ? current === undefined : current?.version === over;
		if (!holds) return Ok('stale');
		const version = text === null ? 'absent' : String(++writes);
		if (text === null) files.delete(name);
		else files.set(name, { text, version });
		own.emit(name);
		return Ok({ version });
	},
	subscribe: (listener) => own.add(name, listener),
});
