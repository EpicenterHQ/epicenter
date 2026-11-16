/**
 * PROTOTYPE: Can a record own its Markdown file and arbitrary neighboring files,
 * adopting field.file uploads without storing host references? Throwaway evidence.
 * No update(), copying between records, or deletion recovery tool. The claim shim
 * only takes the host's one-process lock. Folder lacks directory operations.
 * field.file limits each upload to 15 MiB; this makes no large-file claim.
 * Run: bun packages/cli/examples/collection-files.prototype.ts
 * Decision: docs/adr/0909-a-collection-that-holds-files-gives-each-record-a-directory-it-owns.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
	unlink,
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Static, type TObject, type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';
import type { Action, ActionMeta } from './action.js';
import { defineCollection, type Fields } from './collection.js';
import { folder, isLocalPath } from './context.js';
import { ActionError } from './errors.js';
import { fileFieldOf, type UploadedFile } from './field.js';
import { type FieldValues, markdownOf } from './front-matter.js';
import { type Placeholders, template, templateProblem } from './path.js';

export function markdownTarget(file: string) {
	return encodeURIComponent(file).replace(
		/[()'!*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

export type OwnedFile = {
	folder: string;
	record: string;
	file: string;
	href: string;
	type: string;
	size: number;
	missing?: true;
	notAFile?: true;
};
type ReadValue<T> = T extends UploadedFile
	? OwnedFile
	: T extends UploadedFile[]
		? OwnedFile[]
		: T;
type InputValue<T> = T extends UploadedFile
	? UploadedFile | OwnedFile
	: T extends UploadedFile[]
		? (UploadedFile | OwnedFile)[]
		: T;
type Inputs<TFields extends Fields> = {
	[K in keyof Static<TObject<TFields>>]: InputValue<
		Static<TObject<TFields>>[K]
	>;
};
type RecordValue<TFields extends Fields> = {
	[K in keyof TFields]?: ReadValue<Static<TFields[K]>>;
} & { path: string; body: string; problems?: string[]; other?: FieldValues };
type Role = {
	list: boolean;
	schema: TSchema;
	item: TSchema;
	limits: NonNullable<ReturnType<typeof fileFieldOf>>;
};
const optional = (schema: TSchema) =>
	(schema as TSchema & { '~optional'?: boolean })['~optional'] === true;
// A strict end assertion also rejects a final newline (JavaScript's $ can precede it).
const namePattern =
	'^[^.\\x00-\\x1f\\x7f/\\\\:][^\\x00-\\x1f\\x7f/\\\\:]*(?![\\s\\S])';
const nameFits = new RegExp(namePattern);
const claim = Symbol('directory claim');
const exists = async (path: string) =>
	lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	});
async function hash(path: string) {
	const sum = createHash('sha256');
	for await (const bytes of createReadStream(path)) sum.update(bytes);
	return sum.digest('hex');
}
async function sync(path: string) {
	const file = await open(path, 'r');
	try {
		await file.sync().catch(() => {});
	} finally {
		await file.close();
	}
}
function containsMarker(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	if (Object.hasOwn(value, 'x-epicenter-file')) return true;
	return Object.values(value).some(containsMarker);
}
function uploaded(value: unknown): value is UploadedFile {
	if (!value || typeof value !== 'object') return false;
	const file = value as Partial<UploadedFile>;
	return (
		typeof file.name === 'string' &&
		typeof file.size === 'number' &&
		typeof file.path === 'function'
	);
}
function owned(value: unknown): value is OwnedFile {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as OwnedFile).file === 'string' &&
		typeof (value as OwnedFile).record === 'string' &&
		typeof (value as OwnedFile).folder === 'string'
	);
}

export function defineDirectoryCollection<
	const TPath extends string,
	const TFields extends Fields,
>(def: {
	path: TPath;
	owns: 'directory';
	description?: string;
	fields: TFields;
}) {
	if (def.owns !== 'directory') throw new Error("owns must be 'directory'");
	const problem = templateProblem(def.path);
	if (problem) throw new Error(problem);
	if (!def.path.startsWith('data/'))
		throw new Error('path must start with data/');
	if (isLocalPath(def.path))
		throw new Error('a directory collection cannot have a .local path');
	const layout = template(def.path);
	if (!layout.placeholders.length)
		throw new Error('path needs at least one placeholder');
	const metadata = basename(def.path);
	if (metadata.includes('{'))
		throw new Error('the last segment must be a literal Markdown file name');
	if (!basename(dirname(def.path)).includes('{'))
		throw new Error(
			'the segment before the Markdown file must contain a placeholder',
		);
	const roles: Record<string, Role> = {};
	const storedFields: Fields = {};
	for (const [key, schema] of Object.entries(def.fields)) {
		const list = (schema as TSchema & { type?: string }).type === 'array';
		const item = list ? (schema as TSchema & { items: TSchema }).items : schema;
		const limits = fileFieldOf(item);
		if (limits) {
			// Refuse extra nested markers even on a marked schema.
			const { 'x-epicenter-file': _, ...rest } = item as TSchema &
				Record<string, unknown>;
			if (containsMarker(rest))
				throw new Error(
					`${key}: file markers are allowed only as a field or array item`,
				);
			roles[key] = { list, item, schema, limits };
			let stored: TSchema = Type.String({
				pattern: namePattern,
				not: { const: metadata },
				description: "a file in this record's directory",
			});
			if (list) stored = Type.Array(stored);
			if (optional(schema)) stored = Type.Optional(stored);
			storedFields[key] = stored;
		} else {
			if (containsMarker(schema))
				throw new Error(
					`${key}: file markers are allowed only as a field or array item`,
				);
			storedFields[key] = schema;
		}
	}
	const stored = defineCollection({
		path: def.path as string,
		description: def.description,
		fields: storedFields,
	});
	async function disk() {
		if (!folder.path) throw new Error('needs a folder on disk');
		const root = await realpath(folder.path);
		// Hashing a guessable path lets someone confirm a guess. Moving the app
		// folder changes this id, so older descriptors are refused.
		return {
			root,
			folder: createHash('sha256')
				.update(`epicenter-owner\0${root}`)
				.digest('hex')
				.slice(0, 32),
			local: join(root, layout.dir, '.epicenter.local'),
		};
	}
	function address(path: string) {
		if (!stored.holds(path)) throw new Error(`not a record at ${def.path}`);
		return path;
	}
	async function safeDirectory(root: string, relative: string) {
		let at = root;
		for (const part of relative.split('/')) {
			at = join(at, part);
			const stat = await exists(at);
			if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
				throw new Error(`${relative}/ is not a regular directory`);
		}
	}
	async function safeDocument(root: string, path: string) {
		await safeDirectory(root, dirname(path));
		const stat = await exists(join(root, path));
		if (stat && !stat.isFile())
			throw new Error(`${path} is not a regular file, so it is not read`);
		// Prototype limit: lstat then read has a race window. Production needs
		// a no-follow read in Folder.
	}
	async function claimWrite(path: string) {
		await safeDocument((await disk()).root, path);
		// Prototype shim: forCall claims its lock before invoking the callback;
		// folder.update also enforces the read-only guard before any raw disk write.
		try {
			await folder.update(path, () => {
				throw claim;
			});
		} catch (error) {
			if (error !== claim) throw error;
		}
	}
	async function project(record: Record<string, unknown>) {
		const { root, folder: owner } = await disk();
		const path = record.path as string;
		const problems = [...((record.problems as string[]) ?? [])];
		const result = { ...record };
		for (const [key, role] of Object.entries(roles)) {
			if (record[key] === undefined) continue;
			const names = role.list
				? (record[key] as string[])
				: [record[key] as string];
			const files: OwnedFile[] = [];
			for (const file of names) {
				await safeDirectory(root, dirname(path));
				const stat = await exists(join(root, dirname(path), file));
				const bad = !stat
					? { missing: true as const }
					: !stat.isFile() || stat.isSymbolicLink()
						? { notAFile: true as const }
						: {};
				if ('missing' in bad || 'notAFile' in bad)
					problems.push(
						`${key}: ${file} ${stat ? 'is not a regular file' : 'is missing'}`,
					);
				files.push({
					folder: owner,
					record: path,
					file,
					href: markdownTarget(file),
					type: Bun.file(file).type || 'application/octet-stream',
					size: stat?.size ?? 0,
					...bad,
				});
			}
			result[key] = role.list ? files : files[0];
		}
		if (problems.length) result.problems = problems;
		return result as RecordValue<TFields>;
	}
	async function validate(
		path: string,
		given: Record<string, unknown>,
		adding: boolean,
	) {
		const { root, folder: owner } = await disk();
		const values: Record<string, unknown> = {};
		if (adding)
			for (const [key, schema] of Object.entries(storedFields))
				if (Object.hasOwn(schema, 'default'))
					values[key] = structuredClone(
						(schema as TSchema & { default: unknown }).default,
					);
		for (const [key, value] of Object.entries(given)) {
			if (value === undefined) continue;
			const schema = storedFields[key];
			if (!schema) throw new Error(`${path} has no field "${key}"`);
			if (value === null) {
				if (adding || !optional(schema))
					throw new Error(`${key} is required, so it cannot be removed`);
				values[key] = null;
				continue;
			}
			const role = roles[key];
			if (!role) {
				if (!Value.Check(schema, value))
					throw new Error(`${key} does not fit its stored schema`);
				values[key] = value;
				continue;
			}
			if (role.list && !Array.isArray(value))
				throw new Error(`${key} must be a list of files`);
			const files = role.list ? (value as unknown[]) : [value];
			for (const [index, file] of files.entries()) {
				const label = role.list ? `${key}[${index}]` : key;
				if (typeof file === 'string')
					throw new Error(
						`${label} is an upload reference the host did not turn into a file; nothing was stored`,
					);
				const { limits } = role;
				if (uploaded(file)) {
					const baseType = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
					if (
						limits.accept &&
						!limits.accept.some((entry) => {
							const accepted = entry.toLowerCase();
							return (
								accepted === baseType ||
								(accepted.endsWith('/*') &&
									baseType.startsWith(accepted.slice(0, -1)))
							);
						})
					)
						throw new Error(
							`${label}: ${file.type} is not accepted (${limits.accept.join(', ')})`,
						);
					if (file.size > limits.maxBytes)
						throw new Error(`${label} is larger than ${limits.maxBytes} bytes`);
					continue;
				}
				if (!adding && owned(file)) {
					if (file.folder !== owner || file.record !== path)
						throw new Error(
							`${label} is a file of ${file.record} in ${file.folder}; a record selects only its own files`,
						);
					if (!nameFits.test(file.file) || file.file === metadata)
						throw new Error(`${label} is not a record-relative file name`);
					const stat = await exists(join(root, dirname(path), file.file));
					if (!stat?.isFile() || stat.isSymbolicLink())
						throw new Error(`${label} is not a regular file of ${path}`);
					// An owned file's type would be a filename guess, so only size is checked.
					if (stat.size > limits.maxBytes)
						throw new Error(`${label} is larger than ${limits.maxBytes} bytes`);
					continue;
				}
				throw new Error(
					`${label} needs an UploadedFile${adding ? '; copying an OwnedFile is not built in this prototype' : ' or a file of this record'}`,
				);
			}
			values[key] = value;
		}
		if (adding)
			for (const [key, schema] of Object.entries(storedFields)) {
				if (!optional(schema) && values[key] === undefined)
					throw new Error(`${key} is missing`);
				if (
					!roles[key] &&
					values[key] !== undefined &&
					!Value.Check(schema, values[key])
				)
					throw new Error(`${key} does not fit its stored schema`);
			}
		return values;
	}
	async function staging() {
		const { root, local } = await disk();
		await safeDirectory(root, `${layout.dir}.epicenter.local/staging`);
		const dir = join(local, 'staging', randomUUID());
		await mkdir(dir, { recursive: true });
		return dir;
	}
	async function copy(
		upload: UploadedFile,
		key: string,
		stage: string,
		label: string,
		maxBytes: number,
	) {
		const tmp = join(stage, randomUUID());
		const sum = createHash('sha256');
		let size = 0;
		await pipeline(
			createReadStream(upload.path()),
			new Transform({
				transform(chunk, _encoding, done) {
					size += chunk.length;
					if (size > maxBytes)
						return done(new Error(`${label} is larger than ${maxBytes} bytes`));
					sum.update(chunk);
					done(null, chunk);
				},
			}),
			createWriteStream(tmp, { flags: 'wx' }),
		);
		if (size !== upload.size)
			throw new Error(`${label} changed size while it was read`);
		await sync(tmp);
		const digest = sum.digest('hex');
		const normalized = upload.name.normalize('NFC');
		const suffix = extname(normalized);
		const ext = /^\.[a-z0-9]{1,10}$/i.test(suffix) ? suffix.toLowerCase() : '';
		let stem = (ext ? normalized.slice(0, -suffix.length) : normalized)
			.split('')
			.filter(
				(character) =>
					character >= ' ' &&
					character !== '\x7f' &&
					!'/\\:'.includes(character),
			)
			.join('')
			.replace(/^\.+/, '')
			.trim()
			.replace(/\s+/g, '-');
		while (Buffer.byteLength(stem) > 64) stem = [...stem].slice(0, -1).join('');
		if (!stem || stem === 'blob') stem = key;
		return {
			tmp,
			digest,
			stem: stem.replace(/\.local(?=\.|$)/gi, '-local'),
			ext,
		};
	}
	async function adopt(
		values: Record<string, unknown>,
		stage: string,
		destination: string,
		created: string[],
	) {
		const result = { ...values };
		for (const [key, role] of Object.entries(roles)) {
			const value = values[key];
			if (value == null) continue;
			const names: string[] = [];
			for (const [index, file] of (role.list
				? (value as (UploadedFile | OwnedFile)[])
				: [value as UploadedFile | OwnedFile]
			).entries()) {
				if (!uploaded(file)) {
					names.push(file.file);
					continue;
				}
				const copied = await copy(
					file,
					key,
					stage,
					role.list ? `${key}[${index}]` : key,
					role.limits.maxBytes,
				);
				for (let n = 1; ; n++) {
					let name = `${copied.stem}-${copied.digest.slice(0, 8)}${n === 1 ? '' : `-${n}`}${copied.ext}`;
					if (isLocalPath(name)) name = name.replace(/\.local/gi, '-local');
					if (name === metadata) continue;
					const dest = join(destination, name);
					try {
						await link(copied.tmp, dest);
						created.push(dest);
						names.push(name);
						break;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
						const stat = await lstat(dest);
						if (
							stat.isFile() &&
							!stat.isSymbolicLink() &&
							(await hash(dest)) === copied.digest
						) {
							names.push(name);
							break;
						}
					}
				}
				await unlink(copied.tmp);
			}
			result[key] = role.list ? names : names[0];
		}
		return result;
	}
	async function recordDirectories(root: string) {
		const paths: string[] = [];
		const problems: string[] = [];
		const directoryParts = def.path.split('/').slice(0, -1);
		async function walk(at: string, depth: number) {
			if (depth === directoryParts.length) {
				const path = `${at}/${metadata}`;
				if (!layout.match(path)) return;
				paths.push(path);
				return;
			}
			for (const name of await readdir(join(root, at)).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') return [];
					throw error;
				},
			)) {
				if (name.startsWith('.') || isLocalPath(name)) continue;
				const next = at ? `${at}/${name}` : name;
				const stat = await lstat(join(root, next));
				if (stat.isSymbolicLink()) {
					if (
						depth + 1 === directoryParts.length &&
						layout.match(`${next}/${metadata}`)
					)
						problems.push(`${next}/ is a symlinked record directory`);
					continue;
				}
				if (stat.isDirectory()) await walk(next, depth + 1);
			}
		}
		await walk('', 0);
		return { paths: paths.sort(), problems };
	}
	const methods = {
		async list() {
			const { root } = await disk();
			const { paths } = await recordDirectories(root);
			const records: RecordValue<TFields>[] = [];
			for (const path of paths) {
				if (!(await exists(join(root, path)))?.isFile()) continue;
				const record = await methods.get({ path });
				if (record) records.push(record);
			}
			return records;
		},
		async get({ path }: { path: string }) {
			const { root } = await disk();
			address(path);
			await safeDocument(root, path);
			const record = await stored.get({ path });
			return record ? project(record) : undefined;
		},
		async edit(input: { path: string; old: string; new: string }) {
			const { root } = await disk();
			address(input.path);
			await safeDocument(root, input.path);
			return project(await stored.edit(input));
		},
		async add(
			input: Inputs<TFields> & {
				[K in Exclude<Placeholders<TPath>, 'time'>]: string;
			} & { body?: string },
		) {
			const raw = { ...input } as Record<string, unknown>;
			const path = stored.pathOf(raw as Record<string, string>);
			const body = raw.body ?? '';
			if (typeof body !== 'string') throw new Error('body must be text');
			delete raw.body;
			for (const key of layout.placeholders) delete raw[key];
			const values = await validate(path, raw, true);
			const { root } = await disk();
			const directory = dirname(path);
			await safeDirectory(root, dirname(directory));
			const target = join(root, directory);
			if (await exists(target))
				throw new Error(`${directory}/ is already there`);
			await claimWrite(path);
			const stage = await staging();
			try {
				const recordStage = join(stage, 'record');
				await mkdir(recordStage);
				const adopted = await adopt(values, stage, recordStage, []);
				const ordered = Object.fromEntries(
					Object.keys(storedFields)
						.filter((key) => adopted[key] !== undefined)
						.map((key) => [key, adopted[key]]),
				) as FieldValues;
				const file = join(recordStage, metadata);
				await Bun.write(file, markdownOf(ordered, body));
				await sync(file);
				await safeDirectory(root, dirname(directory));
				await mkdir(dirname(target), { recursive: true });
				if (await exists(target))
					throw new Error(`${directory}/ is already there`);
				await rename(recordStage, target);
			} finally {
				await rm(stage, { recursive: true, force: true });
			}
			const record = await methods.get({ path });
			if (!record) throw ActionError.Missing({ path }).error;
			return record;
		},
		async set(
			input: { path: string } & {
				[K in keyof TFields]?:
					| InputValue<Static<TFields[K]>>
					| (TFields[K] extends { '~optional': true } ? null : never);
			},
		) {
			const { path, ...given } = input;
			address(path);
			const { root } = await disk();
			await safeDocument(root, path);
			if (!(await stored.get({ path })))
				throw ActionError.Missing({ path }).error;
			const values = await validate(path, given, false);
			if (!Object.keys(values).length)
				throw new Error(`Nothing to set in ${path}: give a field`);
			await claimWrite(path);
			const stage = await staging();
			const created: string[] = [];
			let updated: Awaited<ReturnType<typeof stored.set>>;
			try {
				const names = await adopt(
					values,
					stage,
					join(root, dirname(path)),
					created,
				);
				await safeDocument(root, path);
				updated = await stored.set({ path, ...names });
			} catch (error) {
				await Promise.all(created.map((file) => unlink(file)));
				throw error;
			} finally {
				await rm(stage, { recursive: true, force: true });
			}
			return project(updated);
		},
		async delete({ path }: { path: string }) {
			address(path);
			const { root, local } = await disk();
			const directory = dirname(path);
			await safeDirectory(root, directory);
			if (!(await exists(join(root, directory)))) return false;
			// Claim through an absent non-local document, without reading the record.
			// A local path would bypass the read-only guard.
			await claimWrite(`${layout.dir}delete-claim-${randomUUID()}.md`);
			await safeDirectory(root, `${layout.dir}.epicenter.local/trash`);
			await mkdir(join(local, 'trash'), { recursive: true });
			const trash = join(
				local,
				'trash',
				`${randomUUID()}-${basename(directory)}`,
			);
			// A crash after rename leaves a recoverable group, never a half record.
			await rename(join(root, directory), trash);
			await rm(trash, { recursive: true });
			return true;
		},
		async move({
			path,
			to,
		}: {
			path: string;
			to: Record<Placeholders<TPath>, string>;
		}) {
			address(path);
			const { root } = await disk();
			const next = stored.pathOf(to);
			await safeDocument(root, path);
			await safeDocument(root, next);
			if (await exists(join(root, dirname(next))))
				throw new Error(`${dirname(next)}/ is already there`);
			if (!(await stored.get({ path })))
				throw ActionError.Missing({ path }).error;
			await claimWrite(path);
			await mkdir(join(root, dirname(dirname(next))), { recursive: true });
			await rename(join(root, dirname(path)), join(root, dirname(next)));
			const record = await methods.get({ path: next });
			if (!record) throw ActionError.Missing({ path: next }).error;
			return record;
		},
		async inventory({ path }: { path: string }) {
			address(path);
			const { root } = await disk();
			await safeDocument(root, path);
			const record = await stored.get({ path });
			const entries: {
				file: string;
				kind: 'file' | 'symlink' | 'directory' | 'other';
				size?: number;
				roles: string[];
			}[] = [];
			async function walk(relative: string) {
				const dir = join(root, dirname(path), relative);
				for (const name of (await readdir(dir)).sort()) {
					const file = relative ? `${relative}/${name}` : name;
					if (file === metadata) continue;
					const stat = await lstat(join(dir, name));
					const kind = stat.isSymbolicLink()
						? 'symlink'
						: stat.isFile()
							? 'file'
							: stat.isDirectory()
								? 'directory'
								: 'other';
					const selected = Object.entries(roles)
						.filter(([key, role]) =>
							role.list
								? Array.isArray(record?.[key]) &&
									(record?.[key] as string[] | undefined)?.includes(file)
								: record?.[key] === file,
						)
						.map(([key]) => key);
					entries.push({ file, kind, size: stat.size, roles: selected });
					if (kind === 'directory') await walk(file);
				}
			}
			await walk('');
			return entries;
		},
		async check() {
			const { root, local } = await disk();
			const { paths, problems } = await recordDirectories(root);
			for (const path of paths) {
				const stat = await exists(join(root, path));
				if (!stat) problems.push(`${dirname(path)}/ lacks ${metadata}`);
				else if (stat.isSymbolicLink())
					problems.push(`${path} is a symlink, not read`);
				else if (!stat.isFile())
					problems.push(`${path} is not a regular file, so it is not read`);
				else {
					const record = await methods.get({ path });
					problems.push(
						...(record?.problems ?? []).map((problem) => `${path}: ${problem}`),
					);
				}
			}
			for (const kind of ['staging', 'trash']) {
				await safeDirectory(root, `${layout.dir}.epicenter.local/${kind}`);
				for (const name of await readdir(join(local, kind)).catch(
					(error: NodeJS.ErrnoException) => {
						if (error.code === 'ENOENT') return [];
						throw error;
					},
				))
					problems.push(
						`${layout.dir}.epicenter.local/${kind}/${name} is a leftover`,
					);
			}
			return problems;
		},
		holds: stored.holds,
		pathOf: stored.pathOf,
	};
	function actions(): Record<
		'list' | 'get' | 'add' | 'set' | 'delete',
		Action
	> {
		const base = stored.actions();
		const writable = Object.fromEntries(
			Object.entries(def.fields).filter(
				([, schema]) => !(schema as TSchema & { readOnly?: boolean }).readOnly,
			),
		);
		const addInput = { ...base.add.input };
		const setInput = { ...base.set.input };
		for (const [key, role] of Object.entries(roles)) {
			if (!(key in writable)) continue;
			const schema = role.list
				? Type.Optional(
						Type.Array(role.item, {
							description:
								'The current host cannot deliver files inside a list',
						}),
					)
				: role.schema;
			addInput[key] = schema;
			setInput[key] = Type.Optional(schema);
		}
		// Clearing and selecting OwnedFile values are method-level only: the current
		// host decodes only top-level file inputs, with no null union for file roles.
		const action = (
			run: (input: Record<string, unknown>) => unknown,
			meta: ActionMeta,
		): Action =>
			Object.assign(async (input?: unknown) => {
				const given = (input ?? {}) as Record<string, unknown>;
				for (const key of Object.keys(given))
					if (
						(def.fields[key] as (TSchema & { readOnly?: boolean }) | undefined)
							?.readOnly
					)
						throw new Error(`${key} is written only by the app's own actions`);
				return run(given);
			}, meta);
		return {
			list: action(() => methods.list(), base.list),
			get: action(async (input) => {
				const record = await methods.get(input as { path: string });
				if (!record)
					throw ActionError.Missing({ path: input.path as string }).error;
				return record;
			}, base.get),
			add: action(
				(input) => methods.add(input as Parameters<typeof methods.add>[0]),
				{ ...base.add, input: addInput },
			),
			set: action(
				(input) => methods.set(input as Parameters<typeof methods.set>[0]),
				{ ...base.set, input: setInput },
			),
			delete: action(
				(input) => methods.delete(input as { path: string }),
				base.delete,
			),
		};
	}
	return { ...def, ...methods, actions };
}

/** Conservative segment-prefix reasoning: placeholders are wildcards, so this
 * may report false positives for incompatible literal affixes. It does not
 * resolve filesystem aliases or symlinks. Both directions are checked. */
export function ownershipOverlaps(
	collections: Record<string, { path: string; owns?: string }>,
): string[] {
	const problems: string[] = [];
	for (const [owner, collection] of Object.entries(collections)) {
		if (collection.owns !== 'directory') continue;
		const directory = collection.path.split('/').slice(0, -1);
		for (const [name, other] of Object.entries(collections)) {
			if (name === owner) continue;
			const parts = other.path.split('/');
			if (
				parts.length > directory.length &&
				directory.every(
					(part, index) =>
						part.includes('{') ||
						parts[index]?.includes('{') ||
						part === parts[index],
				)
			)
				problems.push(
					`${name} can place files inside ${owner}'s owned record directory`,
				);
		}
	}
	return problems;
}
