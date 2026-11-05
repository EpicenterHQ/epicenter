/**
 * Front-Matter Primitive Tests
 *
 * Holds the TypeScript primitive to `fixtures/front-matter.json`, the cases
 * a Rust twin reads too: what a file's fields are, what a patch writes, and
 * what a merge writes, byte for byte. Each body merge in the fixture is also
 * checked against `git merge-file`, so the fixture cannot drift from Git.
 *
 * Key behaviors:
 * - A file outside the `key: <JSON>` grammar has no front matter: it is all body
 * - A patch rewrites only the lines of the fields it changes, and never normalizes
 * - A merge takes fields by key and value, the later write winning a field both changed
 * - A body merges by Git's line merge, a clash written as Git's markers
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonValue } from '../json.js';
import {
	type FieldPatch,
	type Later,
	merge3,
	parseFrontMatter,
	patchFrontMatter,
} from './front-matter.js';
import { mergeLines } from './line-merge.js';

const fixture = (await Bun.file(
	join(import.meta.dir, '../../fixtures/front-matter.json'),
).json()) as {
	parse: {
		name: string;
		text: string;
		fields: [string, JsonValue][] | null;
		body: string;
	}[];
	patch: ({ name: string; text: string; expected: string } & FieldPatch)[];
	merge: {
		name: string;
		base: string | null;
		current: string | null;
		incoming: string | null;
		later: Later;
		expected: string | null;
		conflict: boolean;
	}[];
};

test.each(fixture.parse)('parse: $name', ({ text, fields, body }) => {
	const parsed = parseFrontMatter(text);
	if (fields === null) {
		expect(parsed).toBeNull();
		return;
	}
	expect(parsed && Object.entries(parsed.fields)).toEqual(fields);
	expect(parsed?.body).toBe(body);
});

test.each(fixture.patch)(
	'patch: $name',
	({ text, set, delete: deleted, expected }) => {
		expect(patchFrontMatter(text, { set, delete: deleted })).toBe(expected);
	},
);

test.each(fixture.merge)(
	'merge: $name',
	({ base, current, incoming, later, expected, conflict }) => {
		expect(merge3(base, current, incoming, { later })).toEqual({
			text: expected,
			conflict,
		});
	},
);

test('a patch refuses a key the grammar cannot hold', () => {
	expect(() => patchFrontMatter('---\n---\n', { set: { 'a b': 1 } })).toThrow();
});

// ============================================================================
// Agreement with Git
// ============================================================================

const scratch = mkdtempSync(join(tmpdir(), 'line-merge-'));

/** What `git merge-file` writes for the three texts, and whether it found a conflict. */
function gitMergeFile(base: string, current: string, incoming: string) {
	const [o, a, b] = ['base', 'current', 'incoming'].map((name, index) => {
		const path = join(scratch, name);
		writeFileSync(path, [base, current, incoming][index] as string);
		return path;
	});
	const ran = Bun.spawnSync([
		'git',
		'-c',
		'merge.conflictStyle=merge',
		'merge-file',
		'-p',
		'-L',
		'current',
		'-L',
		'base',
		'-L',
		'incoming',
		a as string,
		o as string,
		b as string,
	]);
	return { text: ran.stdout.toString(), conflict: ran.exitCode !== 0 };
}

/** The bodies each fixture merge ran a line merge over. */
const bodyMerges = fixture.merge.flatMap(
	({ name, base, current, incoming }) => {
		if (current === null || incoming === null) return [];
		const [b, c, i] = [base ?? '', current, incoming].map(
			(text) => parseFrontMatter(text)?.body ?? null,
		);
		if (b != null && c != null && i != null)
			return [{ name, base: b, current: c, incoming: i }];
		return [{ name, base: base ?? '', current, incoming }];
	},
);

test.each(bodyMerges)(
	'line merge agrees with git merge-file: $name',
	(texts) => {
		const merged = mergeLines(texts.base, texts.current, texts.incoming);
		const git = gitMergeFile(texts.base, texts.current, texts.incoming);
		// `git merge-file` joins clashes separated only by lines without letters
		// or digits (its ZEALOUS_ALNUM level); `git merge` and libgit2 do not.
		if (texts.name.includes('git merge-file would join them')) {
			expect(merged.text).not.toBe(git.text);
			expect(merged.conflict).toBe(git.conflict);
			return;
		}
		expect(merged).toEqual(git);
	},
);

test('line merge agrees with git merge-file on 300 generated merges', () => {
	let seed = 7;
	const random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const lines = ['a', 'b', 'c', 'd', 'x1', 'y2'];
	const pick = () => lines[Math.floor(random() * lines.length)] as string;
	const edit = (from: string[]) => {
		const out = [...from];
		for (let edits = 1 + Math.floor(random() * 3); edits > 0; edits--) {
			const at = Math.floor(random() * (out.length + 1));
			const kind = random();
			if (kind < 0.33) out.splice(at, 0, pick());
			else if (kind < 0.66) out.splice(at, 1);
			else out.splice(at, 1, pick());
		}
		return out;
	};
	const text = (from: string[]) =>
		from
			.map((line, at) =>
				at === from.length - 1 && random() < 0.1 ? line : `${line}\n`,
			)
			.join('');
	for (let run = 0; run < 300; run++) {
		const base = Array.from({ length: Math.floor(random() * 30) }, pick);
		const [o, a, b] = [text(base), text(edit(base)), text(edit(base))];
		expect({ o, a, b, ...mergeLines(o, a, b) }).toEqual({
			o,
			a,
			b,
			...gitMergeFile(o, a, b),
		});
	}
});
