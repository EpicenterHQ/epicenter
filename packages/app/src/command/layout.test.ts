/** Every folder in apps/ is an app or its problems; a broken one is listed beside the apps that load, and a link is refused. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, startServe } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const code = `export default defineApp(({ folder }) => ({description:'X',actions:{put:defineAction({description:'Write',input:{},run:async()=>{await folder.write('data/record.md','record');return Ok(folder.path);}})}}));`;
test('missing and broken code entries list problems without stopping the apps that load; a top-level epicenter.ts is not an app', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app('valid', code);
	await f.folder(join(f.apps, 'legacy'), {
		'epicenter.ts': 'throw new Error("never import")',
	});
	await f.folder(join(f.apps, 'missing'), { 'data/a.md': 'record' });
	await f.folder(join(f.apps, 'broken'), {
		'code/epicenter.ts': 'throw new Error("broken")',
	});
	const listed = await f.run('--json');
	expect(listed.code).toBe(0);
	const result = JSON.parse(listed.stdout).data;
	expect(result.apps.map((app: { name: string }) => app.name)).toEqual([
		'valid',
	]);
	expect(result.problems).toEqual([
		{
			entry: 'broken',
			folder: join(f.apps, 'broken'),
			problems: ['code/epicenter.ts: broken'],
		},
		{
			entry: 'legacy',
			folder: join(f.apps, 'legacy'),
			problems: ['no code/epicenter.ts'],
		},
		{
			entry: 'missing',
			folder: join(f.apps, 'missing'),
			problems: ['no code/epicenter.ts'],
		},
	]);
	// The app that loaded still runs.
	expect((await f.run('valid', 'put', '--json')).code).toBe(0);
});

test('a link at apps/, an app folder, or its code/, data/ or local/ is refused, and the apps beside it load', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app('valid', code);
	const shelf = await f.app('shelved', code, join(f.epicenter, 'shelf'));
	await symlink(shelf, join(f.apps, 'shelved'));
	// A real app folder whose data/ or local/ is a link elsewhere.
	const outside = join(f.epicenter, 'outside');
	await f.folder(outside, { 'data/record.md': 'record' });
	await f.app('records', code);
	await symlink(join(outside, 'data'), join(f.apps, 'records', 'data'));
	await f.app('keys', code);
	await symlink(outside, join(f.apps, 'keys', 'local'));
	const result = JSON.parse((await f.run('--json')).stdout).data;
	expect(result.apps.map((app: { name: string }) => app.name)).toEqual([
		'valid',
	]);
	const rule =
		"is a link; apps/, an app's folder, and its code/, data/ and local/ must be real folders";
	expect(
		result.problems.map((each: { entry: string; problems: string[] }) => [
			each.entry,
			each.problems,
		]),
	).toEqual([
		['keys', [`apps/keys/local ${rule}`]],
		['records', [`apps/records/data ${rule}`]],
		['shelved', [`apps/shelved ${rule}`]],
	]);
	expect(await f.run('shelved', 'put', '--json')).toMatchObject({ code: 2 });
	expect(await f.run('records', 'put', '--json')).toMatchObject({ code: 2 });
	expect(await Bun.file(join(shelf, 'data/record.md')).exists()).toBe(false);
	// A linked apps/ stops serve before it loads any app.
	const g = await fixture();
	roots.push(g.userDir);
	await g.app('valid', code, join(g.epicenter, 'real'));
	await rm(g.apps, { recursive: true, force: true });
	await symlink(join(g.epicenter, 'real', 'apps'), g.apps);
	await expect(startServe(g)).rejects.toThrow(`apps ${rule}`);
});
