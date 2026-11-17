import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { folder, isLocalPath } from './context.ts';
import type { AnyData } from './data.ts';
import type { Problem } from './errors.ts';
import { refKeyOf } from './field.ts';
import { idProblem } from './id.ts';
import type { AnyRecord } from './markdown-records.ts';

/** Check declared data through its handles, including filenames and exact reference ids. */
export async function checkData(data: AnyData) {
	const checked: Record<
		string,
		{
			path: string;
			single: boolean;
			files: number;
			withProblems: number;
			kinds: { kind: string; count: number }[];
			records: { path: string; problems: Problem[] }[];
		}
	> = {};
	const ids = new Map<string, Set<string>>();
	const reads: { key: string; record: AnyRecord }[] = [];
	const affected = new Map<string, Map<string, Set<string>>>();
	function report(key: string, paths: string[], problems: Problem[]) {
		if (!problems.length) return;
		const each = checked[key];
		if (!each) return;
		const path = paths.map((path) => path.slice('data/'.length)).join(' and ');
		const existing = each.records.find((record) => record.path === path);
		if (existing) existing.problems.push(...problems);
		else each.records.push({ path, problems });
		for (const path of paths) {
			const kinds = affected.get(key)?.get(path) ?? new Set<string>();
			for (const { kind } of problems) kinds.add(kind);
			affected.get(key)?.set(path, kinds);
		}
	}
	for (const [key, handle] of Object.entries(data)) {
		const single = !('list' in handle);
		const local = isLocalPath(key);
		const base = `data/${key}`;
		checked[key] = {
			path: single ? base : `${base}/`,
			single,
			files: 0,
			withProblems: 0,
			kinds: [],
			records: [],
		};
		affected.set(key, new Map());
		const each = checked[key];
		if ('list' in handle) {
			const names = new Map<string, string[]>();
			for (const path of (await folder.list(base)).sort()) {
				if (!path.startsWith(`${base}/`) || !path.endsWith('.md')) continue;
				const name = path.slice(base.length + 1);
				if (name.includes('/') || name.startsWith('.')) continue;
				if (!local && isLocalPath(name)) continue;
				each.files++;
				const problem = idProblem(name.slice(0, -3), local);
				if (problem) report(key, [path], [{ line: problem, kind: problem }]);
				// Lowercasing NFC is close enough to how a Mac folds names; a pair it misses is rare.
				const folded = name.normalize('NFC').toLowerCase();
				const aliases = names.get(folded) ?? [];
				aliases.push(path);
				names.set(folded, aliases);
			}
			for (const paths of names.values()) {
				if (paths.length < 2) continue;
				const problem = 'are one file on a disk that ignores case';
				report(key, paths, [{ line: problem, kind: problem }]);
			}
			const listed = await handle.list();
			ids.set(key, new Set());
			for (const result of listed) {
				const path = result.error ? result.error.path : result.data.path;
				ids.get(key)?.add(path.slice(base.length + 1, -3));
				if (result.error) {
					report(key, [path], result.error.problems);
					if (result.error.record)
						reads.push({ key, record: result.error.record });
				} else reads.push({ key, record: result.data });
			}
		} else {
			const result = await handle.get();
			if (result.error) {
				each.files = 1;
				report(key, [base], result.error.problems);
				if (result.error.record)
					reads.push({ key, record: result.error.record });
			} else if (result.data) {
				each.files = 1;
				reads.push({ key, record: result.data });
			}
		}
	}
	function references(
		schema: TSchema,
		value: unknown,
		field: string,
		local: boolean,
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
					line: local
						? kind
						: `${field} ${JSON.stringify(value)} names no file in ${target}/`,
					kind,
				},
			];
		}
		if (Array.isArray(value) && items)
			return value.flatMap((item, index) =>
				references(items, item, `${field}[${index}]`, local),
			);
		if (typeof value === 'object' && value !== null && properties)
			return Object.entries(properties).flatMap(([key, child]) =>
				references(
					child,
					(value as Record<string, unknown>)[key],
					`${field}.${key}`,
					local,
				),
			);
		if (anyOf) {
			const choices = anyOf
				.filter((child) => Value.Check(child, value))
				.map((child) => references(child, value, field, local));
			return (
				choices.find((problems) => problems.length === 0) ?? choices[0] ?? []
			);
		}
		return [];
	}
	for (const { key, record } of reads) {
		for (const [field, schema] of Object.entries(data[key]?.fields ?? {}))
			report(
				key,
				[record.path],
				references(schema, record[field], field, isLocalPath(key)),
			);
	}
	for (const [key, each] of Object.entries(checked)) {
		each.withProblems = affected.get(key)?.size ?? 0;
		const counts = new Map<string, number>();
		for (const kinds of affected.get(key)?.values() ?? [])
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
	return checked;
}
