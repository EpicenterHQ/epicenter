/**
 * The root `kv.json`: settings as independent keys (ADR-0520).
 *
 * A setting is an intent, not a document. `set('theme', 'dark')` means "the
 * theme is dark", whatever the file held a moment ago: a set changes one key
 * of the file as read at the set and saves it with `saveKv`, which merges
 * by key with whatever another writer saved since (ADR-0551). Two windows
 * setting different keys both stick, and no one is asked to resolve
 * anything. A value that must change together with another
 * belongs in one key: one top-level key is one fact.
 *
 * Reading is per key. Every declared key whose stored value validates is in
 * `values`; a stored value that does not conform is left out and reported
 * as an issue at its line, so one broken setting falls back to the app's
 * default without hiding the others. Only text that is not a file a folder
 * can hold (not one strict JSON object, or a key that appears twice at any
 * depth) is
 * `InvalidKv`, repaired as text with `folder.write(path, error.text, text)`.
 *
 * `kv.json` text belongs to `kv-merge.ts`: a set writes exactly the format a
 * Git merge writes, and keeps every key it does not change as its raw text.
 */

import {
	check,
	type FieldMap,
	isJsonValue,
	JSON_BUDGET,
} from '@epicenter/definition';
import { type Node, parseTree } from 'jsonc-parser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { hashBytes } from './capture.js';
import {
	FileError,
	type KvReadError,
	type KvWriteError,
	TableError,
} from './errors.js';
import { formatKvMembers, readKvMembers } from './kv-merge.js';
import { merge, type Overridden } from './merge-file.js';
import type { Issue, Issues } from './row-text.js';
import { confirmedPut, logOverwrite, WRITE_ATTEMPTS } from './save-file.js';

export const KV_PATH = 'kv.json';

/**
 * One read of `kv.json`: which bytes were read, every declared value that
 * validated, and an issue for each stored value that did not. A key the
 * file lacks is not an issue, and nothing supplies a default: the app
 * spreads its own defaults under `values`.
 */
export type KvReading<TValues> = {
	readonly path: typeof KV_PATH;
	readonly sha256: string;
	readonly values: Partial<TValues>;
	readonly issues: readonly Issue[];
};

export type FileKv<TValues> = {
	/** `undefined` only when `kv.json` does not exist. */
	get(): Promise<Result<KvReading<TValues> | undefined, KvReadError>>;
	/**
	 * Set one key, or remove it with `undefined` so the app's default applies.
	 * A value that is not declared, does not conform, or cannot be stored is
	 * `InvalidValues` before anything is read. The file is created when it is
	 * missing. Sets from one handle apply in the order they were called; a
	 * set that meets another writer's save merges with it by key, and one
	 * that keeps meeting them is `KeptChanging`. Returns the reading of what
	 * it wrote.
	 */
	set<TKey extends keyof TValues & string>(
		key: TKey,
		value: TValues[TKey] | undefined,
	): Promise<Result<KvReading<TValues>, KvWriteError>>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function decode(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

/** The 1-based line of a UTF-16 index in text. */
function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 0x0a) line++;
	return line;
}

const STRICT_JSON = {
	disallowComments: true,
	allowTrailingComma: false,
	allowEmptyContent: false,
};

/** What a JSON syntax error means to a person repairing the text. */
const SYNTAX: Record<number, string> = {
	1: 'an unexpected character',
	2: 'a number that is not written as JSON',
	3: 'a key is expected',
	4: 'a value is expected',
	5: 'a colon is expected',
	6: 'a comma is expected',
	7: 'a closing brace is expected',
	8: 'a closing bracket is expected',
	9: 'nothing more is expected after the object',
	10: 'comments are not allowed',
	11: 'a comment is not closed',
	12: 'a string is not closed',
	13: 'a number is not finished',
	14: 'a Unicode escape is not valid',
	15: 'an escape is not valid',
	16: 'a control character is not allowed in a string',
};

/**
 * Why text that `readKvMembers` refused is not a file a folder can hold, at
 * its line when there is one. The member reader alone decides validity;
 * this only explains its refusal.
 */
