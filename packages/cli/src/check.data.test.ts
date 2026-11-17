/**
 * Data checks run the real CLI against records in a temporary home.
 * Counts, filename rules, aliases, exact references, and single files stay
 * consistent between human reports and JSON.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './runner.test-support.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function setup(aliasInventory = false) {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.app(
		'flights',
		`
import { defineData } from '@epicenter/app';
const data = defineData({
  watches: { fields: { from: field.text() } },
  checks: { fields: { watch: field.ref('watches'), day: field.date(), many: field.list(field.ref('watches')) } },
  'settings.md': { fields: { level: field.integer() } },
});
${
	aliasInventory
		? `
// Preserve a case-sensitive inventory even when the host disk merges the names.
const diskList = folder.list;
folder.list = async (dir) => {
  const paths = await diskList(dir);
  return dir === 'data/watches' && paths.includes('data/watches/DUNE.md')
    ? [...new Set([...paths, 'data/watches/Dune.md'])]
    : paths;
};`
		: ''
}
export default defineApp({ description: 'Flights', data, actions: {} });
`,
	);
	return { ...f, dataPath: join(app, 'data') };
}

test('fitting folders and absent single files exit 0 without counting ignored entries', async () => {
	const f = await setup();
	await f.folder(f.dataPath, {
		'watches/sfo-nyc.md': '---\nfrom: "SFO"\n---\n',
		'watches/.hidden.md': '---\nnot front matter\n',
		'watches/token.local.md': '---\nfrom: "SFO"\n---\n',
		'watches/nested/deep.md': '---\nnot front matter\n',
		'watches/folder.md/deep.md': '---\nnot front matter\n',
		'watches/image.png': 'not Markdown',
		'watches/upper.MD': 'not Markdown',
		'cache/other.md': 'not a record',
		'checks/one.md':
			'---\nwatch: "sfo-nyc"\nday: "2026-11-16"\nmany: ["token.local"]\n---\n',
	});
	const human = await f.run('check', 'flights');
	expect(human).toEqual({
		code: 0,
		stderr: '',
		stdout: [
			'flights',
			'  watches  2 files, none with problems',
			'  checks  1 file, none with problems',
			'  settings.md  fits',
			'',
		].join('\n'),
	});
	const json = await f.run('check', 'flights', '--json');
	expect(json.code).toBe(0);
	const report = JSON.parse(json.stdout);
	expect(report.apps.flights.watches).toMatchObject({
		files: 2,
		withProblems: 0,
		records: [],
	});
	expect(report.apps.flights['settings.md']).toMatchObject({
		files: 0,
		withProblems: 0,
	});
	expect(json.stdout).not.toContain('skipped');
});
test('misfit fields and malformed front matter reuse handle diagnostics and exit 1', async () => {
	const f = await setup();
	await f.folder(f.dataPath, {
		'checks/bad.md': '---\nwatch: 3\nday: "soon"\n---\n',
		'checks/json.md': '---\nwatch: "lost"\nday: tomorrow\n---\n',
		'checks/unreadable.md': '---\n# invalid line\n---\n',
		'settings.md': '---\nlevel: "high"\n---\n',
	});
	const result = await f.run('check', 'flights', '--json');
	expect(result.code).toBe(1);
	const report = JSON.parse(result.stdout).apps.flights;
	expect(report.checks).toMatchObject({ files: 3, withProblems: 3 });
	expect(report.checks.records).toEqual([
		{
			path: 'checks/bad.md',
			problems: [
				'watch: 3 is not a record id: non-empty NFC text of at most 200 UTF-8 bytes, without slashes, control characters, a leading dot, or boundary spaces',
				'day: "soon" is not a day like 2026-11-12',
			],
		},
		{
			path: 'checks/json.md',
			problems: [
				'day on line 3 is not JSON; day takes a day like 2026-11-12, written as JSON',
				'watch "lost" names no file in watches/',
			],
		},
		{
			path: 'checks/unreadable.md',
			problems: [
				'its front matter is not key: value lines between two --- lines, each key once',
			],
		},
	]);
	expect(report['settings.md'].records).toEqual([
		{ path: 'settings.md', problems: ['level: "high" is not a whole number'] },
	]);
	const human = await f.run('check', 'flights');
	expect(human.stdout).toContain(
		'  checks  3 files, 3 with problems\n    checks/bad.md\n      watch: 3 is not a record id:',
	);
	expect(human.stdout).not.toContain('data/');
});

test('invalid reachable-looking names count as problems but their contents are not read', async () => {
	const f = await setup();
	await f.folder(f.dataPath, {
		'watches/ bad.md': '---\nunreadable\n',
		'watches/bad .md': '---\nunreadable\n',
		'watches/back\\slash.md': '---\nunreadable\n',
		'watches/control\u0001.md': '---\nunreadable\n',
		'watches/cafe\u0301.md': '---\nunreadable\n',
		[`watches/${'a'.repeat(201)}.md`]: '---\nunreadable\n',
	});
	const result = await f.run('check', 'flights', '--json');
	expect(result.code).toBe(1);
	const watches = JSON.parse(result.stdout).apps.flights.watches;
	expect(watches).toMatchObject({ files: 6, withProblems: 6 });
	expect(
		watches.records
			.map((record: { problems: string[] }) => record.problems[0])
			.sort(),
	).toEqual(
		[
			'an id cannot contain / or \\',
			'an id cannot contain a control character',
			'an id cannot start or end with a space',
			'an id cannot start or end with a space',
			'an id must be Unicode NFC',
			'an id must be at most 200 UTF-8 bytes',
		].sort(),
	);
	expect(result.stdout).not.toContain('front matter');
});

test('case-folded names produce one alias problem naming both files and count both affected files', async () => {
	const f = await setup(true);
	await f.folder(f.dataPath, {
		'watches/DUNE.md': '---\nfrom: "SFO"\n---\n',
		'watches/Dune.md': '---\nfrom: "SFO"\n---\n',
	});
	const result = await f.run('check', 'flights', '--json');
	expect(result.code).toBe(1);
	expect(JSON.parse(result.stdout).apps.flights.watches).toMatchObject({
		files: 2,
		withProblems: 2,
		kinds: [{ kind: 'are one file on a disk that ignores case', count: 2 }],
		records: [
			{
				path: 'watches/DUNE.md and watches/Dune.md',
				problems: ['are one file on a disk that ignores case'],
			},
		],
	});
	const human = await f.run('check', 'flights');
	expect(human.code).toBe(1);
	expect(human.stdout).toContain(
		'    watches/DUNE.md and watches/Dune.md\n      are one file on a disk that ignores case',
	);
});

test('refs require byte-exact ids of listed records, including list refs and misfit targets', async () => {
	const f = await setup();
	await f.folder(f.dataPath, {
		'watches/Exact.md': '---\nfrom: "SFO"\n---\n',
		'watches/misfit.md': '',
		'watches/nested/hidden.md': '',
		'checks/one.md':
			'---\nwatch: "exact"\nday: "2026-11-16"\nmany: ["Exact", "misfit", "absent", "hidden"]\n---\n',
	});
	const result = await f.run('check', 'flights', '--json');
	expect(result.code).toBe(1);
	expect(JSON.parse(result.stdout).apps.flights.checks.records).toEqual([
		{
			path: 'checks/one.md',
			problems: [
				'watch "exact" names no file in watches/',
				'many[2] "absent" names no file in watches/',
				'many[3] "hidden" names no file in watches/',
			],
		},
	]);
});
