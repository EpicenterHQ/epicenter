/**
 * Real setup actions save existing routine declarations, using the installed
 * app and action table. Repeat setup keeps notes, pause settings and receipts;
 * bad references, inputs and read-only calls leave no runnable declaration.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { readMarkdown } from '@epicenter/app';
import { fixture } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

test('setup infers a symlinked installed app and saved input meets the current action code', async () => {
	const f = await fixture();
	roots.push(f.root);
	const original = await f.app(
		'original',
		`
import { routines } from '@epicenter/app';
const research = defineAction({description:'Research', input:{limit:field.number({optional:true})}, run:({limit})=>Ok(({limit: limit ?? 3}))});
export default defineApp({description:'Flights',collections:{},actions:{daily:{run:research},setup:defineAction({description:'Enable',input:{},run:async ()=>{ await routines.set('flight-research',{daily:'08:00',action:research,input:{}}); return Ok(undefined); }})}});`,
	);
	await symlink(original, join(f.apps, 'travel'));
	expect(await f.run('travel', 'setup', '--json')).toMatchObject({ code: 0 });
	const path = join(f.home, 'routines/flight-research.md');
	const fields = readMarkdown(await readFile(path, 'utf8')).fields;
	expect(fields.run).toEqual(['epicenter', 'travel', 'daily', 'run', '{}']);
	await writeFile(
		join(original, 'code/epicenter.ts'),
		(await readFile(join(original, 'code/epicenter.ts'), 'utf8')).replace(
			'limit ?? 3',
			'limit ?? 7',
		),
	);
	const run = await f.run('routines', 'run', 'flight-research', '--json');
	expect(run.code).toBe(0);
	expect(
		await readFile(
			join(f.home, 'routines/flight-research.local/output.log'),
			'utf8',
		),
	).toContain('limit: 7');
});

test('repeat setup preserves notes, pause, timeout and state and refuses a foreign command', async () => {
	const f = await fixture();
	roots.push(f.root);
	await f.app(
		'travel',
		`import {routines} from '@epicenter/app'; const research=defineAction({description:'Research',input:{},run:()=>Ok(null)}); export default defineApp({description:'Travel',collections:{},actions:{research,setup:defineAction({description:'Enable',input:{},run:async ()=>{ await routines.set('review',{daily:'08:00',action:research,input:{}}); return Ok(undefined); }})}});`,
	);
	const directory = join(f.home, 'routines');
	await mkdir(join(directory, 'review.local'), { recursive: true });
	const path = join(directory, 'review.md');
	await writeFile(
		path,
		'---\ndaily: "09:00"\nrun: ["epicenter", "travel", "research"]\npaused: true\ntimeout: "20m"\n---\nMy research instructions.\n',
	);
	const receipt = '{"completed":"2026-01-01T08:00:00.000Z"}\n';
	await writeFile(join(directory, 'review.local/state.json'), receipt);
	for (let i = 0; i < 2; i++)
		expect((await f.run('travel', 'setup')).code).toBe(0);
	const parsed = readMarkdown(await readFile(path, 'utf8'));
	expect(parsed.fields).toMatchObject({
		daily: '08:00',
		paused: true,
		timeout: '20m',
	});
	expect(parsed.body).toBe('My research instructions.\n');
	expect(
		await readFile(join(directory, 'review.local/state.json'), 'utf8'),
	).toBe(receipt);
	await writeFile(
		path,
		'---\ndaily: "08:00"\nrun: ["epicenter", "other", "research"]\n---\n',
	);
	expect((await f.run('travel', 'setup')).code).toBe(1);
	expect(readMarkdown(await readFile(path, 'utf8')).fields.run).toEqual([
		'epicenter',
		'other',
		'research',
	]);
});

test('invalid input, timing, identity and read-only setup never create a routine', async () => {
	const f = await fixture();
	roots.push(f.root);
	for (const [name, target, input, daily, annotations, aliases] of [
		['bad-input', 'research', '{limit:"three"}', '08:00', '{}', ''],
		['bad-time', 'research', '{limit:3}', '25:00', '{}', ''],
		['unknown', 'hidden', '{limit:3}', '08:00', '{}', ''],
		['ambiguous', 'research', '{limit:3}', '08:00', '{}', 'alias:research,'],
		['readonly', 'research', '{limit:3}', '08:00', '{readOnlyHint:true}', ''],
		['non-json', 'research', '{limit:NaN}', '08:00', '{}', ''],
		['private', 'secret', '{}', '08:00', '{}', 'secret,'],
	] as const) {
		await f.app(
			name,
			`import {routines} from '@epicenter/app';const research=defineAction({description:'Research',input:{limit:field.number()},run:()=>Ok(null)});const hidden=defineAction({description:'Hidden',input:{limit:field.number()},run:()=>Ok(null)});const secret=defineAction({description:'Secret',privateInput:true,input:{},run:()=>Ok(null)});export default defineApp({description:'Test',collections:{},actions:{research,${aliases}setup:defineAction({description:'Setup',annotations:${annotations},input:{},run:()=>routines.set('${name}',{daily:'${daily}',action:${target},input:${input}})})}});`,
		);
		expect((await f.run(name, 'setup')).code).toBe(1);
	}
	expect(await readdir(join(f.home, 'routines')).catch(() => [])).toEqual([]);
});
