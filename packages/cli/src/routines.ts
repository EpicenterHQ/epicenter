/**
 * Home-owned scheduled commands (ADR-0908, ADR-0937). Once a minute `serve`
 * reads `routines/` and starts each routine whose cron schedule had an
 * occurrence since its last check. It keeps that one moment in memory and
 * writes nothing: a routine file is the whole declaration, and a command's
 * deadline, overlap, output, and result are the command's own. Commands
 * inherit serve's output and process group.
 */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isName, readMarkdown } from '@epicenter/app';
import { COMPILED } from './commands.ts';
import { writeErr } from './output.ts';

type Routine = {
	cron: string;
	run: [string, ...string[]];
};

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** Read a routine file: a cron schedule and the command to run. */
export function readRoutine(name: string, text: string): Routine {
	if (!isName(name))
		throw new Error(
			'A routine name must be lowercase letters, digits, and dashes',
		);
	const parsed = readMarkdown(text);
	const { cron, run, ...other } = parsed.fields;
	if (
		!parsed.readable ||
		parsed.notJson.length ||
		Object.keys(other).length ||
		typeof cron !== 'string' ||
		!Array.isArray(run) ||
		!run.length ||
		run[0] === '' ||
		!run.every((word) => typeof word === 'string' && !word.includes('\0'))
	)
		throw new Error(
			`${name}.md needs exactly cron: "<minute hour day month weekday>" and run: [executable, ...arguments]`,
		);
	let next: Date | null;
	try {
		next = Bun.cron.parse(cron);
	} catch {
		next = null;
	}
	if (!next)
		throw new Error(
			`${name}.md cron must be a five-field cron expression such as "0 8 * * *" with a future occurrence`,
		);
	return { cron, run: run as [string, ...string[]] };
}

/**
 * Read and start one home's routines. `check` starts each routine with an
 * occurrence since the previous check, and never waits for it.
 */
export function createRoutines({
	folder,
	serviceUrl,
}: {
	folder: string;
	serviceUrl?: string;
}) {
	const directory = join(folder, 'routines');
	const epicenter: [string, ...string[]] = COMPILED
		? [process.execPath]
		: [process.execPath, fileURLToPath(new URL('./bin.ts', import.meta.url))];
	// The only state: an occurrence that passes while serve is down does not run.
	let since = new Date();

	async function names() {
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

	async function read(name: string) {
		return readRoutine(
			name,
			await readFile(join(directory, `${name}.md`), 'utf8'),
		);
	}

	function start(name: string, { run }: Routine) {
		const [program, ...args] = run;
		const argv =
			program === 'epicenter'
				? [...epicenter, ...args]
				: program === 'bun'
					? [process.execPath, ...args]
					: run;
		spawn(argv[0] as string, argv.slice(1), {
			cwd: folder,
			env: {
				...process.env,
				...(program === 'bun' ? { BUN_BE_BUN: '1' } : {}),
				EPICENTER_ROOT: folder,
				EPICENTER_COMMAND: JSON.stringify(epicenter),
				...(serviceUrl ? { EPICENTER_SERVICE_URL: serviceUrl } : {}),
			},
			stdio: 'inherit',
		}).once('error', (error) =>
			writeErr(`Routine ${name} could not start: ${messageOf(error)}`),
		);
	}

	return {
		/** Each routine's schedule and next occurrence, or why its file is refused. */
		async list(now = new Date()) {
			return Promise.all(
				(await names()).map(async (name) => {
					try {
						const { cron } = await read(name);
						return {
							name,
							cron,
							next: Bun.cron.parse(cron, now)?.toISOString(),
						};
					} catch (error) {
						return { name, problem: messageOf(error) };
					}
				}),
			);
		},
		/** Start each routine with an occurrence in (previous check, now]. */
		async check(now = new Date()) {
			const from = since;
			since = now;
			for (const name of await names()) {
				let routine: Routine;
				try {
					routine = await read(name);
				} catch (error) {
					writeErr(`Routine ${name}: ${messageOf(error)}`);
					continue;
				}
				const next = Bun.cron.parse(routine.cron, from);
				if (next && next <= now) start(name, routine);
			}
		},
	};
}
