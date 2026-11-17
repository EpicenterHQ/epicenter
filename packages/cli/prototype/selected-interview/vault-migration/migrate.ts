#!/usr/bin/env bun
/**
 * Vault pages migration (ADR-0927, ADR-0924).
 *
 *   bun migrate.ts <pages-dir> [--write] [--real]
 *
 * Moves `<pages>/{slug}.md` to `<pages>/{slug}/page.md` and rewrites each
 * page's front matter as `key: <JSON>` lines. Without `--write` it only
 * reports. Running it again after `--write` changes nothing.
 *
 * Front matter is converted from its text, never from a YAML parse, so no
 * scalar changes value (`zip: 01234` stays text, `date: 2026-09-23` becomes
 * a string). A block the rules cannot carry is left untouched, its file is
 * still moved, and it is listed for hand conversion with the reason.
 *
 * The script refuses a target under `~/Epicenter` unless given `--real`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json };

export type Conversion =
	/** The file does not open with a front matter block. */
	| { kind: 'none' }
	/** Every line is `key: <JSON>` after conversion; `changed` says whether any line was rewritten. */
	| { kind: 'ok'; text: string; changed: boolean }
	/** Front matter the rules cannot carry; the text is untouched. */
	| { kind: 'hand'; reasons: string[] };

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/s;

/** Text is canonical JSON for a number, `true`, `false` or `null`. */
function canonicalScalar(t: string): { value: Json } | undefined {
	if (!/^(-?\d|true$|false$|null$)/.test(t)) return undefined;
	try {
		const value = JSON.parse(t) as Json;
		if (JSON.stringify(value) !== t) return undefined;
		if (value !== null && typeof value === 'object') return undefined;
		if (typeof value === 'string') return undefined;
		return { value };
	} catch {
		return undefined;
	}
}

/** Text that is already a JSON string, array or object. */
function isJsonCollectionOrString(t: string): boolean {
	if (!/^["[{]/.test(t)) return false;
	try {
		JSON.parse(t);
		return true;
	} catch {
		return false;
	}
}

/**
 * One YAML scalar (a bare, single- or double-quoted value) read from its
 * text. `inList` marks a list item, where `a: b` would be a nested map.
 */
function scalar(
	t: string,
	inList: boolean,
	reasons: Set<string>,
): Json | undefined {
	if (t === '') {
		reasons.add('empty list item');
		return undefined;
	}
	const first = t[0] as string;
	if (first === '"') {
		try {
			const value = JSON.parse(t) as Json;
			if (typeof value === 'string') return value;
		} catch {}
		reasons.add(
			/^"(?:[^"\\]|\\.)*"\s+#/.test(t)
				? 'comment'
				: 'double-quoted scalar that is not a JSON string',
		);
		return undefined;
	}
	if (first === "'") {
		const m = /^'((?:[^']|'')*)'(\s+#.*)?$/.exec(t);
		if (m) {
			if (m[2]) {
				reasons.add('comment');
				return undefined;
			}
			return (m[1] as string).replace(/''/g, "'");
		}
		reasons.add('single-quoted scalar that does not close on its line');
		return undefined;
	}
	if (first === '|' || first === '>') {
		reasons.add('block scalar (| or >)');
		return undefined;
	}
	if (first === '&' || first === '*' || first === '!') {
		reasons.add('anchor, alias or tag');
		return undefined;
	}
	if (first === '{') {
		reasons.add('flow map');
		return undefined;
	}
	if (first === '[') {
		reasons.add('nested list');
		return undefined;
	}
	if (/\s#/.test(t)) {
		reasons.add('comment');
		return undefined;
	}
	if (inList && /(^|[^:]):(\s|$)/.test(t)) {
		reasons.add('map inside a list item');
		return undefined;
	}
	const canon = canonicalScalar(t);
	if (canon) return canon.value;
	return t;
}

