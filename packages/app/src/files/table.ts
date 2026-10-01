/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0462).
 *
 * An entry is one captured observation of a row file: its exact source, the
 * version of those bytes, the interpretation of its fields and body, and
 * conformance issues. Writes receive the whole entry and publish only if the
 * file still has that exact version (ADR-0464). A row owns zero or one
 * same-stem attachment (ADR-0456); ambiguity refuses app deletion and rename.
 */

import { customAlphabet } from 'nanoid';
import type { Static, TSchema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ParsedTable } from '../data/definition/compile.js';
import type { TableDeclaration } from '../data/definition/declaration.js';
import type { FileBoundary, FileChange } from './boundary.js';
import {
	FileError,
	TableError,
	type TableReadError,
	type TableWriteError,
} from './errors.js';
import { composeSource, patchSource, readSource } from './markdown.js';
import {
	attachmentStemOf,
	collisionKey,
	isAttachmentExtension,
	pathProblem,
	ROW_EXTENSION,
	rowPath,
	rowStemOf,
	stemProblem,
} from './paths.js';
import { captureVersion, type FileVersion } from './version.js';

export type FieldsOf<TTable extends TableDeclaration> = {
	-readonly [K in keyof TTable['fields']]: TTable['fields'][K] extends TSchema
		? Static<TTable['fields'][K]>
		: never;
};

export type EntryIssue =
	| { readonly kind: 'filename'; readonly message: string }
	| { readonly kind: 'frontmatter'; readonly message: string }
	| { readonly kind: 'field'; readonly field: string; readonly message: string }
	| {
			readonly kind: 'attachment';
			readonly message: string;
			readonly candidates: readonly string[];
	  };

type EntryBase = {
	readonly path: string;
	readonly version: FileVersion;
	readonly source: string;
	/** The one unambiguous same-stem attachment, if any. */
	readonly attachment: string | undefined;
};

export type ValidEntry<TFields> = EntryBase & {
	readonly stem: string;
	readonly fields: Readonly<TFields>;
	readonly body: string;
	readonly issues: undefined;
};

export type InvalidEntry<TFields> = EntryBase & {
	readonly stem: string | undefined;
	/** Only declared fields that validated independently. */
	readonly fields: Readonly<Partial<TFields>>;
	readonly body: string | undefined;
	readonly issues: readonly [EntryIssue, ...EntryIssue[]];
};

/** One immutable observation of a row file. `issues` discriminates the variants. */
export type Entry<TFields> = ValidEntry<TFields> | InvalidEntry<TFields>;

export type TableListing<TFields> = {
	readonly entries: readonly Entry<TFields>[];
	/** Row files that were enumerated but whose bytes could not be read as UTF-8 text. */
	readonly unreadable: readonly {
		readonly path: string;
		readonly error: TableReadError | TableError;
	}[];
};

export type CreateInput<TFields> = {
	/** The file stem; generated when omitted. It is not the title. */
	readonly stem?: string;
	readonly fields: TFields;
	readonly body?: string;
	readonly attachment?: {
		readonly extension: string;
		readonly bytes: Uint8Array;
	};
};

