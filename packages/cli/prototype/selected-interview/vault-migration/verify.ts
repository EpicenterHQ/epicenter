#!/usr/bin/env bun
/**
 * Proof for migrate.ts on disposable copies.
 *
 *   bun verify.ts <original-copy> <migrated-copy>
 *
 * Checks body bytes, readability by the app's readMarkdown, key order,
 * untouched hand-conversion files, nested files, and compares each value
 * with Bun.YAML's reading of the original to list where they differ.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMarkdown } from '/Users/braden/.claude/worktrees/epicenter-define-data/packages/app/src/front-matter.ts';
import { convertFrontMatter } from './migrate.ts';

const [orig, mig] = process.argv.slice(2) as [string, string];
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Byte offset just after the closing `---` line, found on the raw bytes. */
function bodyStart(b: Buffer): number {
	let at = 0;
	let first = true;
	while (at < b.length) {
		let end = b.indexOf(0x0a, at);
		end = end < 0 ? b.length : end + 1;
		const line = b.subarray(at, end).toString('latin1').replace(/\r?\n$/, '');
		if (first) {
			if (line !== '---') return -1;
			first = false;
		} else if (line === '---') return end;
		at = end;
	}
	return -1;
}

const slugs = readdirSync(orig)
	.filter((f) => f.endsWith('.md'))
	.map((f) => f.slice(0, -3));
let bodyOk = 0,
	bodyBad = 0,
	movedOk = 0,
	notMoved = 0,
	readable = 0,
	unreadable = 0,
	withNotJson = 0,
	keyOrderBad = 0,
	handUntouched = 0,
	handChanged = 0;
const handFiles: string[] = [];
const diffs = new Map<string, string[]>();

for (const slug of slugs) {
	const o = readFileSync(join(orig, `${slug}.md`));
	const target = join(mig, slug, 'page.md');
	if (!existsSync(target) || existsSync(join(mig, `${slug}.md`))) {
		notMoved++;
		continue;
	}
	movedOk++;
	const m = readFileSync(target);
	const ob = bodyStart(o),
		mb = bodyStart(m);
	if (ob >= 0 && mb >= 0 && sha(o.subarray(ob)) === sha(m.subarray(mb)))
		bodyOk++;
	else bodyBad++;

	const conv = convertFrontMatter(o.toString('utf8'));
	if (conv.kind === 'hand') {
		handFiles.push(slug);
		if (sha(o) === sha(m)) handUntouched++;
		else handChanged++;
		continue;
	}
	const read = readMarkdown(m.toString('utf8'));
	if (!read.readable) unreadable++;
	else readable++;
	if (read.notJson.length > 0) withNotJson++;

	// Key order: keys of the original block, in order, equal the converted ones.
	const keysOf = (b: Buffer, end: number) =>
		b
			.subarray(0, end)
			.toString('utf8')
			.split('\n')
			.slice(1, -2)
			.flatMap((l) => {
				const k = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(l);
				return k ? [k[1] as string] : [];
			});
	if (keysOf(o, ob).join() !== keysOf(m, mb).join()) keyOrderBad++;

	// Independent cross-check: Bun.YAML on the original block.
	const block = o
		.subarray(0, ob)
		.toString('utf8')
		.replace(/^---\n/, '')
		.replace(/---\n$/, '');
	let yaml: Record<string, unknown>;
	try {
		yaml = Bun.YAML.parse(block) as Record<string, unknown>;
	} catch (e) {
		const list = diffs.get('YAML parse error') ?? [];
		list.push(slug);
		diffs.set('YAML parse error', list);
		continue;
	}
	for (const [k, v] of Object.entries(yaml)) {
		const got = read.fields[k];
		if (JSON.stringify(got) === JSON.stringify(v)) continue;
		const kind =
			v instanceof Date
				? 'YAML date -> string'
				: typeof v === 'number'
					? `YAML number -> string (${JSON.stringify(got)})`
					: Array.isArray(v) && JSON.stringify(got) !== JSON.stringify(v)
						? 'list differs'
						: `${typeof v} differs`;
		const list = diffs.get(kind) ?? [];
		list.push(`${slug} ${k}: yaml=${JSON.stringify(v)} ours=${JSON.stringify(got)}`);
		diffs.set(kind, list);
	}
}

// Files that were already in folders.
let nestedSame = 0,
	nestedBad = 0;
const walk = (rel: string) => {
	for (const e of readdirSync(join(orig, rel), { withFileTypes: true })) {
		const r = join(rel, e.name);
		if (e.isDirectory()) walk(r);
		else if (e.name.endsWith('.md') && rel !== '') {
			const a = readFileSync(join(orig, r));
			const bPath = join(mig, r);
			if (existsSync(bPath) && sha(a) === sha(readFileSync(bPath))) nestedSame++;
			else nestedBad++;
		}
	}
};
walk('');

console.log({
	topLevelOriginals: slugs.length,
	movedToPageMd: movedOk,
	notMoved,
	bodyBytesEqual: bodyOk,
	bodyBytesDiffer: bodyBad,
	convertedFilesReadable: readable,
	convertedFilesUnreadable: unreadable,
	convertedFilesWithNotJsonLines: withNotJson,
	keyOrderMismatches: keyOrderBad,
	handFiles: handFiles.length,
	handFilesByteIdenticalToOriginal: handUntouched,
	handFilesChanged: handChanged,
	nestedMdUnchanged: nestedSame,
	nestedMdChanged: nestedBad,
});
console.log('Value differences against Bun.YAML on the original block:');
for (const [kind, list] of [...diffs].sort())
	console.log(`  ${list.length}  ${kind}\n     e.g. ${list.slice(0, 2).join(' | ').slice(0, 220)}`);