/** Items of a flow list's inner text, each as trimmed scalar text; `undefined` when it cannot be split. */
function flowItems(inner: string): string[] | undefined {
	const items: string[] = [];
	let i = 0;
	const n = inner.length;
	while (i < n) {
		while (i < n && /\s/.test(inner[i] as string)) i++;
		if (i >= n) break;
		const c = inner[i] as string;
		let end: number;
		if (c === '"' || c === "'") {
			let j = i + 1;
			for (; j < n; j++) {
				const d = inner[j] as string;
				if (c === '"' && d === '\\') j++;
				else if (d === c) {
					if (c === "'" && inner[j + 1] === "'") j++;
					else break;
				}
			}
			if (j >= n) return undefined;
			end = j + 1;
			const stop = inner.indexOf(',', end);
			const upto = stop < 0 ? n : stop;
			if (inner.slice(end, upto).trim() !== '') {
				// text after the closing quote: keep it so scalar() flags it
				end = upto;
			}
			items.push(inner.slice(i, end).trim());
			i = end;
		} else {
			const stop = inner.indexOf(',', i);
			end = stop < 0 ? n : stop;
			items.push(inner.slice(i, end).trim());
			i = end;
		}
		while (i < n && /\s/.test(inner[i] as string)) i++;
		if (i < n) {
			if (inner[i] !== ',') return undefined;
			i++;
		}
	}
	return items;
}

const lineParts = (line: string) => {
	const m = /^(.*?)(\r?\n)?$/s.exec(line) as RegExpExecArray;
	return { content: m[1] as string, eol: m[2] ?? '' };
};

/** Convert a Markdown file's front matter to `key: <JSON>` lines. */
export function convertFrontMatter(text: string): Conversion {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	if (lines.length === 0) return { kind: 'none' };
	const open = lineParts(lines[0] as string);
	if (open.content !== '---' || open.eol === '') return { kind: 'none' };
	let close = -1;
	for (let i = 1; i < lines.length; i++)
		if (lineParts(lines[i] as string).content === '---') {
			close = i;
			break;
		}
	if (close < 0) return { kind: 'hand', reasons: ['no closing fence'] };

	const reasons = new Set<string>();
	const out: string[] = [];
	const seen = new Set<string>();
	let i = 1;
	while (i < close) {
		const line = lines[i] as string;
		const { content, eol } = lineParts(line);
		if (content.trim() === '') {
			i++;
			continue;
		}
		if (/^\s*#/.test(content)) {
			reasons.add('comment');
			i++;
			continue;
		}
		const m = KEY_LINE.exec(content);
		if (!m) {
			reasons.add(
				/^\s/.test(content)
					? 'indented line (nested map or continuation)'
					: 'line that is not `key: value`',
			);
			i++;
			continue;
		}
		const key = m[1] as string;
		const rest = m[2] ?? '';
		const t = rest.trim();
		if (seen.has(key)) reasons.add('duplicate key');
		seen.add(key);
		i++;

		if (t === '') {
			const values: (Json | undefined)[] = [];
			let count = 0;
			for (;;) {
				// blank lines between items are dropped
				let j = i;
				while (j < close && lineParts(lines[j] as string).content.trim() === '') j++;
				if (j >= close || !/^\s*-(\s|$)/.test(lineParts(lines[j] as string).content)) break;
				i = j;
				const c = lineParts(lines[i] as string).content;
				const prefix = (/^\s*-\s*/.exec(c) as RegExpExecArray)[0];
				const dash = c.length - c.trimStart().length;
				const itemText = c.slice(prefix.length).trim();
				i++;
				count++;
				if (itemText === '') {
					const next = i < close ? lineParts(lines[i] as string).content : '';
					reasons.add(
						/^\s+\S/.test(next) && next.search(/\S/) > dash
							? 'block under a list item'
							: 'empty list item',
					);
					values.push(undefined);
					continue;
				}
				if (isJsonCollectionOrString(itemText)) {
					values.push(JSON.parse(itemText) as Json);
					continue;
				}
				const first = KEY_LINE.exec(itemText);
				if (first && itemText[0] !== '"' && itemText[0] !== "'") {
					const col = prefix.length;
					const obj: { [k: string]: Json } = {};
					let ok = true;
					const add = (k: string, rest: string) => {
						const v = rest.trim();
						if (Object.hasOwn(obj, k)) {
							reasons.add('duplicate key');
							ok = false;
							return;
						}
						if (v === '') {
							reasons.add('nested deeper than one map in a list item');
							ok = false;
							return;
						}
						const val = isJsonCollectionOrString(v)
							? (JSON.parse(v) as Json)
							: v[0] === '['
								? (reasons.add('nested deeper than one map in a list item'), undefined)
								: scalar(v, false, reasons);
						if (val === undefined) ok = false;
						else obj[k] = val;
					};
					add(first[1] as string, first[2] ?? '');
					while (i < close) {
						const nc = lineParts(lines[i] as string).content;
						const indent = nc.length - nc.trimStart().length;
						const km = indent === col ? KEY_LINE.exec(nc.slice(col)) : null;
						if (!km) break;
						add(km[1] as string, km[2] ?? '');
						i++;
					}
					values.push(ok ? obj : undefined);
					continue;
				}
				values.push(scalar(itemText, true, reasons));
			}
			if (count === 0) {
				const next = i < close ? lineParts(lines[i] as string).content : '';
				reasons.add(
					/^\s+\S/.test(next) ? 'nested map' : 'key with an empty value',
				);
				continue;
			}
			if (values.some((v) => v === undefined)) continue;
			out.push(`${key}: ${JSON.stringify(values)}${eol}`);
			continue;
		}

		if (isJsonCollectionOrString(t) || canonicalScalar(t)) {
			out.push(line);
			continue;
		}
		if (t[0] === '[') {
			if (!t.endsWith(']')) {
				reasons.add('flow list that does not close on its line');
				continue;
			}
			const items = flowItems(t.slice(1, -1));
			if (!items) {
				reasons.add('flow list that cannot be split');
				continue;
			}
			const values = items.map((item) => scalar(item, true, reasons));
			if (values.some((v) => v === undefined)) continue;
			out.push(`${key}: ${JSON.stringify(values)}${eol}`);
			continue;
		}
		const value = scalar(t, false, reasons);
		if (value === undefined) continue;
		out.push(`${key}: ${JSON.stringify(value)}${eol}`);
	}

	if (reasons.size > 0) return { kind: 'hand', reasons: [...reasons].sort() };
	const front = lines.slice(1, close).join('');
	const next = out.join('');
	return {
		kind: 'ok',
		text: lines[0] + next + lines.slice(close).join(''),
		changed: front !== next,
	};
}

