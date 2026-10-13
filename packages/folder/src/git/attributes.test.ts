/**
 * Attribute Evaluation Parity Tests
 *
 * A browser folder has no Git program, so `normalizingAttribute` evaluates a
 * commit's `.gitattributes` files itself. The directory folder and the desktop
 * owner ask `git check-attr --source`. These tests commit each fixture with
 * real Git and require the two to give the same answer for every path, so a
 * browser refuses exactly the incoming commits the others refuse.
 *
 * Key behaviors:
 * - Root and nested attribute files, with the nearest file and the last
 *   matching line deciding
 * - Set, unset, unspecified, and valued states; the built-in `binary` macro
 *   and macros a root file defines
 * - Git's pattern rules: basename and anchored patterns, `*`, `?`, `**`,
 *   bracket sets, escapes, quoted patterns, and directory-only patterns
 * - Lines Git ignores: comments, negative patterns, invalid attribute names,
 *   macros outside the root file
 * - Matching as a case-insensitive checkout matches
 *
 * See also:
 * - `../incoming-attributes.test.ts` for the refusal a pull makes from this
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GIT_ENV, git, scratch } from '../git-http.test-support.js';
import {
	isAttributesPath,
	NORMALIZING,
	normalizingAttribute,
} from './attributes.js';

const encoder = new TextEncoder();

type Fixture = {
	readonly name: string;
	/** Attribute files by path; every other entry of `paths` is a plain file. */
	readonly attributes: Record<string, string | Uint8Array>;
	readonly paths: readonly string[];
};

