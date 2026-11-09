import { afterEach, expect, test } from 'bun:test';
import {
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.ts';
import { fixture, gitIn } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function setup(source: string) {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.app(
		'reading',
		`export default defineApp(declaration, {actions:{${source}}});`,
	);
	return { ...f, folder };
}

/** Paths `git status` reports, in porcelain order. */
const dirtyPaths = async (folder: string) =>
	(
		await git(folder, ['status', '--porcelain=v1', '--untracked-files=all'])
	).stdout
		.toString()
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(3));
const head = async (folder: string) => gitIn(folder, 'rev-parse', 'HEAD');
const show = async (folder: string, ...args: string[]) =>
	gitIn(folder, ...args);

test('two writes make one commit with subject and input; staged hand edits stay out', async () => {
	const f = await setup(
		`two:{description:'Two',input:{who:field.text()},positional:['who'],run:async({who},{folder})=>{await folder.write('a.md',who);await folder.write('b.md',who);return who}}`,
	);
	await writeFile(join(f.folder, 'hand.md'), 'person');
	await gitIn(f.folder, 'add', '--', 'hand.md');
	const before = await head(f.folder);
	const result = await f.run('reading', 'two', 'Ada', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		action: { returned: 'Ada' },
		refused: [],
		commit: { subject: 'reading two', paths: ['a.md', 'b.md'] },
	});
	expect(result.stderr).toBe('');
	expect((await f.run('reading', 'two', 'Bo')).stderr).toMatch(
		/^committed [a-f0-9]{7} reading two\n$/,
	);
	expect(await show(f.folder, 'log', '-1', '--format=%B', 'HEAD~1')).toBe(
		'reading two\n\n{"who":"Ada"}',
	);
	expect(
		(
			await show(
				f.folder,
				'diff-tree',
				'--no-commit-id',
				'--name-only',
				'-r',
				'HEAD',
			)
		).split('\n'),
	).toEqual(['a.md', 'b.md']);
	expect(await show(f.folder, 'rev-list', '--count', `${before}..HEAD`)).toBe(
		'2',
	);
	expect(await dirtyPaths(f.folder)).toEqual(['hand.md']);
});

test('a no-op action makes no commit', async () => {
	const f = await setup(`nothing:{description:'Nothing',input:{},run:()=>42}`);
	const before = await head(f.folder);
	expect(await f.run('reading', 'nothing', '--json')).toEqual({
		code: 0,
		stdout:
			'{"action":{"returned":42},"refused":[],"commit":null,"paths":[],"push":null}\n',
		stderr: '',
	});
	expect(await head(f.folder)).toBe(before);
});

test('commit includes tracked edits and deletions but excludes ignored files', async () => {
	const f = await setup(
		`change:{description:'Change',input:{},run:async(_,{folder})=>{await folder.write('edit.md','updated');await folder.delete('remove.md');await folder.write('ignored.tmp','cache')}}`,
	);
	await writeFile(join(f.folder, 'edit.md'), 'old');
	await writeFile(join(f.folder, 'remove.md'), 'old');
	await writeFile(join(f.folder, '.gitignore'), '*.tmp\n');
	await gitIn(f.folder, 'add', '-A');
	await gitIn(f.folder, 'commit', '-q', '-m', 'data');
	const result = await f.run('reading', 'change', '--json');
	expect(result.code).toBe(0);
	expect(
		(
			await show(
				f.folder,
				'diff-tree',
				'--no-commit-id',
				'--name-only',
				'-r',
				'HEAD',
			)
		).split('\n'),
	).toEqual(['edit.md', 'remove.md']);
	expect(await Bun.file(join(f.folder, 'ignored.tmp')).exists()).toBe(true);
});

test('a refused write keeps the writes before it, committed with the failure named', async () => {
	const f = await setup(
		`touch:{description:'Touch',input:{},run:async(_,{folder})=>{await folder.write('b.md','action');await folder.write('a.md','wrong')}}`,
	);
	await writeFile(join(f.folder, 'a.md'), 'person bytes\n');
	const result = await f.run('reading', 'touch', '--json');
	expect(result.code).toBe(3);
	expect(JSON.parse(result.stdout)).toMatchObject({
		refused: [{ path: 'a.md', reason: 'uncommitted' }],
		commit: { paths: ['b.md'] },
	});
	expect(await show(f.folder, 'show', 'HEAD:b.md')).toBe('action');
	expect(await show(f.folder, 'log', '-1', '--format=%s')).toBe(
		'reading touch (failed: a.md has changes you have not committed, so the action did…)',
	);
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe('person bytes\n');
});

test('a write around the folder, through folder.path, is not recorded and stays uncommitted', async () => {
	const f = await setup(
		`path:{description:'Path',input:{},run:async(_,{folder})=>{await Bun.write(folder.path+'/a.md','changed by path');await folder.write('b.md','action')}}`,
	);
	await writeFile(join(f.folder, 'a.md'), 'mine');
	const result = await f.run('reading', 'path', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).commit.paths).toEqual(['b.md']);
	expect(await readFile(join(f.folder, 'a.md'), 'utf8')).toBe(
		'changed by path',
	);
	expect(await show(f.folder, 'show', 'HEAD:b.md')).toBe('action');
	expect(await dirtyPaths(f.folder)).toEqual(['a.md']);
});