/** Why a name is not a slug under ADR-0927, or `undefined` when it is. */
export function slugRefusal(slug: string): string | undefined {
	if (slug !== slug.trim()) return 'leading or trailing whitespace';
	if (slug.startsWith('.')) return 'leading dot';
	if (new TextEncoder().encode(slug).length > 200) return 'over 200 bytes';
	if (slug !== slug.normalize('NFC')) return 'not NFC';
	if (slug !== slug.toLowerCase()) return 'uppercase';
	if (slug === '') return 'empty';
	return undefined;
}

type Report = {
	moved: string[];
	alreadyMoved: number;
	conflicts: { slug: string; why: string }[];
	refused: { slug: string; why: string }[];
	converted: string[];
	unchangedFront: number;
	noFrontMatter: string[];
	hand: { path: string; reasons: string[] }[];
};

function refuseRealHome(pages: string, real: boolean) {
	const target = existsSync(pages) ? realpathSync(pages) : resolve(pages);
	const home = join(realpathSync(homedir()), 'Epicenter');
	if (!real && (target === home || target.startsWith(home + sep))) {
		console.error(
			`Refusing: ${target} is under ${home}. Pass --real to run there.`,
		);
		process.exit(2);
	}
}

export async function migrate(pages: string, write: boolean): Promise<Report> {
	const report: Report = {
		moved: [],
		alreadyMoved: 0,
		conflicts: [],
		refused: [],
		converted: [],
		unchangedFront: 0,
		noFrontMatter: [],
		hand: [],
	};
	const entries = await readdir(pages, { withFileTypes: true });
	const conflictSlugs = new Set<string>();

	// 1. Move.
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		const slug = entry.name.slice(0, -3);
		const refusal = slugRefusal(slug);
		if (refusal) {
			report.refused.push({ slug, why: refusal });
			continue;
		}
		const folder = join(pages, slug);
		const target = join(folder, 'page.md');
		if (existsSync(target)) {
			report.conflicts.push({ slug, why: 'page.md already exists' });
			conflictSlugs.add(slug);
			continue;
		}
		if (existsSync(folder) && !(await stat(folder)).isDirectory()) {
			report.conflicts.push({ slug, why: 'path exists and is not a folder' });
			conflictSlugs.add(slug);
			continue;
		}
		report.moved.push(slug);
		if (write) {
			await mkdir(folder, { recursive: true });
			await rename(join(pages, entry.name), target);
		}
	}

	// 2. Front matter, for every page in a folder (after the move) or, in a
	// dry run, for the files that would move.
	const pending = new Set(report.moved);
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		let slug: string;
		let path: string;
		if (entry.isDirectory()) {
			slug = entry.name;
			if (conflictSlugs.has(slug) || pending.has(slug)) continue;
			path = join(pages, slug, 'page.md');
			if (!existsSync(path)) continue;
			report.alreadyMoved++;
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			slug = entry.name.slice(0, -3);
			if (!pending.has(slug)) continue;
			path = write ? join(pages, slug, 'page.md') : join(pages, entry.name);
		} else continue;
		const rel = `${slug}/page.md`;
		const bytes = await readFile(path);
		const text = bytes.toString('utf8');
		if (Buffer.from(text, 'utf8').compare(bytes) !== 0) {
			report.hand.push({ path: rel, reasons: ['file is not valid UTF-8'] });
			continue;
		}
		const result = convertFrontMatter(text);
		if (result.kind === 'none') report.noFrontMatter.push(rel);
		else if (result.kind === 'hand')
			report.hand.push({ path: rel, reasons: result.reasons });
		else if (result.changed) {
			report.converted.push(rel);
			if (write) await writeFile(path, result.text);
		} else report.unchangedFront++;
	}
	return report;
}

