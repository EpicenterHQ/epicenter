/**
 * Home-owned scheduled commands (ADR-0908, ADR-0937). `serve` checks on
 * startup and once a minute and starts each due routine as a child process.
 * A routine is due when its cron schedule has had an occurrence since its last
 * start, so a run that did not succeed waits for the next occurrence. Runs
 * may overlap: the runner keeps no lock, timeout, or kill path. A command
 * that needs a deadline or must not overlap itself arranges that itself.
 * Children share serve's process group, so they end with it.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isName, readMarkdown } from '@epicenter/app';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { COMPILED, misuse, parseWords } from './commands.ts';
import { CliError } from './errors.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { epicenterDir, epicenterRoot } from './root.ts';

type Routine = {
	cron: string;
	run: [string, ...string[]];
};

/** The last start; `finished` is absent while it runs or if its runner ended first. */
const stateSchema = Type.Object(
	{
		started: Type.Optional(Type.String()),
		finished: Type.Optional(Type.String()),
		exitCode: Type.Optional(Type.Integer()),
	},
	{ additionalProperties: false },
);
type State = Static<typeof stateSchema>;

const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === 'ENOENT';
const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
const isMoment = (value: unknown): value is string =>
	typeof value === 'string' &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString() === value;

/**
 * Missed occurrences collapse into the first one after the last start. A last
 * start in the future means the clock moved back, so it does not hold the
 * routine.
 */
function statusOf(routine: Routine, state: State, now: Date) {
	if (!state.started || Date.parse(state.started) > now.getTime()) return 'due';
	const next = Bun.cron.parse(routine.cron, new Date(state.started));
	if (next && next <= now) return 'due';
	if (!state.finished) return 'running';
	return state.exitCode === 0 ? 'succeeded' : 'failed';
}

async function readState(directory: string): Promise<State> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
	} catch (error) {
		if (missing(error)) return {};
		throw error;
	}
	if (
		!Value.Check(stateSchema, value) ||
		![value.started, value.finished].every(
			(moment) => moment === undefined || isMoment(moment),
		)
	)
		throw new Error(
			`${join(directory, 'state.json')} has invalid fields or timestamps; delete it to start the routine fresh`,
		);
	return value;
}

