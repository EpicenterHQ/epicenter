import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { AnyData } from './data.ts';
import type { Problem } from './errors.ts';
import { refKeyOf } from './field.ts';
import { filesIn } from './folder.ts';
import { idProblem } from './id.ts';
import type { AnyRecord } from './markdown-records.ts';

/** One data key as `checkData` found it. */
export type CheckedKey = {
	/** The key's folder, ending in `/`. */
	path: string;
	/** How many files it matched. */
	files: number;
	/** How many of them have problems. */
	withProblems: number;
	/** Each kind of problem and how many files have it, most frequent first. */
	kinds: { kind: string; count: number }[];
	/** Each file with problems, by its path under `data/`, with its problem lines. */
	records: { path: string; problems: string[] }[];
};

/**
 * Each file directly under `data/`, which is in no key's folder, so nothing
 * reads it: one problem line each, by its path under the app's folder. A
 * folder there that is not a key is the app's own and is not reported; a
 * name starting with `.` is skipped.
 */
export async function strayData(root: string): Promise<string[]> {
	return (await filesIn(root, 'data'))
		.filter((name) => !name.startsWith('.'))
		.sort()
		.map(
			(name) =>
				`data/${name} is in no data key's folder, so nothing reads it; a record belongs at data/<key>/<id>.md`,
		);
}

/**
 * Check declared data through its handles, including filenames and exact
 * reference ids. `root` is the app's folder on disk, the one `data` was
 * defined with. Each key's report counts its files and the kinds of problem
 * among them, and lists each file with problems by its path under `data/`
 * and its problem lines.
 */
export async function checkData(
	root: string,
	data: AnyData,
): Promise<Record<string, CheckedKey>> {
	/** A key's report while it is found, with its problems whole and the kinds each file has. */
	type Finding = Omit<CheckedKey, 'records'> & {
		records: { path: string; problems: Problem[] }[];
		affected: Map<string, Set<string>>;
	};
	const checked: Record<string, Finding> = {};
	const ids = new Map<string, Set<string>>();
	const reads: {
		each: Finding;
		fields: AnyData[string]['fields'];
		record: AnyRecord;
	}[] = [];
	function report(each: Finding, paths: string[], problems: Problem[]) {
		if (!problems.length) return;
		const path = paths.map((path) => path.slice('data/'.length)).join(' and ');
		const existing = each.records.find((record) => record.path === path);
		if (existing) existing.problems.push(...problems);
		else each.records.push({ path, problems });
		for (const path of paths) {
			const kinds = each.affected.get(path) ?? new Set<string>();
			for (const { kind } of problems) kinds.add(kind);
			each.affected.set(path, kinds);
		}
	}
	for (const [key, handle] of Object.entries(data)) {
		const base = `data/${key}`;
		const each: Finding = {
			path: `${base}/`,
			files: 0,
			withProblems: 0,
			kinds: [],
			records: [],
			affected: new Map(),
		};
		checked[key] = each;
		const keyIds = new Set<string>();
		ids.set(key, keyIds);
		const names = new Map<string, string[]>();
		for (const name of await filesIn(root, base)) {
			if (!name.endsWith('.md') || name.startsWith('.')) continue;
			const path = `${base}/${name}`;
			each.files++;
			const problem = idProblem(name.slice(0, -3));
			if (problem) report(each, [path], [{ line: problem, kind: problem }]);
			// Lowercasing NFC is close enough to how a Mac folds names; a pair it misses is rare.
			const folded = name.normalize('NFC').toLowerCase();
			const aliases = names.get(folded) ?? [];
			aliases.push(path);
			names.set(folded, aliases);
		}
		for (const paths of names.values()) {
			if (paths.length < 2) continue;
			const problem = 'are one file on a disk that ignores case';
			report(each, paths, [{ line: problem, kind: problem }]);
		}
		for (const result of await handle.list()) {
			const { path, id } = result.error ?? result.data;
			keyIds.add(id);
			if (result.error) report(each, [path], result.error.problems);
			const record = result.error ? result.error.record : result.data;
			if (record) reads.push({ each, fields: handle.fields, record });
		}
	}
	function references(
		schema: TSchema,
		value: unknown,
		field: string,
	): Problem[] {
		const { items, properties, anyOf } = schema as TSchema & {
			items?: TSchema;
			properties?: Record<string, TSchema>;
			anyOf?: TSchema[];
		};
		const target = refKeyOf(schema);
		if (target !== undefined && typeof value === 'string') {
			if (ids.get(target)?.has(value)) return [];
			const kind = `${field} names no file in ${target}/`;
			return [
				{
					line: `${field} ${JSON.stringify(value)} names no file in ${target}/`,
					kind,
				},
			];
		}
		if (Array.isArray(value) && items)
			return value.flatMap((item, index) =>
				references(items, item, `${field}[${index}]`),
			);
		if (typeof value === 'object' && value !== null && properties)
			return Object.entries(properties).flatMap(([key, child]) =>
				references(
					child,
					(value as Record<string, unknown>)[key],
					`${field}.${key}`,
				),
			);
		if (anyOf) {
			const choices = anyOf
				.filter((child) => Value.Check(child, value))
				.map((child) => references(child, value, field));
			return (
				choices.find((problems) => problems.length === 0) ?? choices[0] ?? []
			);
		}
		return [];
	}
	for (const { each, fields, record } of reads) {
		for (const [field, schema] of Object.entries(fields))
			report(each, [record.path], references(schema, record[field], field));
	}
	for (const each of Object.values(checked)) {
		each.withProblems = each.affected.size;
		const counts = new Map<string, number>();
		for (const kinds of each.affected.values())
			for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
		each.kinds = [...counts]
			.map(([kind, count]) => ({ kind, count }))
			.sort(
				(a, b) =>
					b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
			);
		each.records.sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		);
	}
	return Object.fromEntries(
		Object.entries(checked).map(([key, { affected: _, ...each }]) => [
			key,
			{
				...each,
				records: each.records.map(({ path, problems }) => ({
					path,
					problems: problems.map(({ line }) => line),
				})),
			},
		]),
	);
}