export function kvRefusal(text: string): Issues {
	const offset = text.startsWith('\uFEFF') ? 1 : 0;
	const errors: Parameters<typeof parseTree>[1] = [];
	let root: Node | undefined;
	try {
		root = parseTree(text.slice(offset), errors, STRICT_JSON);
	} catch (cause) {
		// Deep nesting the member reader refused must not overflow the stack here.
		if (!(cause instanceof RangeError)) throw cause;
		return [{ message: 'kv.json nests deeper than 64 levels' }];
	}
	const [syntax] = errors;
	if (syntax !== undefined)
		return [
			{
				message: `kv.json is not valid JSON: ${SYNTAX[syntax.error] ?? 'it does not parse'}`,
				line: lineAt(text, offset + syntax.offset),
			},
		];
	if (root?.type !== 'object')
		return [{ message: 'kv.json is not a JSON object', line: 1 }];
	const duplicate = duplicateKey(root);
	if (duplicate !== undefined)
		return [
			{
				message: `The key ${JSON.stringify(duplicate.key)} appears twice`,
				line: lineAt(text, offset + duplicate.offset),
				field: duplicate.field,
			},
		];
	return [
		{
			message:
				'kv.json holds text a folder cannot store: an unpaired surrogate, or nesting deeper than 64 levels',
		},
	];
}

/** The first key that appears twice in one object, at any depth, and its root key. */
function duplicateKey(
	node: Node,
	field?: string,
): { key: string; offset: number; field: string } | undefined {
	if (node.type === 'array')
		for (const child of node.children ?? []) {
			const found = duplicateKey(child, field);
			if (found !== undefined) return found;
		}
	if (node.type !== 'object') return undefined;
	const seen = new Set<string>();
	for (const property of node.children ?? []) {
		const [name, value] = property.children ?? [];
		const key: unknown = name?.value;
		if (typeof key !== 'string') continue;
		if (seen.has(key))
			return { key, offset: property.offset, field: field ?? key };
		seen.add(key);
		if (value === undefined) continue;
		const found = duplicateKey(value, field ?? key);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The line of each root key, for issues about its value. */
function keyLines(text: string): Map<string, number> {
	const offset = text.startsWith('﻿') ? 1 : 0;
	const root: Node | undefined = parseTree(text.slice(offset), [], STRICT_JSON);
	const lines = new Map<string, number>();
	for (const property of root?.children ?? []) {
		const key: unknown = property.children?.[0]?.value;
		if (typeof key === 'string')
			lines.set(key, lineAt(text, offset + property.offset));
	}
	return lines;
}

/**
 * Why a JSON value cannot be a setting, whichever way it travels: over the
 * nesting or width budget, or holding an integer outside the safe range. A
 * read reports it as an issue and a set refuses it, so a value read from the
 * file can always be set back.
 */
function storedProblem(key: string, value: unknown): string | undefined {
	if (!isJsonValue(value))
		return `${key} is over the kv.json budget: nesting deeper than ${JSON_BUDGET.depth} levels, or an object with more than ${JSON_BUDGET.propertiesPerObject} keys`;
	if (hasUnsafeInteger(value))
		return `${key} holds an integer outside the safe range`;
	return undefined;
}

/** Whether a parsed JSON value holds an integer outside the safe range. */
function hasUnsafeInteger(value: unknown): boolean {
	if (typeof value === 'number')
		return Number.isInteger(value) && !Number.isSafeInteger(value);
	if (typeof value !== 'object' || value === null) return false;
	return Object.values(value).some(hasUnsafeInteger);
}

/** The JSON text of a supplied value, or `undefined` when JSON would lose part of it. */
function serialize(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, function (_key, part: unknown) {
			if (
				typeof part === 'function' ||
				typeof part === 'symbol' ||
				typeof part === 'bigint' ||
				(typeof part === 'number' && !Number.isFinite(part)) ||
				// An array has no absent element; an object's absent key is dropped.
				(part === undefined && Array.isArray(this))
			)
				throw new TypeError('not a JSON value');
			return part;
		});
	} catch {
		return undefined;
	}
}

