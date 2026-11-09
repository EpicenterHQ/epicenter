/**
 * `proposeContract`: the collections a folder's files suggest, for
 * `epicenter init` to write into its `epicenter.json` (ADR-0813, ADR-0818).
 * It reads no disk: the caller lists the folder and passes each path, with
 * the text of each note.
 *
 * Files are grouped by their directory. A directory's notes become a
 * collection at `<dir>/{name}.md`, with a field for every front matter key
 * its notes hold, typed by the JSON values they hold there; its other files
 * become a collection at `<dir>/{name}.<ext>`, or `<dir>/{name}.{ext}` when
 * they have several extensions. A collection is named for its directory.
 * No field is proposed as required, so a note written later need not hold
 * every key the first ones did.
 *
 * What it leaves out, with the reason: a file directly in the folder (no
 * collection may claim `AGENTS.md`, and `{name}.md` there would), a note whose
 * front matter is not `key: <JSON>` (another tool's YAML), a key that names
 * the `{name}` placeholder, and a directory no pattern can spell.
 */
import { isJsonSafe } from '../json.js';
import { parseRowSource } from '../note/canonical.js';
import { type Collection, type Contract, compileContract } from './contract.js';
import { isHiddenPath, isNotePath } from './storage.js';

/** A path `proposeContract` left out of every collection, and why. */
export type Unproposed = { path: string; reason: string };

/** A proposal: the contract, and what it leaves out. */
export type Proposal = { contract: Contract; left: Unproposed[] };

/** The `$schema` an `epicenter.json` names, so an editor can check it. */
export const EPICENTER_JSON_SCHEMA =
	'https://epicenter.so/schema/epicenter.json';

/** The JSON Schema type of one value, or null for a JSON null. */
function typeOf(value: unknown): string | null {
	if (value === null) return null;
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number')
		return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
}

/** A collection name for `dir`: its segments as one identifier. */
function nameFor(dir: string): string {
	const name = dir
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (name === '') return 'files';
	return /^[0-9]/.test(name) ? `_${name}` : name;
}

const extensionOf = (file: string) => {
	const dot = file.lastIndexOf('.');
	return dot > 0 ? file.slice(dot + 1) : '';
};

/**
 * The contract `files` suggest, titled `title`. Paths are relative and
 * `/`-separated; a note's `text` lets its fields be proposed.
 *
 * @example
 * ```ts
 * proposeContract({
 *   title: 'Recordings',
 *   files: [
 *     { path: 'recordings/standup.md', text: '---\ntitle: "Standup"\n---\n' },
 *     { path: 'recordings/standup.webm' },
 *   ],
 * });
 * // { contract: { title: 'Recordings', collections: {
 * //   recordings: { path: 'recordings/{name}.md', fields: { title: { type: 'string' } } },
 * //   recordings_files: { path: 'recordings/{name}.webm' } } }, left: [] }
 * ```
 */
export function proposeContract({
	title,
	files,
}: {
	title: string;
	files: Iterable<{ path: string; text?: string }>;
}): Proposal {
	const left: Unproposed[] = [];
	const notes = new Map<string, { path: string; text?: string }[]>();
	const others = new Map<string, string[]>();
	for (const file of files) {
		const { path } = file;
		if (isHiddenPath(path) || path === 'epicenter.json' || path === 'AGENTS.md')
			continue;
		const slash = path.lastIndexOf('/');
		if (slash < 0) {
			left.push({
				path,
				reason: 'it is directly in the folder; keep items in a directory',
			});
			continue;
		}
		const dir = path.slice(0, slash);
		if (isNotePath(path)) notes.set(dir, [...(notes.get(dir) ?? []), file]);
		else others.set(dir, [...(others.get(dir) ?? []), path]);
	}

	const collections: Record<string, Collection> = {};
	const taken = new Set<string>();
	const claim = (wanted: string) => {
		let name = wanted;
		for (let n = 2; taken.has(name); n++) name = `${wanted}_${n}`;
		taken.add(name);
		return name;
	};
	/** Add `collection` when it compiles alone; otherwise leave its paths out. */
	const add = (
		name: string,
		collection: Collection,
		paths: readonly string[],
	) => {
		const compiled = compileContract({ collections: { [name]: collection } });
		if (compiled.error !== null) {
			for (const path of paths)
				left.push({ path, reason: compiled.error.reason });
			return;
		}
		collections[claim(name)] = collection;
	};

	for (const [dir, held] of [...notes].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const types = new Map<string, Set<string>>();
		for (const { path, text } of held) {
			if (text === undefined) continue;
			const parsed = parseRowSource(text);
			if (parsed.error !== null) {
				left.push({
					path,
					reason: `its fields were not proposed: ${parsed.error.reason}`,
				});
				continue;
			}
			for (const [key, value] of Object.entries(parsed.data.document.fields)) {
				if (!isJsonSafe(value)) continue;
				const kinds = types.get(key) ?? new Set<string>();
				const kind = typeOf(value);
				if (kind !== null) kinds.add(kind);
				types.set(key, kinds);
			}
		}
		const fields: Record<string, object> = {};
		for (const [key, kinds] of [...types].sort(([a], [b]) =>
			a < b ? -1 : 1,
		)) {
			if (key === 'name') {
				left.push({
					path: `${dir}/`,
					reason:
						"the key 'name' is the item's file name, {name}, so it is not a field",
				});
				continue;
			}
			// An integer field that also holds fractions is a number.
			if (kinds.has('number')) kinds.delete('integer');
			const [only] = kinds;
			fields[key] =
				kinds.size === 1 && only !== undefined ? { type: only } : {};
		}
		add(
			nameFor(dir),
			Object.keys(fields).length === 0
				? { path: `${dir}/{name}.md` }
				: { path: `${dir}/{name}.md`, fields },
			held.map(({ path }) => path),
		);
	}

	for (const [dir, paths] of [...others].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const extensions = new Set(
			paths.map((path) => extensionOf(path.slice(dir.length + 1))),
		);
		const [only] = extensions;
		const pattern =
			extensions.size === 1 && only !== undefined
				? only === ''
					? `${dir}/{name}`
					: `${dir}/{name}.${only}`
				: `${dir}/{name}.{ext}`;
		if (extensions.size > 1 && extensions.has('')) {
			for (const path of paths)
				if (extensionOf(path.slice(dir.length + 1)) === '')
					left.push({
						path,
						reason: 'it has no extension, unlike the other files beside it',
					});
		}
		add(
			notes.has(dir) ? `${nameFor(dir)}_files` : nameFor(dir),
			{ path: pattern },
			paths,
		);
	}

	return {
		contract: { $schema: EPICENTER_JSON_SCHEMA, title, collections },
		left,
	};
}
