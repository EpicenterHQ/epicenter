/**
 * Root `kv.json` settings for a file folder.
 *
 * A snapshot carries the exact source and version like a table entry. An
 * update merges declared values into the parsed object, preserving unknown
 * keys and key order, and conditionally replaces the captured file. JSON has
 * no comments; an update rewrites its whitespace as two-space indentation.
 */

import type { Static } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ParsedTable } from '../data/definition/compile.js';
import type { FieldMap } from '../data/definition/declaration.js';
import { type FileError, TableError, type TableWriteError } from './errors.js';
import type { TableContext } from './table.js';
import { captureVersion, type FileVersion } from './version.js';

export const KV_PATH = 'kv.json';

export type KvValues<TKv extends FieldMap> = {
	-readonly [K in keyof TKv]: Static<TKv[K]>;
};

export type KvIssue = {
	readonly field: string | undefined;
	readonly message: string;
};

export type KvSnapshot<TValues> = {
	readonly path: typeof KV_PATH;
	/** Undefined when `kv.json` does not exist. */
	readonly version: FileVersion | undefined;
	readonly source: string | undefined;
	/** Declared values that validated independently. */
	readonly values: Readonly<Partial<TValues>>;
	readonly issues: readonly KvIssue[] | undefined;
};

export type FileKv<TValues> = {
	get(): Promise<Result<KvSnapshot<TValues>, FileError | TableError>>;
	update(
		snapshot: KvSnapshot<TValues>,
		values: Partial<TValues>,
	): Promise<Result<KvSnapshot<TValues>, TableWriteError>>;
	writeSource(
		snapshot: KvSnapshot<TValues>,
		source: string,
	): Promise<Result<KvSnapshot<TValues>, TableWriteError>>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function createFileKv<TValues>(
	parsed: ParsedTable,
	context: TableContext,
): FileKv<TValues> {
	const { boundary } = context;

	function interpret(
		source: string | undefined,
		version: FileVersion | undefined,
	): KvSnapshot<TValues> {
		const issues: KvIssue[] = [];
		const values: Record<string, unknown> = {};
		let object: Record<string, unknown> = {};
		if (source !== undefined) {
			try {
				const parsedJson: unknown = JSON.parse(source.replace(/^﻿/, ''));
				if (
					typeof parsedJson === 'object' &&
					parsedJson !== null &&
					!Array.isArray(parsedJson)
				)
					object = parsedJson as Record<string, unknown>;
				else
					issues.push({
						field: undefined,
						message: 'kv.json is not a JSON object',
					});
			} catch (cause) {
				issues.push({
					field: undefined,
					message: `kv.json is not valid JSON: ${String(cause)}`,
				});
			}
		}
		for (const [key, field] of parsed.fields) {
			if (!Object.hasOwn(object, key)) continue;
			if (field.check(object[key])) values[key] = object[key];
			else
				issues.push({
					field: key,
					message: `The value does not conform to its ${field.kind} field`,
				});
		}
		return Object.freeze({
			path: KV_PATH,
			version,
			source,
			values: Object.freeze(values) as Partial<TValues>,
			issues: issues.length === 0 ? undefined : Object.freeze(issues),
		});
	}

	async function publish(
		snapshot: KvSnapshot<TValues>,
		source: string,
	): Promise<Result<KvSnapshot<TValues>, TableWriteError>> {
		const bytes = encoder.encode(source);
		const version = await captureVersion(bytes);
		const applied = await boundary.apply([
			{
				kind: 'write',
				path: KV_PATH,
				bytes,
				version,
				expected: snapshot.version ?? 'absent',
			},
		]);
		if (applied.error) return Err(applied.error);
		context.saved();
		return Ok(interpret(source, version));
	}

	return {
		async get() {
			return context.admit(
				async (): Promise<
					Result<KvSnapshot<TValues>, FileError | TableError>
				> => {
					const read = await boundary.read(KV_PATH);
					if (read.error) {
						if (read.error.name === 'NotFound')
							return Ok(interpret(undefined, undefined));
						return read;
					}
					let source: string;
					try {
						source = utf8.decode(read.data.bytes);
					} catch {
						return TableError.InvalidUtf8({ path: KV_PATH });
					}
					return Ok(interpret(source, read.data.version));
				},
			);
		},
		async update(snapshot, values) {
			return context.admit(
				async (): Promise<Result<KvSnapshot<TValues>, TableWriteError>> => {
					const issues: { field: string; message: string }[] = [];
					for (const [key, value] of Object.entries(
						values as Record<string, unknown>,
					)) {
						const field = parsed.fields.get(key);
						if (field === undefined)
							issues.push({ field: key, message: 'The key is not declared' });
						else if (!field.check(value))
							issues.push({
								field: key,
								message: `The value does not conform to its ${field.kind} field`,
							});
					}
					if (issues.length > 0) return TableError.InvalidValues({ issues });
					let object: Record<string, unknown> = {};
					if (snapshot.source !== undefined) {
						try {
							const parsedJson: unknown = JSON.parse(
								snapshot.source.replace(/^﻿/, ''),
							);
							if (
								typeof parsedJson !== 'object' ||
								parsedJson === null ||
								Array.isArray(parsedJson)
							)
								return TableError.UnsupportedSource({
									path: KV_PATH,
									reason: 'kv.json is not a JSON object',
								});
							object = parsedJson as Record<string, unknown>;
						} catch {
							return TableError.UnsupportedSource({
								path: KV_PATH,
								reason:
									'kv.json is not valid JSON; edit the complete source instead',
							});
						}
					}
					const bom = snapshot.source?.startsWith('﻿') ? '﻿' : '';
					const next = `${bom}${JSON.stringify({ ...object, ...values }, null, 2)}\n`;
					return publish(snapshot, next);
				},
			);
		},
		async writeSource(snapshot, source) {
			return context.admit(() => publish(snapshot, source));
		},
	};
}