/** Every declared value of read members that validated, and an issue for each that did not. */
function valuesOf<TValues>(
	schemas: FieldMap,
	text: string,
	members: ReadonlyMap<string, string>,
): { values: Partial<TValues>; issues: readonly Issue[] } {
	const lines = keyLines(text);
	const values: Record<string, unknown> = {};
	const issues: Issue[] = [];
	for (const key of Object.keys(schemas)) {
		const raw = members.get(key);
		if (raw === undefined) continue;
		const value: unknown = JSON.parse(raw);
		const line = lines.get(key);
		const problem = storedProblem(key, value);
		const found =
			problem !== undefined
				? [{ field: key, message: problem }]
				: check(schemas, { [key]: value }, 'patch').issues;
		if (found.length === 0) values[key] = value;
		for (const { message } of found)
			issues.push(
				line === undefined
					? { message, field: key }
					: { message, line, field: key },
			);
	}
	return { values: values as Partial<TValues>, issues: Object.freeze(issues) };
}

/**
 * One key's change as raw JSON text, or `null` to remove it, refused as
 * `kv.set` refuses it: undeclared, with no exact JSON form, over the
 * budget, or not conforming. Prepared synchronously, so a caller that
 * changes its value afterward changes nothing that is saved. Sync settles a
 * competing key with the same rules.
 */
export function settingText(
	schemas: FieldMap,
	key: string,
	value: unknown,
): Result<string | null, Extract<TableError, { name: 'InvalidValues' }>> {
	const refuse = (message: string) =>
		TableError.InvalidValues({ issues: [{ message, field: key }] });
	if (!Object.hasOwn(schemas, key)) return refuse(`${key} is not declared`);
	if (value === undefined) return Ok(null);
	const json = serialize(value);
	if (json === undefined)
		return refuse(`${key} cannot be saved: the value has no exact JSON form`);
	const copy: unknown = JSON.parse(json);
	const problem = storedProblem(key, copy);
	if (problem !== undefined) return refuse(problem);
	const issues = check(schemas, { [key]: copy }, 'patch').issues;
	if (issues.length > 0) return TableError.InvalidValues({ issues });
	return Ok(json);
}

/** The `kv.json` handle. `schemas` are the prepared definition's `kv` fields. */
/**
 * Save `edit` over `base`, the settings as read at the set: it lands only
 * over the bytes read, and when another writer saved first it merges by key
 * with their file, at most `WRITE_ATTEMPTS` times, then `KeptChanging`. A
 * merge that does not read as settings is refused, never written. `kv.json`
 * keeps this loop of its own until settings are a table (ADR-0576).
 */
async function saveKv(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	schemas: FieldMap,
	base: { readonly text: string; readonly sha256: string },
	edit: Uint8Array,
): Promise<
	Result<{ readonly bytes: Uint8Array; readonly sha256: string }, KvWriteError>
> {
	const kind = { kind: 'kv', schemas } as const;
	const baseBytes = encoder.encode(base.text);
	let expected = base.sha256;
	let attempt = edit;
	let overwrote: readonly Overridden[] = [];
	for (let merges = 0; ; merges++) {
		const sha256 = await hashBytes(attempt);
		const { data: put, error: putError } = await confirmedPut(
			storage,
			KV_PATH,
			attempt,
			expected,
			sha256,
		);
		if (putError !== null) return Err(putError);
		if (put === 'landed') {
			logOverwrite(KV_PATH, overwrote);
			return Ok({ bytes: attempt, sha256 });
		}
		const { data: current, error: readError } = await storage.read(KV_PATH);
		if (merges === WRITE_ATTEMPTS)
			return TableError.KeptChanging({
				path: KV_PATH,
				attempts: WRITE_ATTEMPTS,
			});
		if (readError !== null) return Err(readError);
		const merged = await merge(kind, {
			base: baseBytes,
			ours: edit,
			theirs: current.bytes,
		});
		// The edit is present, so the merge never settles to no file.
		const bytes =
			typeof merged.content === 'string'
				? encoder.encode(merged.content)
				: (merged.content as Uint8Array);
		const text = decode(bytes) ?? '';
		if (readKvMembers(text) === undefined) {
			const theirs = decode(current.bytes) ?? '';
			return readKvMembers(theirs) === undefined
				? TableError.InvalidKv({
						path: KV_PATH,
						sha256: current.sha256,
						text: theirs,
						issues: kvRefusal(theirs),
					})
				: TableError.InvalidValues({ issues: kvRefusal(text) });
		}
		overwrote = merged.overridden;
		attempt = bytes;
		expected = current.sha256;
	}
}