test('a folder inside another repository is refused before run', async () => {
	const f = await setup(
		`touch:{description:'Touch',input:{},run:async(_,{folder})=>{await folder.write('ran.md','yes')}}`,
	);
	await rm(join(f.folder, '.git'), { recursive: true });
	await gitIn(f.home, 'init', '-q');
	const result = await f.run('reading', 'touch', '--json');
	expect(result.code).toBe(2);
	expect(JSON.parse(result.stdout).error.next).toBe(`git -C ${f.folder} init`);
	expect(await Bun.file(join(f.folder, 'ran.md')).exists()).toBe(false);
});

test('same-app actions take turns and different apps can run together', async () => {
	const source = `slow:{description:'Slow',input:{id:field.text()},positional:['id'],run:async({id},{folder})=>{const check=Bun.spawn(['git','-C',folder.path,'show','HEAD:one.txt'],{stdout:'pipe',stderr:'pipe'});const sawCommit=(await check.exited)===0;const started=Date.now();await Bun.sleep(250);await folder.write(id+'.txt',id);return {sawCommit,started,ended:Date.now()}}}`;
	const f = await setup(source);
	await f.app(
		'other',
		`export default defineApp(declaration, {actions:{${source}}});`,
	);
	const first = f.run('reading', 'slow', 'one', '--json');
	await Bun.sleep(60);
	const second = f.run('reading', 'slow', 'two', '--json');
	const [one, two] = await Promise.all([first, second]);
	expect(one.code).toBe(0);
	expect(two.code).toBe(0);
	expect(JSON.parse(two.stdout).action.returned).toMatchObject({
		sawCommit: true,
	});
	const [reading, other] = await Promise.all([
		f.run('reading', 'slow', 'three', '--json'),
		f.run('other', 'slow', 'four', '--json'),
	]);
	expect(reading.code).toBe(0);
	expect(other.code).toBe(0);
	const oneInterval = JSON.parse(reading.stdout).action.returned;
	const otherInterval = JSON.parse(other.stdout).action.returned;
	expect(Math.max(oneInterval.started, otherInterval.started)).toBeLessThan(
		Math.min(oneInterval.ended, otherInterval.ended),
	);
});

test('an action during an unfinished merge is refused before it runs', async () => {
	const f = await setup(
		`touch:{description:'Touch',input:{},run:async(_,{folder})=>{await folder.write('b.md','action')}}`,
	);
	const main = await show(f.folder, 'rev-parse', '--abbrev-ref', 'HEAD');
	await writeFile(join(f.folder, 'a.md'), 'base\n');
	await gitIn(f.folder, 'add', '-A');
	await gitIn(f.folder, 'commit', '-q', '-m', 'base');
	await gitIn(f.folder, 'checkout', '-q', '-b', 'other');
	await writeFile(join(f.folder, 'a.md'), 'other\n');
	await gitIn(f.folder, 'commit', '-q', '-am', 'other');
	await gitIn(f.folder, 'checkout', '-q', main);
	await writeFile(join(f.folder, 'a.md'), 'main\n');
	await gitIn(f.folder, 'commit', '-q', '-am', 'main');
	expect((await git(f.folder, ['merge', 'other'])).code).not.toBe(0);
	const result = await f.run('reading', 'touch', '--json');
	expect(result.code).toBe(2);
	expect(JSON.parse(result.stdout).error.message).toContain(
		'middle of a merge',
	);
	expect(await Bun.file(join(f.folder, 'b.md')).exists()).toBe(false);
});

test("a commit never lets go of Git's index lock while it holds it, however large the index", async () => {
	const f = await setup(
		`one:{description:'One',input:{id:field.text()},positional:['id'],run:async({id},{folder})=>{await folder.write('runs/'+id+'.txt',id)}}`,
	);
	// An index of about a megabyte, large enough that copying a file onto the lock replaced it.
	await mkdir(join(f.folder, 'many'));
	await Promise.all(
		Array.from({ length: 6000 }, (_, i) =>
			writeFile(join(f.folder, 'many', `${i}.txt`), `${i}\n`),
		),
	);
	await gitIn(f.folder, 'add', 'many');
	await gitIn(
		f.folder,
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@t',
		'commit',
		'-qm',
		'many',
	);
	const tracked = Number(
		(await gitIn(f.folder, 'ls-files')).split('\n').length,
	);
	// An agent whose `git add` takes the lock the instant it is free, writes the whole index, and renames it into place.
	const index = join(f.folder, '.git', 'index');
	let stolen = 0;
	let stop = false;
	const agent = (async () => {
		while (!stop) {
			for (let i = 0; i < 200; i++) {
				// Lock first, then read, as Git does.
				let fd: number;
				try {
					fd = openSync(`${index}.lock`, 'wx');
				} catch {
					continue;
				}
				writeSync(fd, readFileSync(index));
				closeSync(fd);
				renameSync(`${index}.lock`, index);
				stolen++;
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
	})();
	try {
		for (let run = 0; run < 15; run++) {
			const result = await f.run('reading', 'one', String(run), '--json');
			expect(result.code).toBe(0);
		}
	} finally {
		stop = true;
		await agent;
	}
	expect(stolen).toBeGreaterThan(0);
	expect((await gitIn(f.folder, 'ls-files')).split('\n').length).toBe(
		tracked + 15,
	);
}, 60_000);