/** What Git reports for each path: its first filtering or converting attribute. */
async function gitVerdicts(fixture: Fixture) {
	const root = await scratch('attributes-');
	await git(root, 'init', '--quiet', '--initial-branch=main');
	// Match as a case-insensitive checkout does, on every platform.
	await git(root, 'config', 'core.ignorecase', 'true');
	for (const [path, content] of Object.entries(fixture.attributes)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	// A case-insensitive checkout holds one file for paths that differ only in
	// case, and Git with core.ignorecase refuses to add the second. Write each
	// such file once, as that checkout would, on a case-sensitive disk too.
	const written = new Set<string>();
	for (const path of fixture.paths) {
		if (written.has(path.toLowerCase())) continue;
		written.add(path.toLowerCase());
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), 'plain\n');
	}
	await git(root, 'add', '--all');
	await git(root, 'commit', '--quiet', '-m', 'fixture');
	const child = Bun.spawn(
		['git', 'check-attr', '--source=HEAD', '--stdin', '-z', ...NORMALIZING],
		{ cwd: root, env: GIT_ENV, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
	);
	child.stdin.write(`${fixture.paths.join('\0')}\0`);
	await child.stdin.end();
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git check-attr: ${err}`);
	const records = out.split('\0');
	const verdicts = new Map<string, string | undefined>(
		fixture.paths.map((path) => [path, undefined]),
	);
	for (let index = 0; index + 2 < records.length; index += 3) {
		const [path, attribute, value] = records.slice(index, index + 3) as [
			string,
			string,
			string,
		];
		if (value === 'unspecified' || value === 'unset') continue;
		if (verdicts.get(path) === undefined)
			verdicts.set(path, value === 'set' ? attribute : `${attribute}=${value}`);
	}
	return verdicts;
}

function ownVerdicts(fixture: Fixture) {
	const files = new Map(
		Object.entries(fixture.attributes).map(([path, content]) => [
			path,
			typeof content === 'string' ? encoder.encode(content) : content,
		]),
	);
	for (const path of files.keys()) expect(isAttributesPath(path)).toBe(true);
	return new Map(
		fixture.paths.map((path) => [
			path,
			normalizingAttribute(files, [path])?.attribute,
		]),
	);
}

const AUDIO = ['rec/take.wav', 'rec/nested/deep.wav', 'notes.md', 'a.bin'];

const FIXTURES: Fixture[] = [
	{
		name: 'an LFS filter declared at the root',
		attributes: {
			'.gitattributes': '*.wav filter=lfs diff=lfs merge=lfs -text\n',
		},
		paths: AUDIO,
	},
	{
		name: 'a filter in a nested file selects only files below it',
		attributes: { 'rec/nested/.gitattributes': 'deep.wav filter=lfs\n' },
		paths: [...AUDIO, 'deep.wav', 'rec/deep.wav', 'rec/nested/more/deep.wav'],
	},
	{
		name: 'line-ending conversion',
		attributes: {
			'.gitattributes': '*.md text eol=crlf\n*.c crlf\n*.txt text=auto\n',
		},
		paths: [...AUDIO, 'src/main.c', 'a.txt'],
	},
	{
		name: 'attributes that change no bytes',
		attributes: {
			'.gitattributes':
				'*.wav -text diff=audio\n*.md linguist-documentation merge=union\n*.bin binary\n*.lock -diff\n',
		},
		paths: [...AUDIO, 'bun.lock'],
	},
	{
		name: 'a later line and a nearer file override',
		attributes: {
			'.gitattributes':
				'* text=auto\n*.wav filter=lfs\nspecial.wav !filter -text\n',
			'rec/.gitattributes': '*.wav -filter\n*.md !text\n',
			'rec/nested/.gitattributes': '*.wav filter=other\n* -text\n',
		},
		paths: [
			...AUDIO,
			'special.wav',
			'top.wav',
			'rec/notes.md',
			'rec/nested/x.md',
		],
	},
	{
		name: 'macros: built in, defined at the root, and ignored below it',
		attributes: {
			'.gitattributes':
				'[attr]lfs filter=lfs diff=lfs merge=lfs -text\n[attr]plain -text -filter\n[attr]twice eol=lf\n[attr]twice ident\n*.big lfs\n*.raw plain\n*.two twice\n*.neg -lfs\n*.val lfs=on\n',
			'sub/.gitattributes':
				'[attr]mine filter=x\n*.q mine\n*.big -lfs\n*.raw lfs plain\n',
		},
		paths: [
			'a.big',
			'a.raw',
			'a.two',
			'a.neg',
			'a.val',
			'sub/a.q',
			'sub/a.big',
			'sub/a.raw',
		],
	},
	{
		name: 'anchored, nested, and double-star patterns',
		attributes: {
			'.gitattributes': [
				'/top.txt eol=lf',
				'docs/*.txt ident',
				'docs/**/deep.txt filter=a',
				'**/any.txt eol=crlf',
				'tree/** filter=b',
				'dir/ filter=never',
				'a/**/z.dat filter=c',
				'**/vendor/** filter=d',
				'mid**dle.txt filter=e',
				'',
			].join('\n'),
			'pkg/.gitattributes':
				'/only-here.txt eol=lf\nsub/*.bin filter=f\n*.bin filter=g\n',
		},
		paths: [
			'top.txt',
			'x/top.txt',
			'docs/a.txt',
			'docs/x/a.txt',
			'docs/deep.txt',
			'docs/x/y/deep.txt',
			'any.txt',
			'p/q/any.txt',
			'tree/a',
			'tree/b/c',
			'treetop',
			'dir/file',
			'a/z.dat',
			'a/b/c/z.dat',
			'b/a/z.dat',
			'vendor/x',
			'p/vendor/q/r',
			'midxxdle.txt',
			'mid/x/dle.txt',
			'pkg/only-here.txt',
			'pkg/x/only-here.txt',
			'pkg/sub/a.bin',
			'pkg/a.bin',
			'pkg/deep/sub/a.bin',
			'a.bin',
		],
	},
	{
		name: 'single characters, bracket sets, classes, and escapes',
		attributes: {
			'.gitattributes': [
				'?.md text',
				'[ab].txt eol=lf',
				'[!ab].log eol=lf',
				'[c-e]x filter=r',
				'[[:digit:]].dat ident',
				'[[:upper:]]u filter=up',
				'[]]q filter=br',
				'[a-].k filter=dash',
				'\\!bang.txt text',
				'star\\*.txt text',
				'"quoted name.txt" eol=lf',
				'"tab\\there.txt" eol=lf',
				'"oct\\101.txt" eol=lf',
				'[Q].case filter=q',
				'\\Z.case filter=z',
				'',
			].join('\n'),
		},
		paths: [
			'a.md',
			'ab.md',
			'd/a.md',
			'a.txt',
			'c.txt',
			'a.log',
			'c.log',
			'dx',
			'fx',
			'5.dat',
			'x.dat',
			'Au',
			'au',
			'1u',
			']q',
			'-.k',
			'a.k',
			'b.k',
			'!bang.txt',
			'star*.txt',
			'starx.txt',
			'quoted name.txt',
			'tab\there.txt',
			'octA.txt',
			'q.case',
			'Q.case',
			'z.case',
			'Z.case',
		],
	},
	{
		name: 'lines Git ignores',
		attributes: {
			'.gitattributes': [
				'# *.wav filter=lfs',
				'   # indented.comment filter=lfs',
				'!negated.txt text',
				'*.x filter=lfs bad$name',
				'*.y builtin_objectmode=1 filter=lfs',
				'*.z filter=unset',
				'*.w filter=',
				'*.v -filter=lfs',
				'*.u text=unspecified',
				'   *.indent   eol=lf   ',
				'*.cr eol=lf\r',
				'',
			].join('\n'),
		},
		paths: [
			'a.wav',
			'indented.comment',
			'negated.txt',
			'a.x',
			'a.y',
			'a.z',
			'a.w',
			'a.v',
			'a.u',
			'a.indent',
			'a.cr',
		],
	},
	{
		name: 'case and bytes',
		attributes: {
			'.gitattributes':
				'*.WAV filter=lfs\nReadme.MD text\n*.é filter=acute\n?.dat ident\ndocs/Guide.TXT eol=lf\n',
			'Mixed/.gitattributes': 'Note.md text\n',
		},
		paths: [
			'a.wav',
			'b.WAV',
			'README.md',
			'naïve/é.é',
			'é.dat',
			'e.dat',
			'docs/guide.txt',
			'Mixed/note.md',
		],
	},
	{
		name: 'working-tree encoding and ident',
		attributes: {
			'.gitattributes':
				'*.proj working-tree-encoding=UTF-16LE\n*.id ident\n*.no -ident\n',
		},
		paths: ['a.proj', 'a.id', 'a.no', 'a.other'],
	},
	{
		name: 'no attribute files at all',
		attributes: {},
		paths: AUDIO,
	},
];

describe('normalizingAttribute agrees with git check-attr --source', () => {
	test.each(FIXTURES)('$name', async (fixture) => {
		const expected = await gitVerdicts(fixture);
		const actual = ownVerdicts(fixture);
		expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
	});
});

test('the fixtures refuse and admit: the comparison is not vacuous', async () => {
	const verdicts = (
		await Promise.all(FIXTURES.map((fixture) => gitVerdicts(fixture)))
	).flatMap((map) => [...map.values()]);
	expect(
		verdicts.filter((value) => value !== undefined).length,
	).toBeGreaterThan(40);
	expect(
		verdicts.filter((value) => value === undefined).length,
	).toBeGreaterThan(40);
});

test('the first path in byte order is reported, with the attribute as Git names it', () => {
	const files = new Map([
		['.gitattributes', encoder.encode('*.wav filter=lfs -text\n*.md text\n')],
	]);
	expect(
		normalizingAttribute(files, ['z.wav', 'notes.md', 'a/b.wav', 'a.wav']),
	).toEqual({ path: 'a.wav', attribute: 'filter=lfs' });
	expect(normalizingAttribute(files, ['notes.md', 'plain.txt'])).toEqual({
		path: 'notes.md',
		attribute: 'text',
	});
	expect(normalizingAttribute(files, ['plain.txt'])).toBeUndefined();
});

test('a declaration behind a byte-order mark is refused whichever way Git would read it', () => {
	const files = new Map([
		['.gitattributes', encoder.encode('﻿*.wav filter=lfs\n')],
	]);
	expect(normalizingAttribute(files, ['a.wav'])?.attribute).toBe('filter=lfs');
});
