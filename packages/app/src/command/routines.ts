/**
 * Scheduled actions an Epicenter owns (ADR-0908, ADR-0937, ADR-0959). A file
 * in `routines/` names one action of a loaded app, its input, and a cron
 * schedule:
 *
 * ```yaml
 * ---
 * cron: "0 8 * * *"
 * action: "flights daily"
 * input: {"recheck": false}
 * ---
 * ```
 *
 * Serve reads the files once, when it starts, and checks each against the
 * apps it loaded: an unknown app or action, or an input that does not fit,
 * is the routine's problem from then until serve restarts. Once a minute
 * serve runs each routine whose schedule had an occurrence since its last
 * check, through the same `runAction` an HTTP call uses, so its run leaves
 * the same record. It keeps that one moment in memory and writes nothing.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { isName } from '../app.ts';
import { readMarkdown } from '../front-matter.ts';
import type { Apps } from './apps.ts';
import type { RoutineRow } from './protocol.ts';
import { type EpicenterRoot, fromRoot } from './root.ts';
import { type Call, checkCall, findAction, runAction } from './run.ts';

/** A routine as serve read it at start: the call it makes, or why its file is refused. */
export type Routine =
	| { name: string; cron: string; call: Call }
	| { name: string; problem: string };

/** Each routine file's name in `routines/`, without `.md`, in name order; none when there is no folder. */
async function routineNames(directory: string) {
	try {
		return (await readdir(directory, { withFileTypes: true }))
			.filter(
				(entry) =>
					entry.isFile() &&
					entry.name.endsWith('.md') &&
					isName(entry.name.slice(0, -3)),
			)
			.map((entry) => entry.name.slice(0, -3))
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

/** The routine file `name`, checked against `apps`. */
function readRoutine(apps: Apps, name: string, text: string): Routine {
	const refused = (problem: string) => ({ name, problem });
	const parsed = readMarkdown(text);
	const { cron, action, input = {}, ...other } = parsed.fields;
	const [app = '', named = '', ...more] =
		typeof action === 'string' ? action.split(' ') : [];
	if (
		!parsed.readable ||
		parsed.notJson.length ||
		Object.keys(other).length ||
		typeof cron !== 'string' ||
		more.length ||
		!isName(app) ||
		!isName(named)
	)
		return refused(
			'needs exactly cron: "<minute hour day month weekday>" and action: "<app> <action>", and may have input: {...}',
		);
	let next: Date | null;
	try {
		next = Bun.cron.parse(cron);
	} catch {
		next = null;
	}
	if (!next)
		return refused(
			'cron must be a five-field cron expression such as "0 8 * * *" with a future occurrence',
		);
	const { data: found, error } = findAction(apps, app, named);
	if (error) return refused(error.message);
	const { data: call, error: misfit } = checkCall(found, { value: input });
	if (misfit) return refused(`input: ${misfit.message}`);
	return { name, cron, call };
}

/** Read every routine file once, checked against the apps serve loaded. */
export async function readRoutines(
	root: Pick<EpicenterRoot, 'folder'>,
	apps: Apps,
): Promise<Routine[]> {
	const directory = join(root.folder, 'routines');
	return Promise.all(
		(await routineNames(directory)).map(async (name) => {
			try {
				const text = await readFile(join(directory, `${name}.md`), 'utf8');
				return readRoutine(apps, name, text);
			} catch (error) {
				return { name, problem: fromRoot(root, extractErrorMessage(error)) };
			}
		}),
	);
}

/** Each routine as the listing shows it, with its next occurrence after `now`. */
export function routineRows(
	routines: Routine[],
	now = new Date(),
): RoutineRow[] {
	return routines.map((routine) => {
		if ('problem' in routine) return routine;
		const { name, cron, call } = routine;
		return {
			name,
			cron,
			next: Bun.cron.parse(cron, now)?.toISOString(),
			app: call.app,
			action: call.action,
			input: call.input,
		};
	});
}

/**
 * Start the routine clock: once a minute, run each routine with an
 * occurrence since the previous check, never waiting for it. Runs may
 * overlap. `log` is where each run's record goes, as for a call.
 */
export function startRoutines(
	routines: Routine[],
	{ log }: { log?: Logger } = {},
) {
	// The only state: an occurrence that passes while serve is down does not run.
	let since = new Date();
	/** Run each routine with an occurrence in (previous check, now]. */
	const check = (now = new Date()) => {
		const from = since;
		since = now;
		for (const routine of routines) {
			if ('problem' in routine) continue;
			const next = Bun.cron.parse(routine.cron, from);
			if (next && next <= now) void runAction(routine.call, { log });
		}
	};
	const clock = setInterval(check, 60_000);
	clock.unref();
	return {
		check,
		/** Stop the clock. A run already started goes on until serve exits. */
		stop: () => clearInterval(clock),
	};
}