async function writeState(directory: string, state: State) {
	const temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		await Bun.write(temporary, `${JSON.stringify(state, null, 2)}\n`);
		await rename(temporary, join(directory, 'state.json'));
	} finally {
		await rm(temporary, { force: true });
	}
}

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
 * Run the routines of one home. `check` starts due routines without waiting
 * for them; `run` starts one now and waits for it.
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
	const stateDirectory = (name: string) => join(directory, `${name}.local`);

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
			if (missing(error)) return [];
			throw error;
		}
	}

	async function read(name: string) {
		if (!isName(name))
			throw new Error(
				'A routine name must be lowercase letters, digits, and dashes',
			);
		return readRoutine(
			name,
			await readFile(join(directory, `${name}.md`), 'utf8'),
		);
	}

	/**
	 * Start the command, record the start, and record how it ended unless a
	 * later run has started since.
	 */
	async function execute(name: string, routine: Routine, now: Date) {
		const local = stateDirectory(name);
		await mkdir(local, { recursive: true, mode: 0o700 });
		const state: State = { started: now.toISOString() };
		await writeState(local, state);
		// A start empties the log; every run appends, so an earlier run still
		// going writes after this one's header.
		const logPath = join(local, 'output.log');
		await Bun.write(
			logPath,
			`${state.started} started ${JSON.stringify(routine.run)}\n`,
		);
		const log = await open(logPath, 'a', 0o600);
		try {
			const [program, ...args] = routine.run;
			const argv: [string, ...string[]] =
				program === 'epicenter'
					? [...epicenter, ...args]
					: program === 'bun'
						? [process.execPath, ...args]
						: routine.run;
			const { code, signal } = await new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
			}>((resolve, reject) => {
				spawn(argv[0], argv.slice(1), {
					cwd: folder,
					env: {
						...process.env,
						...(program === 'bun' ? { BUN_BE_BUN: '1' } : {}),
						EPICENTER_ROOT: folder,
						EPICENTER_COMMAND: JSON.stringify(epicenter),
						...(serviceUrl ? { EPICENTER_SERVICE_URL: serviceUrl } : {}),
						EPICENTER_ROUTINE_NAME: name,
					},
					stdio: ['ignore', log.fd, log.fd],
				})
					.once('error', reject)
					.once('exit', (code, signal) => resolve({ code, signal }));
			});
			if (code !== null) state.exitCode = code;
			await log.writeFile(
				`${state.started} ended ${signal ? `on ${signal}` : `with ${code}`}\n`,
			);
		} catch (error) {
			await log.writeFile(`${state.started} ${messageOf(error)}\n`);
		} finally {
			await log.close();
		}
		state.finished = new Date().toISOString();
		const current = await readState(local).catch(() => ({}) as State);
		if (current.started === state.started) await writeState(local, state);
		return state;
	}

	async function start(name: string, manual: boolean, now: Date) {
		const routine = await read(name);
		const state = await readState(stateDirectory(name));
		if (!manual && statusOf(routine, state, now) !== 'due') return;
		return await execute(name, routine, now);
	}

	return {
		/** Show each routine's schedule, last run, and status, with or without serve. */
		async list(now = new Date()) {
			return Promise.all(
				(await names()).map(async (name) => {
					const log = join('routines', `${name}.local`, 'output.log');
					try {
						const routine = await read(name);
						const state = await readState(stateDirectory(name));
						return {
							name,
							cron: routine.cron,
							status: statusOf(routine, state, now),
							...state,
							log,
						};
					} catch (error) {
						return { name, status: 'invalid', problem: messageOf(error), log };
					}
				}),
			);
		},
		/** Start each due routine without waiting for any of them. */
		async check(now = new Date()) {
			for (const name of await names()) {
				void start(name, false, now).catch((error) =>
					writeErr(`${name}: ${messageOf(error)}`),
				);
			}
		},
		/** Run one routine now, whether or not it is due, and wait for it. */
		run(name: string, now = new Date()) {
			return start(name, true, now);
		},
	};
}

/** Inspect routines, or run one in the foreground through the same path serve uses. */
export async function routinesCommand(words: string[], json: boolean) {
	const given = parseWords(words, {}, [0, 2]);
	if (!given || (given.positionals.length && given.positionals[0] !== 'run'))
		return fail(misuse('routines'), json);
	const routines = createRoutines({
		folder: epicenterDir(),
		serviceUrl: `http://127.0.0.1:${epicenterRoot().port}/`,
	});
	if (!given.positionals.length) {
		const rows = await routines.list();
		if (json) writeJson(rows);
		else
			writeOut(
				rows.length
					? rows
							.map(
								(row) =>
									`${row.name}: ${row.status}${'cron' in row ? ` (cron ${row.cron})` : ''}\n  ${'problem' in row ? row.problem : `started ${row.started ?? 'never'}, exit ${row.exitCode ?? 'none'}`}\n  Log: ${row.log}`,
							)
							.join('\n')
					: 'No routines. Add routines/<name>.md with cron and run.',
			);
		return rows.some((row) => row.status === 'invalid') ? 1 : 0;
	}
	const name = given.positionals[1];
	if (!name) return fail(misuse('routines'), json);
	try {
		const result = await routines.run(name);
		if (json) writeJson(result);
		else
			writeOut(
				`${name}: exit ${result?.exitCode ?? 'unknown'}\nLog: routines/${name}.local/output.log`,
			);
		return result?.exitCode === 0 ? 0 : 1;
	} catch (error) {
		return fail(CliError.Refused({ message: messageOf(error) }).error, json);
	}
}