function print(report: Report, write: boolean) {
	const group = new Map<string, string[]>();
	for (const { path, reasons } of report.hand)
		for (const reason of reasons) {
			const list = group.get(reason) ?? [];
			list.push(path);
			group.set(reason, list);
		}
	const verb = write ? 'moved' : 'to move';
	const conv = write ? 'converted' : 'to convert';
	console.log(`${write ? 'WRITE' : 'DRY RUN'}`);
	console.log(`${verb}: ${report.moved.length}`);
	console.log(`already in a folder, scanned: ${report.alreadyMoved}`);
	console.log(`front matter ${conv}: ${report.converted.length}`);
	console.log(`front matter already key: JSON: ${report.unchangedFront}`);
	console.log(`no front matter: ${report.noFrontMatter.length}`);
	console.log(`hand conversion: ${report.hand.length} files`);
	for (const [reason, paths] of [...group].sort())
		console.log(`  ${paths.length}  ${reason}`);
	console.log(`conflicts: ${report.conflicts.length}`);
	for (const c of report.conflicts) console.log(`  ${c.slug}: ${c.why}`);
	console.log(`refused slugs: ${report.refused.length}`);
	for (const r of report.refused) console.log(`  ${JSON.stringify(r.slug)}: ${r.why}`);
	console.log('hand conversion list:');
	for (const { path, reasons } of report.hand)
		console.log(`  ${path}\t${reasons.join('; ')}`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flags = new Set(args.filter((a) => a.startsWith('--')));
	const pages = args.find((a) => !a.startsWith('--'));
	if (!pages) {
		console.error('Usage: bun migrate.ts <pages-dir> [--write]');
		process.exit(1);
	}
	refuseRealHome(pages, flags.has('--real'));
	const write = flags.has('--write');
	print(await migrate(resolve(pages), write), write);
}
