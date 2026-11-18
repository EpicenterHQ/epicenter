// A directory experiment for a single writer and simple identifiers.
// Declarations know the layout; selection supplies one actual directory name.
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	ActionError,
	type AnyCollection,
	defineCollection,
	type field,
	folder,
	Ok,
	type RecordOf,
	type UploadedFile,
} from '@epicenter/app';

function segment(value: string) {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(value))
		throw new Error('Expected a simple filename or folder name');
	return value;
}

async function entries(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

async function addFile(path: string, upload: UploadedFile) {
	await mkdir(dirname(path), { recursive: true });
	await copyFile(upload.path(), path, constants.COPYFILE_EXCL);
	return Ok(null);
}

export function fileSlot(path: string) {
	const exists = async () => (await folder.readBytes(path)) !== undefined;
	return {
		exists,
		async add(upload: UploadedFile) {
			if (await exists())
				return ActionError.Refused({ message: `Already exists: ${path}` });
			await folder.writeBytes(path, await upload.bytes());
			return Ok(null);
		},
		async replace(upload: UploadedFile) {
			if (!(await exists())) return ActionError.Missing({ path });
			await folder.writeBytes(path, await upload.bytes());
			return Ok(null);
		},
	};
}

type Template = string;
type Keys = Record<string, string>;
type Part = (parent: Template) => {
	collections?: Record<string, AnyCollection>;
	collection?: AnyCollection;
	select: (keys: Keys, dir: string) => unknown;
};

// The demo exercises writable text and switch fields; 0.4.0 owns parsing and validation.
type DemoFields = Record<
	string,
	ReturnType<typeof field.text> | ReturnType<typeof field.boolean>
>;
function recordMarkdown<const F extends DemoFields>(name: string, fields: F) {
	type Document = RecordOf<{ path: 'data/{entry}/document.md'; fields: F }>;
	type Input = Pick<Document, Extract<keyof F, keyof Document>> & {
		body: string;
	};
	const schema: DemoFields = fields;
	return (parent: Template) => {
		const path: string = `${parent}/${name}`;
		if (!path.includes('{'))
			throw new Error(
				'Prototype supports validated records at keyed paths only',
			);
		const collection = defineCollection({
			path,
			fields: schema,
		});
		return {
			collection,
			select: (keys: Keys) => ({
				get: () => collection.get(keys),
				add: (data: Input) => collection.add({ ...data, ...keys }),
				set: (edit: { old: string; new: string }) => {
					// 'edit' is a reserved action input alongside the dynamic metadata fields.
					const { set } = collection.actions('set');
					const input: Parameters<typeof set>[0] = { ...keys };
					input.edit = edit;
					return set(input);
				},
			}),
		};
	};
}

function plainMarkdown(name: string) {
	return () => ({
		select: (_keys: Keys, dir: string) => {
			const path = join(dir, name);
			return {
				get: () => folder.read(path),
				set: (edit: { old: string; new: string }) =>
					folder.edit<null, ActionError>(path, (before) => {
						if (before === undefined) return ActionError.Missing({ path });
						if (!edit.old) return ActionError.Changed({ path, why: 'empty' });
						const at = before.indexOf(edit.old);
						if (at < 0) return ActionError.Changed({ path, why: 'quote' });
						if (before.indexOf(edit.old, at + 1) >= 0)
							return ActionError.Changed({ path, why: 'twice' });
						return Ok({
							value: null,
							text:
								before.slice(0, at) +
								edit.new +
								before.slice(at + edit.old.length),
						});
					}),
			};
		},
	});
}

function markdownFamily<const F extends DemoFields>(
	pattern: string,
	key: string,
	fields: F,
) {
	return (parent: string) => {
		if (parent.includes('{' + key + '}'))
			throw new Error('Repeated selector ' + key);
		const document = recordMarkdown(pattern, fields)(parent);
		return {
			collection: document.collection,
			select: (keys: Keys, dir: string) => ({
				// Scoped listing: direct matches only, even if the template has other parents.
				list: async () => {
					const matches = await document.collection.list();
					return matches.filter(
						(r) => dirname(r.error ? r.error.path : r.data.path) === dir,
					);
				},
				at: (id: string) => document.select({ ...keys, [key]: segment(id) }),
			}),
		};
	};
}
export function markdown<const F extends DemoFields>(
	pattern: `{${string}}.md`,
	fields: F,
): ReturnType<typeof markdownFamily<F>>;
export function markdown(name: string): ReturnType<typeof plainMarkdown>;
export function markdown<const F extends DemoFields>(
	name: string,
	fields: F,
): ReturnType<typeof recordMarkdown<F>>;
export function markdown(name: string, fields?: DemoFields) {
	const variable = /^\{([a-zA-Z]+)\}\.md$/.exec(name);
	if (variable && fields) return markdownFamily(name, variable[1]!, fields);
	segment(name);
	if (!name.endsWith('.md')) throw new Error('Expected a Markdown filename');
	return fields ? recordMarkdown(name, fields) : plainMarkdown(name);
}

export function file(name: string) {
	segment(name);
	return () => ({
		select: (_keys: Keys, dir: string) => ({
			...fileSlot(join(dir, name)),
			add: (upload: UploadedFile) =>
				addFile(join(folder.path!, dir, name), upload),
		}),
	});
}

// Only two shapes are needed here: all direct files in a subfolder, or one
// extension directly beside the document. Neither shape traverses recursively.
export function files(pattern: string) {
	const bucket = /^([a-z0-9_-]+)\/\*$/i.exec(pattern)?.[1];
	const extension = /^\*(\.[a-z0-9]+)$/i.exec(pattern)?.[1]?.toLowerCase();
	if (!bucket && (!extension || extension === '.md'))
		throw new Error('Expected folder/* or a non-Markdown *.extension');
	const matches = (name: string) =>
		!extension || name.toLowerCase().endsWith(extension);
	return () => ({
		select: (_keys: Keys, dir: string) => {
			const parent = bucket ? join(dir, bucket) : dir;
			return {
				add(upload: UploadedFile) {
					const name = segment(upload.name);
					if (!matches(name)) throw new Error(`Filename must match ${pattern}`);
					return addFile(join(folder.path!, parent, name), upload);
				},
				async list() {
					return (await entries(join(folder.path!, parent)))
						.filter((e) => e.isFile() && matches(e.name))
						.map((e) => e.name)
						.sort();
				},
			};
		},
	});
}

type Parts = Record<string, Part>;
type Children<P extends Parts> = {
	[N in keyof P]: ReturnType<ReturnType<P[N]>['select']>;
};

// A registered name is the caller's handle path: `videos.review` → `videos-review`.
const kebab = (name: string) =>
	name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function group<P extends Parts>(template: Template, parts: P) {
	const members = Object.entries(parts).map(([name, make]) => ({
		name,
		...make(template),
	}));
	const collections: Record<string, AnyCollection> = {};
	for (const m of members) {
		const own = m.collection
			? { [kebab(m.name)]: m.collection }
			: Object.fromEntries(
					Object.entries(m.collections ?? {}).map(([k, v]) => [
						kebab(m.name) + '-' + k,
						v,
					]),
				);
		for (const [key, collection] of Object.entries(own)) {
			if (key in collections)
				throw new Error('Duplicate Markdown collection: ' + key);
			collections[key] = collection;
		}
	}
	return {
		collections,
		select: (keys: Keys, dir: string) =>
			Object.fromEntries(
				members.map((m) => [m.name, m.select(keys, dir)]),
			) as Children<P>,
	};
}

function fixed<P extends Parts>(name: string, parts: P) {
	segment(name);
	return (parent: Template) => {
		const children = group(`${parent}/${name}`, parts);
		return {
			collections: children.collections,
			select: (keys: Keys, dir: string) =>
				children.select(keys, join(dir, name)),
		};
	};
}

function instances<T>(
	parent: () => string,
	select: (id: string, dir: string) => T,
) {
	return {
		async list() {
			return Ok(
				(await entries(join(folder.path!, parent())))
					.filter((e) => e.isDirectory())
					.map((e) => e.name)
					.sort(),
			);
		},
		at(name: string) {
			const id = segment(name);
			const dir = join(parent(), id);
			const children = select(id, dir);
			return {
				...children,
				async rename(to: string) {
					const dest = join(folder.path!, parent(), segment(to));
					const occupied = await lstat(dest).catch((error) => {
						if (error.code === 'ENOENT') return undefined;
						throw error;
					});
					if (occupied) throw new Error('An entry already has that name');
					await rename(join(folder.path!, dir), dest);
					return Ok(null);
				},
			};
		},
	};
}

function keyedRoot<P extends Parts>(parent: string, key: string, parts: P) {
	if ('rename' in parts) throw new Error('rename is reserved');
	// The declared selector names the template, so `check` reports {page}, not {entry}.
	const path = `${parent}/{${key}}`;
	const children = group(path, parts);
	return {
		path,
		collections: children.collections,
		...instances(
			() => parent,
			(id, dir) => children.select({ [key]: id }, dir),
		),
	};
}

function keyedChild<K extends string, P extends Parts>(
	name: string,
	key: K,
	parts: P,
) {
	if ('rename' in parts) throw new Error('rename is reserved');
	return (parent: Template) => {
		if (parent.includes('{' + key + '}'))
			throw new Error('Repeated selector ' + key);
		const base = name ? `${parent}/${name}` : parent;
		const children = group(`${base}/{${key}}`, parts);
		return {
			collections: children.collections,
			select: (keys: Keys, dir: string) =>
				instances(
					() => join(dir, name),
					(id, childDir) => children.select({ ...keys, [key]: id }, childDir),
				),
		};
	};
}

function staticRoot<P extends Parts>(path: string, parts: P) {
	if ('collections' in parts) throw new Error('collections is reserved');
	const children = group(path, parts);
	return {
		...children.select({}, path),
		path,
		collections: children.collections,
	};
}
export function defineDirectory<const K extends string, const P extends Parts>(
	path: `data/${string}/{${K}}`,
	parts: P,
): ReturnType<typeof keyedRoot<P>>;
export function defineDirectory<const K extends string, const P extends Parts>(
	path: `${string}/{${K}}`,
	parts: P,
): ReturnType<typeof keyedChild<K, P>>;
export function defineDirectory<const K extends string, const P extends Parts>(
	path: `{${K}}/` | `{${K}}`,
	parts: P,
): ReturnType<typeof keyedChild<K, P>>;
export function defineDirectory<const P extends Parts>(
	path: `data/${string}`,
	parts: P,
): ReturnType<typeof staticRoot<P>>;
export function defineDirectory<const P extends Parts>(
	name: string,
	parts: P,
): ReturnType<typeof fixed<P>>;
export function defineDirectory(path: string, parts: Parts) {
	const match = /^data\/([a-z0-9_-]+)\/\{([a-zA-Z]+)\}$/.exec(path);
	if (match) return keyedRoot('data/' + match[1], match[2]!, parts);
	if (/^data\/[a-z0-9_-]+$/.test(path)) return staticRoot(path, parts);
	const child = /^(?:([a-z0-9_-]+)\/)?\{([a-zA-Z]+)\}\/?$/.exec(path);
	return child
		? keyedChild(child[1] ?? '', child[2]!, parts)
		: fixed(path, parts);
}

type Registered = {
	readonly path: string;
	readonly collections: Record<string, AnyCollection>;
};

// `videos/{video}/review.md` → `videos-video-review`: a handle rename keeps the name.
const slug = (relative: string) =>
	relative
		.replace(/\.md$/, '')
		.replace(/[{}]/g, '')
		.split('/')
		.map(kebab)
		.join('-');

/**
 * What `defineApp({ collections })` takes, assembled from directories and plain
 * collections under the names the app imports them by. A directory's fielded
 * children are named by root and relative path: `collectionsOf({ pages })`
 * registers `pages-videos-video-review` for `videos/{video}/review.md`. A name
 * two entries would both produce throws instead of one silently replacing the other.
 */
export function collectionsOf(
	entries: Record<string, Registered | AnyCollection>,
): Record<string, AnyCollection> {
	const out: Record<string, AnyCollection> = {};
	const put = (name: string, collection: AnyCollection) => {
		if (name in out) throw new Error('Two entries register ' + name);
		out[name] = collection;
	};
	for (const [root, entry] of Object.entries(entries)) {
		if (!('collections' in entry)) {
			put(kebab(root), entry as AnyCollection);
			continue;
		}
		for (const collection of Object.values(entry.collections))
			put(
				kebab(root) + '-' + slug(collection.path.slice(entry.path.length + 1)),
				collection,
			);
	}
	return out;
}