export function createKv<TValues>(
	{ storage }: { storage: FolderStorage },
	schemas: FieldMap,
): FileKv<TValues> {
	/** The reading of text whose members were read. */
	function readingOf(
		text: string,
		sha256: string,
		members: ReadonlyMap<string, string>,
	): KvReading<TValues> {
		return Object.freeze({
			path: KV_PATH,
			sha256,
			...valuesOf<TValues>(schemas, text, members),
		});
	}

	/** Read `kv.json` as members, or say why it cannot be. */
	async function readFile(): Promise<
		Result<
			| { text: string; sha256: string; members: ReadonlyMap<string, string> }
			| undefined,
			KvReadError
		>
	> {
		const { data: read, error: readError } = await storage.read(KV_PATH);
		if (readError !== null)
			return readError.name === 'NotFound' ? Ok(undefined) : Err(readError);
		const text = decode(read.bytes);
		if (text === undefined)
			return TableError.InvalidUtf8({ path: KV_PATH, sha256: read.sha256 });
		const members = readKvMembers(text);
		if (members === undefined)
			return TableError.InvalidKv({
				path: KV_PATH,
				sha256: read.sha256,
				text,
				issues: kvRefusal(text),
			});
		return Ok({ text, sha256: read.sha256, members });
	}

	/**
	 * Apply changes to the file as read now: create it when it is missing,
	 * reading once more when that create does not land, and otherwise
	 * save over the read, merging by key with any save that landed since.
	 */
	async function apply(
		changes: ReadonlyMap<string, string | null>,
	): Promise<Result<KvReading<TValues>, KvWriteError>> {
		for (let reads = 0; ; reads++) {
			const { data: current, error: readError } = await readFile();
			if (readError !== null) return Err(readError);
			const members = new Map(current?.members);
			for (const [key, raw] of changes)
				if (raw === null) members.delete(key);
				else members.set(key, raw);
			const bytes = encoder.encode(formatKvMembers(members));
			if (current === undefined) {
				const sha256 = await hashBytes(bytes);
				const { data: put, error } = await confirmedPut(
					storage,
					KV_PATH,
					bytes,
					null,
					sha256,
				);
				if (put === 'landed') return written(bytes, sha256);
				// Another writer created it first, or the reply was lost: read
				// again and save over what is there.
				if (reads === 0 && (put === 'stale' || error?.name === 'Unconfirmed'))
					continue;
				return error === null
					? TableError.KeptChanging({ path: KV_PATH, attempts: 2 })
					: Err(error);
			}
			const { data: saved, error } = await saveKv(
				storage,
				schemas,
				current,
				bytes,
			);
			if (error !== null) return Err(error);
			return written(saved.bytes, saved.sha256);
		}
	}

	/** The reading of bytes a set wrote, which read as settings. */
	function written(
		bytes: Uint8Array,
		sha256: string,
	): Result<KvReading<TValues>, KvWriteError> {
		const text = utf8.decode(bytes);
		const members = readKvMembers(text);
		if (members === undefined)
			throw new Error('A saved kv.json does not read as settings');
		return Ok(readingOf(text, sha256, members));
	}

	/** The batch waiting behind the running one: the latest change per key. */
	let pending:
		| {
				changes: Map<string, string | null>;
				done: PromiseWithResolvers<Result<KvReading<TValues>, KvWriteError>>;
		  }
		| undefined;
	let running = false;

	/** Apply batches one at a time, in the order their sets were called. */
	async function drain() {
		running = true;
		try {
			while (pending !== undefined) {
				const batch = pending;
				pending = undefined;
				let result: Result<KvReading<TValues>, KvWriteError>;
				try {
					result = await apply(batch.changes);
				} catch (cause) {
					// A storage defect settles this batch; later sets still run.
					result = FileError.Io({ path: KV_PATH, operation: 'set', cause });
				}
				batch.done.resolve(result);
			}
		} finally {
			running = false;
		}
	}

	return {
		async get() {
			const { data: current, error } = await readFile();
			if (error !== null) return Err(error);
			if (current === undefined) return Ok(undefined);
			return Ok(readingOf(current.text, current.sha256, current.members));
		},
		set(key, value) {
			const { data: change, error } = settingText(schemas, key, value);
			if (error !== null) return Promise.resolve(Err(error));
			pending ??= { changes: new Map(), done: Promise.withResolvers() };
			pending.changes.set(key, change as string | null);
			const { promise } = pending.done;
			if (!running) void drain();
			return promise;
		},
	};
}