export type FileTable<TFields> = {
	readonly name: string;
	list(): Promise<Result<TableListing<TFields>, TableReadError>>;
	get(
		stem: string,
	): Promise<Result<Entry<TFields> | undefined, TableReadError | TableError>>;
	create(
		input: CreateInput<TFields>,
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	update(
		entry: Entry<TFields>,
		change: { readonly fields?: Partial<TFields>; readonly body?: string },
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	writeSource(
		entry: Entry<TFields>,
		source: string,
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	rename(
		entry: Entry<TFields>,
		nextStem: string,
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	delete(
		entry: Entry<TFields>,
	): Promise<Result<{ readonly removed: readonly string[] }, TableWriteError>>;
};

/** How a table publishes: through the folder's admitted file boundary. */
export type TableContext = {
	readonly boundary: FileBoundary;
	/** Runs admitted work; refuses after the folder starts closing. */
	admit<T, E>(
		work: () => Promise<Result<T, E>>,
	): Promise<Result<T, E | FileError>>;
	/**
	 * Publish a managed operation and invalidate observations for any landed
	 * changes. Only a complete operation requests an automatic commit.
	 */
	publish: FileBoundary['apply'];
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const generateStem = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function decode(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

type Candidates = ReadonlyMap<string, readonly string[]>;

/** Group same-stem attachment candidates in a table directory by owning stem. */
function attachmentCandidates(
	table: string,
	filenames: readonly string[],
): Candidates {
	const result = new Map<string, string[]>();
	for (const filename of filenames) {
		const stem = attachmentStemOf(filename);
		if (stem === undefined) continue;
		const list = result.get(stem) ?? [];
		list.push(`${table}/${filename}`);
		result.set(stem, list);
	}
	return result;
}

export function createFileTable<TTable extends TableDeclaration>(
	name: string,
	parsed: ParsedTable,
	context: TableContext,
): FileTable<FieldsOf<TTable>> {
	type TFields = FieldsOf<TTable>;
	const { boundary } = context;
	const declared = [...parsed.fields.keys()];

	function interpret(
		path: string,
		version: FileVersion,
		source: string,
		candidates: readonly string[],
	): Entry<TFields> {
		const stem = path.slice(name.length + 1, -ROW_EXTENSION.length);
		const issues: EntryIssue[] = [];
		const stemIssue = stemProblem(stem);
		if (stemIssue !== undefined)
			issues.push({ kind: 'filename', message: stemIssue });
		let attachment: string | undefined;
		if (candidates.length === 1) attachment = candidates[0];
		else if (candidates.length > 1)
			issues.push({
				kind: 'attachment',
				message: `${candidates.length} same-stem attachment candidates`,
				candidates,
			});
		const reading = readSource(source);
		for (const issue of reading.issues) issues.push(issue);
		const fields: Record<string, unknown> = {};
		if (reading.values !== undefined) {
			for (const key of declared) {
				const field = parsed.fields.get(key)!;
				if (!Object.hasOwn(reading.values, key)) {
					issues.push({
						kind: 'field',
						field: key,
						message: 'The field is missing',
					});
					continue;
				}
				const value = reading.values[key];
				if (field.check(value)) fields[key] = value;
				else
					issues.push({
						kind: 'field',
						field: key,
						message: `The value does not conform to its ${field.kind} field`,
					});
			}
		}
		const base = { path, version, source, attachment };
		if (issues.length === 0 && reading.body !== undefined)
			return Object.freeze({
				...base,
				stem,
				fields: Object.freeze(fields) as TFields,
				body: reading.body,
				issues: undefined,
			});
		return Object.freeze({
			...base,
			stem: stemIssue === undefined ? stem : undefined,
			fields: Object.freeze(fields) as Partial<TFields>,
			body: reading.body,
			issues: Object.freeze(issues) as unknown as readonly [
				EntryIssue,
				...EntryIssue[],
			],
		});
	}

	async function directory(): Promise<
		Result<{ files: string[]; candidates: Candidates }, FileError>
	> {
		const children = await boundary.children(name);
		if (children.error) {
			if (children.error.name === 'NotFound')
				return Ok({ files: [], candidates: new Map() });
			return children;
		}
		return Ok({
			files: children.data.files,
			candidates: attachmentCandidates(name, children.data.files),
		});
	}

	function validate(
		values: Readonly<Record<string, unknown>>,
		complete: boolean,
	): Result<undefined, TableError> {
		const issues: { field: string; message: string }[] = [];
		for (const [key, value] of Object.entries(values)) {
			const field = parsed.fields.get(key);
			if (field === undefined)
				issues.push({ field: key, message: 'The field is not declared' });
			else if (!field.check(value))
				issues.push({
					field: key,
					message: `The value does not conform to its ${field.kind} field`,
				});
		}
		if (complete)
			for (const key of declared)
				if (!Object.hasOwn(values, key))
					issues.push({ field: key, message: 'The field is required' });
		return issues.length === 0
			? Ok(undefined)
			: TableError.InvalidValues({ issues });
	}

	/** Refuse a destination that exists or collides with a sibling on case-insensitive filesystems. */
	function checkDestination(
		files: readonly string[],
		destination: string,
		ignore: readonly string[],
	): Result<undefined, TableError> {
		const filename = destination.slice(name.length + 1);
		if (files.includes(filename))
			return TableError.Exists({ path: destination });
		const key = collisionKey(destination);
		for (const existing of files) {
			const path = `${name}/${existing}`;
			if (ignore.includes(path)) continue;
			if (collisionKey(path) === key)
				return TableError.Collision({ path: destination, existing: path });
		}
		return Ok(undefined);
	}

	async function publishSource(
		entry: Entry<TFields>,
		source: string,
	): Promise<Result<Entry<TFields>, TableWriteError>> {
		const bytes = encoder.encode(source);
		const version = await captureVersion(bytes);
		const applied = await context.publish([
			{
				kind: 'write',
				path: entry.path,
				bytes,
				version,
				expected: entry.version,
			},
		]);
		if (applied.error) return Err(applied.error);
		const candidates =
			entry.issues?.find((issue) => issue.kind === 'attachment')?.candidates ??
			[];
		return Ok(
			interpret(
				entry.path,
				version,
				source,
				entry.attachment === undefined ? candidates : [entry.attachment],
			),
		);
	}

	/**
	 * The literal stem of a row file directly in this table's directory. A
	 * nested path such as `todos/a/b.md` is not a row. Stems that violate the
	 * naming rules are still rows here, so external files stay editable.
	 */
	function ownsPath(entry: Entry<TFields>): Result<string, FileError> {
		const stem = rowStemOf(name, entry.path);
		if (stem === undefined)
			return FileError.InvalidPath({
				path: entry.path,
				reason: `the entry is not a row of '${name}'`,
			});
		return Ok(stem);
	}

	/**
	 * Refuse an app operation that moves or removes a row with its attachment
	 * unless the current same-stem candidates are exactly the one the entry
	 * owned when captured: no new, missing, renamed, or ambiguous attachment.
	 * Ownership is by path; this check does not compare attachment bytes.
	 */
	function checkOwnership(
		entry: Entry<TFields>,
		stem: string,
		candidates: Candidates,
	): Result<undefined, TableError> {
		const captured = entry.issues?.find((item) => item.kind === 'attachment');
		if (captured?.kind === 'attachment')
			return TableError.AmbiguousAttachment({
				path: entry.path,
				candidates: captured.candidates,
			});
		const current = candidates.get(stem) ?? [];
		const expected = entry.attachment === undefined ? [] : [entry.attachment];
		if (
			current.length !== expected.length ||
			current.some((path) => !expected.includes(path))
		)
			return TableError.AmbiguousAttachment({
				path: entry.path,
				candidates: current,
			});
		return Ok(undefined);
	}

	return {
		name,
		async list() {
			return context.admit(
				async (): Promise<Result<TableListing<TFields>, TableReadError>> => {
					const found = await directory();
					if (found.error) return found;
					const rows = found.data.files.filter((file) =>
						file.endsWith(ROW_EXTENSION),
					);
					const reads = await boundary.readMany(
						rows.map((file) => `${name}/${file}`),
					);
					if (reads.error) return reads;
					const entries: Entry<TFields>[] = [];
					const unreadable: {
						path: string;
						error: TableReadError | TableError;
					}[] = [];
					for (const [path, read] of reads.data) {
						if (read.error) {
							unreadable.push({ path, error: read.error });
							continue;
						}
						const source = decode(read.data.bytes);
						if (source === undefined) {
							unreadable.push({
								path,
								error: TableError.InvalidUtf8({ path }).error,
							});
							continue;
						}
						const stem = path.slice(name.length + 1, -ROW_EXTENSION.length);
						entries.push(
							interpret(
								path,
								read.data.version,
								source,
								found.data.candidates.get(stem) ?? [],
							),
						);
					}
					return Ok({ entries, unreadable });
				},
			);
		},
		async get(stem) {
			return context.admit(
				async (): Promise<
					Result<Entry<TFields> | undefined, TableReadError | TableError>
				> => {
					const path = rowPath(name, stem);
					const problem = pathProblem(path);
					if (problem !== undefined)
						return FileError.InvalidPath({ path, reason: problem });
					// A stem is one literal filename segment, never a nested path.
					if (rowStemOf(name, path) !== stem)
						return TableError.InvalidStem({
							stem,
							reason: 'the stem contains a path separator',
						});
					const read = await boundary.read(path);
					if (read.error) {
						if (read.error.name === 'NotFound') return Ok(undefined);
						return read;
					}
					const source = decode(read.data.bytes);
					if (source === undefined) return TableError.InvalidUtf8({ path });
					const found = await directory();
					if (found.error) return found;
					return Ok(
						interpret(
							path,
							read.data.version,
							source,
							found.data.candidates.get(stem) ?? [],
						),
					);
				},
			);
		},
		async create(input) {
			// Own the caller's bytes before any await; a later mutation of their
			// array must not change what is saved or its version.
			const attachmentBytes =
				input.attachment === undefined
					? undefined
					: new Uint8Array(input.attachment.bytes);
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const stem = input.stem ?? generateStem();
					const problem = stemProblem(stem);
					if (problem !== undefined)
						return TableError.InvalidStem({ stem, reason: problem });
					const values = input.fields as Record<string, unknown>;
					const valid = validate(values, true);
					if (valid.error) return valid;
					if (
						input.attachment &&
						!isAttachmentExtension(input.attachment.extension)
					)
						return TableError.InvalidStem({
							stem: `${stem}.${input.attachment.extension}`,
							reason:
								'the attachment extension must be one ASCII alphanumeric segment other than md',
						});
					const path = rowPath(name, stem);
					const found = await directory();
					if (found.error) return found;
					const destination = checkDestination(found.data.files, path, []);
					if (destination.error) return destination;
					// An existing same-stem file would become this row's attachment.
					const orphan = found.data.candidates.get(stem);
					if (orphan !== undefined && orphan.length > 0)
						return TableError.Exists({ path: orphan[0]! });
					const ordered: Record<string, unknown> = {};
					for (const key of declared) ordered[key] = values[key];
					const composed = composeSource(ordered, input.body ?? '');
					if (composed.error)
						return TableError.UnsupportedSource({
							path,
							reason: composed.error.reason,
						});
					const source = composed.data;
					const bytes = encoder.encode(source);
					const changes: FileChange[] = [];
					let attachment: string | undefined;
					if (input.attachment) {
						attachment = `${name}/${stem}.${input.attachment.extension}`;
						const collision = checkDestination(
							found.data.files,
							attachment,
							[],
						);
						if (collision.error) return collision;
						const bytes = attachmentBytes!;
						changes.push({
							kind: 'write',
							path: attachment,
							bytes,
							version: await captureVersion(bytes),
							expected: 'absent',
						});
					}
					// The row is written last, so it appears only once its attachment exists.
					const version = await captureVersion(bytes);
					changes.push({
						kind: 'write',
						path,
						bytes,
						version,
						expected: 'absent',
					});
					const applied = await context.publish(changes);
					if (applied.error) return Err(applied.error);
					return Ok(
						interpret(
							path,
							version,
							source,
							attachment === undefined ? [] : [attachment],
						),
					);
				},
			);
		},
		async update(entry, change) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					const values = (change.fields ?? {}) as Record<string, unknown>;
					const valid = validate(values, false);
					if (valid.error) return valid;
					const patched = patchSource(entry.source, {
						fields: values,
						body: change.body,
					});
					if (patched.error)
						return TableError.UnsupportedSource({
							path: entry.path,
							reason: patched.error.reason,
						});
					return publishSource(entry, patched.data);
				},
			);
		},
		async writeSource(entry, source) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					return publishSource(entry, source);
				},
			);
		},
		async rename(entry, nextStem) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					const problem = stemProblem(nextStem);
					if (problem !== undefined)
						return TableError.InvalidStem({ stem: nextStem, reason: problem });
					const path = rowPath(name, nextStem);
					if (path === entry.path) return Ok(entry);
					const found = await directory();
					if (found.error) return found;
					const ownership = checkOwnership(
						entry,
						owned.data,
						found.data.candidates,
					);
					if (ownership.error) return ownership;
					const retiring =
						entry.attachment === undefined
							? [entry.path]
							: [entry.path, entry.attachment];
					const destination = checkDestination(
						found.data.files,
						path,
						retiring,
					);
					if (destination.error) return destination;
					const orphan = found.data.candidates.get(nextStem);
					if (orphan !== undefined && orphan.length > 0)
						return TableError.Exists({ path: orphan[0]! });
					// Move the row first: a stale entry refuses before anything moves.
					const changes: FileChange[] = [
						{
							kind: 'move',
							from: entry.path,
							to: path,
							expected: entry.version,
						},
					];
					let attachment: string | undefined;
					if (entry.attachment !== undefined) {
						const extension = entry.attachment.slice(
							entry.attachment.lastIndexOf('.') + 1,
						);
						attachment = `${name}/${nextStem}.${extension}`;
						const collision = checkDestination(
							found.data.files,
							attachment,
							retiring,
						);
						if (collision.error) return collision;
						changes.push({
							kind: 'move',
							from: entry.attachment,
							to: attachment,
							expected: 'any',
						});
					}
					const applied = await context.publish(changes);
					if (applied.error) return Err(applied.error);
					return Ok(
						interpret(
							path,
							entry.version,
							entry.source,
							attachment === undefined ? [] : [attachment],
						),
					);
				},
			);
		},
		async delete(entry) {
			return context.admit(
				async (): Promise<
					Result<{ readonly removed: readonly string[] }, TableWriteError>
				> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					const found = await directory();
					if (found.error) return found;
					const ownership = checkOwnership(
						entry,
						owned.data,
						found.data.candidates,
					);
					if (ownership.error) return ownership;
					const changes: Extract<FileChange, { kind: 'remove' }>[] = [
						{ kind: 'remove', path: entry.path, expected: entry.version },
					];
					if (entry.attachment !== undefined)
						changes.push({
							kind: 'remove',
							path: entry.attachment,
							expected: 'any',
						});
					const applied = await context.publish(changes);
					if (applied.error) return Err(applied.error);
					return Ok({
						removed: changes.map((change) => change.path),
					});
				},
			);
		},
	};
}
