import { merge, type Overridden } from '../../shared/merge.js';
import {
	type GitObject,
	hashObject,
	readTree,
	type TreeEntry,
	writeTree,
} from './objects.js';

/** Merge raw tree entries while applying content merge only at file leaves. */
export async function mergeTrees({
	base,
	current,
	change,
	read,
}: {
	base: string | null;
	current: string | null;
	change: string | null;
	read: (oid: string) => Promise<GitObject>;
}) {
	const objects = new Map<string, GitObject>();
	const overridden: { path: string; unit: Overridden }[] = [];
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	async function load(oid: string, type: GitObject['type']) {
		const object = objects.get(oid) ?? (await read(oid));
		if (object.type !== type)
			throw new Error(`Expected ${type} object ${oid}, found ${object.type}`);
		return object.bytes;
	}
	async function add(type: GitObject['type'], bytes: Uint8Array) {
		const object = { type, bytes };
		const oid = await hashObject(object);
		objects.set(oid, object);
		return oid;
	}
	const isTree = (entry: TreeEntry | undefined) =>
		entry?.mode === '40000' || entry?.mode === '040000';
	const equal = (a: TreeEntry | undefined, b: TreeEntry | undefined) =>
		a === undefined
			? b === undefined
			: b !== undefined && a.oid === b.oid && a.mode === b.mode;
	const keyOf = (name: Uint8Array) =>
		Array.from(name, (byte) => byte.toString(16).padStart(2, '0')).join('');
	function nameOf(name: Uint8Array) {
		try {
			return decoder.decode(name);
		} catch {
			return `raw:${keyOf(name)}`;
		}
	}
	async function tree(
		b: string | null,
		c: string | null,
		n: string | null,
		prefix: string,
	): Promise<string | null> {
		if (c === n || n === b) return c;
		if (c === b) return n;
		const maps = await Promise.all(
			[b, c, n].map(
				async (oid) =>
					new Map(
						(oid === null ? [] : readTree(await load(oid, 'tree'))).map(
							(entry) => [keyOf(entry.name), entry],
						),
					),
			),
		);
		const [bm, cm, nm] = maps as [
			Map<string, TreeEntry>,
			Map<string, TreeEntry>,
			Map<string, TreeEntry>,
		];
		const entries: TreeEntry[] = [];
		for (const key of new Set([...bm.keys(), ...cm.keys(), ...nm.keys()])) {
			const be = bm.get(key),
				ce = cm.get(key),
				ne = nm.get(key);
			const named = ne ?? ce ?? be!;
			const path = `${prefix}${nameOf(named.name)}`;
			let result: TreeEntry | undefined;
			if (equal(ce, ne) || equal(ne, be)) result = ce;
			else if (equal(ce, be)) result = ne;
			else if (
				[be, ce, ne].every((entry) => entry === undefined || isTree(entry))
			) {
				const oid = await tree(
					be?.oid ?? null,
					ce?.oid ?? null,
					ne?.oid ?? null,
					`${path}/`,
				);
				if (oid !== null) result = { ...named, oid };
			} else if (
				ce === undefined ||
				ne === undefined ||
				[ce, ne].some(isTree) ||
				ce.mode === '160000' ||
				ne.mode === '160000'
			) {
				result = ne ?? ce;
				overridden.push({ path, unit: { kind: 'file' } });
			} else {
				const merged = await merge(path, {
					base:
						be === undefined || isTree(be) || be.mode === '160000'
							? null
							: await load(be.oid, 'blob'),
					current: await load(ce.oid, 'blob'),
					change: await load(ne.oid, 'blob'),
				});
				for (const unit of merged.overridden) overridden.push({ path, unit });
				if (merged.content !== null) {
					const bytes =
						typeof merged.content === 'string'
							? new TextEncoder().encode(merged.content)
							: merged.content;
					result = {
						...ne,
						oid: await add('blob', bytes),
						mode: be?.mode === ne.mode ? ce.mode : ne.mode,
					};
				}
			}
			if (result !== undefined) entries.push(result);
		}
		return entries.length === 0 && prefix !== ''
			? null
			: add('tree', writeTree(entries));
	}
	const root = await tree(base, current, change, '');
	return { tree: root, objects, overridden };
}
