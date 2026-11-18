/**
 * Home-owned scheduled commands (ADR-0908, ADR-0937). Once a minute `serve`
 * reads `routines/` and starts each routine whose cron schedule had an
 * occurrence since its last check. It keeps that one moment in memory and
 * writes nothing: a routine file is the whole declaration, and a command's
 * deadline, overlap, output, and result are the command's own. Commands
 * inherit serve's output and process group, and find programs on serve's
 * `PATH` with the home's `node_modules/.bin` and Bun's folder first.
 */
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { isName, readMarkdown } from '@epicenter/app';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { stderrJsonLines } from './output.ts';

/** `run` is the command's words: the program, then each argument as text. */
type Routine = {
	cron: string;
	run: [string, ...string[]];
};

/** `words` as one line a POSIX shell reads back as the same words. */
function shellLine(words: string[]): string {
	return words
		.map((word) =>
			/^[\w@%+=:,./-]+$/.test(word)
				? word
				: `'${word.replaceAll("'", `'\\''`)}'`,
		)
		.join(' ');
}

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** Why a routine did not run. Serve logs it and keeps its clock going. */
const RoutineError = defineErrors({
	Unreadable: ({ routine, cause }: { routine: string; cause: unknown }) => ({
		message: `Routine ${routine}: ${messageOf(cause)}`,
		routine,
	}),
	CouldNotStart: ({ routine, cause }: { routine: string; cause: unknown }) => ({
		message: `Routine ${routine} could not start: ${messageOf(cause)}`,
		routine,
	}),
});

/** Serve's record of routines it could not run, beside its run records. */
const log = createLogger('cli/routines', stderrJsonLines);

/**
 * Read a routine file: a cron schedule and the command to run. The program
 * is text; an argument is text, or any other JSON value, which becomes one
 * word of JSON text.
 */
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
		typeof run[0] !== 'string' ||
		run[0] === '' ||
		run.some((word) => typeof word === 'string' && word.includes('\0'))
	)
		throw new Error(
			`${name}.md needs exactly cron: "<minute hour day month weekday>" and run: [program, ...arguments], where the program is text and an argument is text or a JSON value`,
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
	const words = run.map((word) =>
		typeof word === 'string' ? word : JSON.stringify(word),
	);
	return { cron, run: words as [string, ...string[]] };
}

/**
 * Read and start one home's routines. `check` starts each routine with an
 * occurrence since the previous check, and never waits for it.
 */
export function createRoutines({ folder }: { folder: string }) {
	const directory = join(folder, 'routines');
	// A routine finds commands the way a terminal in the home would after
	// `bun install`: the home's own commands first, then the Bun running serve.
	const PATH = [
		join(folder, 'node_modules', '.bin'),
		dirname(process.execPath),
		process.env.PATH,
	]
		.filter(Boolean)
		.join(delimiter);
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
		// The working directory already names the Epicenter, so the command
		// needs no variable to find it. No caller receives a failure to start,
		// so it is logged here, and the routine tries again at its next time.
		try {
			Bun.spawn(run, {
				cwd: folder,
				env: { ...process.env, PATH },
				stdio: ['ignore', 'inherit', 'inherit'],
			});
		} catch (error) {
			log.warn(
				RoutineError.CouldNotStart({ routine: name, cause: error }).error,
			);
		}
	}

	return {
		/** Each routine's schedule, next occurrence, and command as a shell line, or why its file is refused. */
		async list(now = new Date()) {
			return Promise.all(
				(await names()).map(async (name) => {
					try {
						const { cron, run } = await read(name);
						return {
							name,
							cron,
							next: Bun.cron.parse(cron, now)?.toISOString(),
							command: shellLine(run),
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
					log.warn(
						RoutineError.Unreadable({ routine: name, cause: error }).error,
					);
					continue;
				}
				const next = Bun.cron.parse(routine.cron, from);
				if (next && next <= now) start(name, routine);
			}
		},
	};
}
