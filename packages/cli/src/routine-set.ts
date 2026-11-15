/** Save a typed app action as the home runner's existing daily command. */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isName, type Routine, readMarkdown } from '@epicenter/app';
import type { Runnable } from './home.js';
import { checkInput } from './input.js';
import { hold, LOCK_WAIT_MS } from './lock.js';
import { epicenterDir } from './root.js';
import { readRoutine } from './routines.js';

/** Resolve against this load's action table; never import or register another target. */
export async function setRoutine({
	app,
	name,
	routine,
}: {
	app: Pick<Runnable, 'name' | 'actions'>;
	name: string;
	routine: Routine;
}) {
	if (!isName(name))
		throw new Error(
			'A routine name must be lowercase letters, digits, and dashes',
		);
	const matches = Object.entries(app.actions).filter(
		([, action]) => action === routine.action,
	);
	const match = matches.length === 1 ? matches[0] : undefined;
	if (!match)
		throw new Error(
			'A routine needs an action exposed exactly once by the current app',
		);
	const [key, action] = match;
	if (action.privateInput)
		throw new Error('A routine cannot save an action with private input');
	const json = JSON.stringify(routine.input);
	if (json === undefined || !isDeepStrictEqual(routine.input, JSON.parse(json)))
		throw new Error('A routine input must contain only JSON values');
	const checked = checkInput(action, JSON.parse(json), (field) => field);
	if ('error' in checked) throw new Error(checked.error);
	const run = ['epicenter', app.name, ...key.split(' '), '--input', json];
	const fields = {
		daily: routine.daily,
		run,
		...(routine.paused === undefined ? {} : { paused: routine.paused }),
		...(routine.timeout === undefined ? {} : { timeout: routine.timeout }),
	};
	const markdown = (fields: Record<string, unknown>, body: string) =>
		`---\n${Object.entries(fields)
			.map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
			.join('')}---\n${body}`;
	// Validate before creating a directory or changing any existing declaration.
	readRoutine(name, markdown(fields, ''));
	const directory = join(epicenterDir(), 'routines');
	await mkdir(directory, { recursive: true });
	const held = await hold(directory, LOCK_WAIT_MS);
	if (!held) throw new Error('The routine declarations are busy; try again');
	const path = join(directory, `${name}.md`);
	const temporary = join(directory, `${randomUUID()}.local.tmp`);
	try {
		let previous: string | undefined;
		try {
			previous = await readFile(path, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const parsed = readMarkdown(previous ?? '');
		if (previous !== undefined) {
			const current = readRoutine(name, previous);
			if (current.run[0] !== 'epicenter' || current.run[1] !== app.name)
				throw new Error(
					`${name} already runs another command; choose another routine name`,
				);
		}
		const text = markdown({ ...parsed.fields, ...fields }, parsed.body);
		if (text !== previous) {
			const file = await open(temporary, 'wx', 0o600);
			try {
				await file.writeFile(text);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
		}
		return { name, path: `routines/${name}.md` };
	} finally {
		await rm(temporary, { force: true });
		held.release();
	}
}
