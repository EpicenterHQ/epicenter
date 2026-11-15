/**
 * Home-owned daily commands (ADR-0908). `serve` checks on startup and once a
 * minute; commands run in their own process groups. The directory lock covers
 * an entire attempt, shared by scheduled and foreground runs. State is replaced
 * atomically before and after execution; an unfinished attempt needs a person's
 * explicit rerun, because its effects may already have happened.
 * The lock owns exclusion; one shutdown signal cancels this runner's work.
 * Pending promises exist only so shutdown can wait for it to settle.
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
import { hold } from './lock.ts';
import { fail, writeErr, writeJson, writeOut } from './output.ts';
import { epicenterDir, epicenterRoot } from './root.ts';

type Routine = {
	daily: string;
	run: [string, ...string[]];
	paused: boolean;
	timeoutMs: number;
};

const attemptSchema = Type.Object(
	{
		slot: Type.String(),
		started: Type.String(),
		outcome: Type.Union([
			Type.Literal('running'),
			Type.Literal('succeeded'),
			Type.Literal('failed'),
			Type.Literal('interrupted'),
		]),
		pid: Type.Optional(Type.Integer({ minimum: 1 })),
		finished: Type.Optional(Type.String()),
		exitCode: Type.Optional(Type.Integer()),
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
const stateSchema = Type.Object(
	{
		completed: Type.Optional(Type.String()),
		attempt: Type.Optional(attemptSchema),
	},
	{ additionalProperties: false },
);
type Attempt = Static<typeof attemptSchema>;
type State = Static<typeof stateSchema>;

const DAILY = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === 'ENOENT';
const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
const isMoment = (value: unknown): value is string =>
	typeof value === 'string' &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString() === value;

/** A daily occurrence is a local calendar time, not 24 hours after a run. */
function latestSlot(daily: string, now: Date) {
	const slot = new Date(now);
	const hour = Number(daily.slice(0, 2));
	const minute = Number(daily.slice(3));
	slot.setHours(hour, minute, 0, 0);
	if (slot > now) {
		slot.setDate(slot.getDate() - 1);
		// A skipped time may have normalized the hour on today's date.
		slot.setHours(hour, minute, 0, 0);
	}
	return slot.toISOString();
}

/** A scheduled check may run exactly when the status shown to the person is due. */
function statusOf(routine: Routine, state: State, slot: string) {
	const attempt = state.attempt;
	if (attempt?.outcome === 'running') return 'running';
	if (routine.paused) return 'paused';
	if (attempt?.outcome === 'interrupted') return 'interrupted';
	if (attempt?.slot === slot) return attempt.outcome;
	if (state.completed && Date.parse(state.completed) >= Date.parse(slot))
		return 'succeeded';
	return 'due';
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
		![
			value.completed,
			value.attempt?.slot,
			value.attempt?.started,
			value.attempt?.finished,
		].every((moment) => moment === undefined || isMoment(moment))
	)
		throw new Error(
			'state.json has invalid fields or timestamps; inspect it before running again',
		);
	return value;
}

async function writeState(directory: string, state: State) {
	const temporary = join(directory, `${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, 'wx', 0o600);
		try {
			await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(directory, 'state.json'));
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Read the declaration shared by the setter and runner. */
export function readRoutine(name: string, text: string): Routine {
	if (!isName(name))
		throw new Error(
			'A routine name must be lowercase letters, digits, and dashes',
		);
	const parsed = readMarkdown(text);
	const { daily, run, paused, timeout = '30m', ...other } = parsed.fields;
	if (
		!parsed.readable ||
		Object.keys(other).length ||
		typeof daily !== 'string' ||
		!DAILY.test(daily) ||
		!Array.isArray(run) ||
		!run.length ||
		run[0] === '' ||
		!run.every((word) => typeof word === 'string' && !word.includes('\0')) ||
		(paused !== undefined && typeof paused !== 'boolean')
	)
		throw new Error(
			`${name}.md needs daily: "HH:MM", run: [executable, ...arguments], and only optional paused and timeout fields`,
		);
	const duration =
		typeof timeout === 'string' ? /^([1-9][0-9]*)(s|m|h)$/.exec(timeout) : null;
	const timeoutMs = duration
		? Number(duration[1]) *
			{ s: 1000, m: 60_000, h: 3_600_000 }[duration[2] as 's' | 'm' | 'h']
		: 0;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 2_147_483_647
	)
		throw new Error(
			`${name}.md timeout must be a positive duration such as "30m" (at most 596 hours)`,
		);
	return {
		daily,
		run: run as [string, ...string[]],
		paused: paused === true,
		timeoutMs,
	};
}

/**
 * Own the attempts for one home. A check launches work without awaiting it;
 * `run` awaits the same execution path. `stop` cancels and reaps owned commands.
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
	const stopping = new AbortController();
	const pending = new Set<Promise<State | undefined>>();
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

	async function execute(name: string, manual: boolean, now: Date) {
		stopping.signal.throwIfAborted();
		const routine = await read(name);
		stopping.signal.throwIfAborted();
		const local = stateDirectory(name);
		await mkdir(local, { recursive: true, mode: 0o700 });
		const held = await hold(local, 0);
		if (!held) {
			if (manual) throw new Error(`${name} is already running`);
			return;
		}
		try {
			const state = await readState(local);
			if (state.attempt?.outcome === 'running') {
				state.attempt.outcome = 'interrupted';
				state.attempt.message =
					'The previous supervisor stopped; outcome unknown. Inspect the log before rerunning.';
				await writeState(local, state);
			}
			const slot = latestSlot(routine.daily, now);
			if (
				!manual &&
				(stopping.signal.aborted || statusOf(routine, state, slot) !== 'due')
			)
				return;

			const attempt: Attempt = {
				slot,
				started: now.toISOString(),
				outcome: 'running',
			};
			state.attempt = attempt;
			await writeState(local, state);
			const log = await open(join(local, 'output.log'), 'a', 0o600);
			let child: ReturnType<typeof spawn> | undefined;
			let exited:
				| Promise<{ code: number | null; signal: NodeJS.Signals | null }>
				| undefined;
			let stopReason: 'timeout' | 'shutdown' | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let killing: ReturnType<typeof setTimeout> | undefined;
			const signalFailures: string[] = [];
			const signal = (kind: NodeJS.Signals) => {
				if (child?.pid === undefined) return;
				try {
					process.kill(-child.pid, kind);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
						signalFailures.push(
							`Could not signal command group ${child.pid} with ${kind}: ${(error as NodeJS.ErrnoException).code ?? messageOf(error)}; descendant cleanup is unconfirmed`,
						);
				}
			};
			const cancel = (reason: 'timeout' | 'shutdown') => {
				stopReason ??= reason;
				signal('SIGTERM');
				killing ??= setTimeout(() => signal('SIGKILL'), 2000);
			};
			const onStop = () => cancel('shutdown');
			stopping.signal.addEventListener('abort', onStop);
			try {
				await log.writeFile(
					`\n${attempt.started} slot ${slot}\n${JSON.stringify(routine.run)}\n`,
				);
				stopping.signal.throwIfAborted();
				const [program, ...args] = routine.run;
				const argv: [string, ...string[]] =
					program === 'epicenter'
						? [...epicenter, ...args]
						: program === 'bun'
							? [process.execPath, ...args]
							: routine.run;
				const command = spawn(argv[0], argv.slice(1), {
					cwd: folder,
					env: {
						...process.env,
						...(program === 'bun' ? { BUN_BE_BUN: '1' } : {}),
						EPICENTER_ROOT: folder,
						EPICENTER_COMMAND: JSON.stringify(epicenter),
						...(serviceUrl ? { EPICENTER_SERVICE_URL: serviceUrl } : {}),
						EPICENTER_ROUTINE_SLOT: slot,
						EPICENTER_ROUTINE_NAME: name,
					},
					detached: true,
					// Keep exclusion even if the supervisor is killed before recording a PID.
					// Programs must leave fd 3 open and remain in this process group.
					stdio: ['ignore', log.fd, log.fd, held.fd],
				});
				child = command;
				// Register listeners before awaiting the state write: spawn errors may be immediate.
				exited = new Promise<{
					code: number | null;
					signal: NodeJS.Signals | null;
				}>((resolve, reject) => {
					command.once('error', reject);
					command.once('exit', (code, signal) => resolve({ code, signal }));
				});
				// Observe a spawn rejection even if persisting its PID fails first.
				void exited.catch(() => {});
				attempt.pid = child.pid;
				await writeState(local, state);
				timer = setTimeout(() => cancel('timeout'), routine.timeoutMs);
				const result = await exited;
				attempt.exitCode = result.code ?? undefined;
				attempt.outcome =
					stopReason === 'shutdown'
						? 'interrupted'
						: result.code === 0 && !stopReason
							? 'succeeded'
							: 'failed';
				if (stopReason === 'timeout')
					attempt.message = 'The command exceeded its timeout';
				else if (stopReason === 'shutdown')
					attempt.message = 'Epicenter stopped the command; outcome unknown';
				else if (result.signal)
					attempt.message = `The command ended on ${result.signal}`;
			} catch (error) {
				attempt.outcome = stopping.signal.aborted ? 'interrupted' : 'failed';
				attempt.message = messageOf(error);
				await log.writeFile(`${attempt.message}\n`);
			} finally {
				stopping.signal.removeEventListener('abort', onStop);
				clearTimeout(timer);
				clearTimeout(killing);
				// Descendants must not outlive a completed attempt or overlap its successor.
				signal('SIGKILL');
				await exited?.catch(() => {});
				try {
					if (signalFailures.length) {
						attempt.outcome = 'interrupted';
						attempt.message = [attempt.message, ...signalFailures]
							.filter(Boolean)
							.join('; ');
						await log.writeFile(`${signalFailures.join('\n')}\n`);
					}
				} finally {
					await log.close();
				}
			}
			if (attempt.outcome === 'succeeded') state.completed = slot;
			attempt.finished = new Date().toISOString();
			await writeState(local, state);
			return state;
		} finally {
			held.release();
		}
	}

	function start(name: string, manual: boolean, now: Date) {
		const done: Promise<State | undefined> = execute(name, manual, now).finally(
			() => pending.delete(done),
		);
		pending.add(done);
		return done;
	}

	return {
		/** Inspect declarations and durable outcomes even while serve is stopped. */
		async list(now = new Date()) {
			return Promise.all(
				(await names()).map(async (name) => {
					const log = join('routines', `${name}.local`, 'output.log');
					try {
						const routine = await read(name);
						let state = await readState(stateDirectory(name));
						const slot = latestSlot(routine.daily, now);
						if (state.attempt?.outcome === 'running') {
							const held = await hold(stateDirectory(name), 0);
							if (held) {
								try {
									// It may have finished between our read and acquiring the lock.
									state = await readState(stateDirectory(name));
									if (state.attempt?.outcome === 'running')
										state = {
											...state,
											attempt: { ...state.attempt, outcome: 'interrupted' },
										};
								} finally {
									held.release();
								}
							}
						}
						return {
							name,
							daily: routine.daily,
							paused: routine.paused,
							status: statusOf(routine, state, slot),
							slot,
							...state,
							log,
						};
					} catch (error) {
						return { name, status: 'invalid', problem: messageOf(error), log };
					}
				}),
			);
		},
		/** Start each eligible command without waiting on other commands or backups. */
		async check(now = new Date()) {
			if (stopping.signal.aborted) return;
			for (const name of await names()) {
				void start(name, false, now).catch((error) => {
					if (stopping.signal.aborted && error === stopping.signal.reason)
						return;
					writeErr(`${name}: ${messageOf(error)}`);
				});
			}
		},
		/** An explicit rerun may repeat effects; the same lock prevents simultaneous attempts. */
		async run(name: string, now = new Date()) {
			return await start(name, true, now);
		},
		async stop() {
			stopping.abort(new Error('Epicenter is stopping'));
			await Promise.allSettled(pending);
		},
	};
}

/** Foreground inspection and repair use the same executor as serve. */
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
									`${row.name}: ${row.status}${'daily' in row ? ` (daily ${row.daily})` : ''}\n  ${'problem' in row ? row.problem : JSON.stringify(row.attempt ?? { completed: row.completed })}\n  Log: ${row.log}`,
							)
							.join('\n')
					: 'No routines. Add routines/<name>.md with daily and run.',
			);
		return rows.some((row) => row.status === 'invalid') ? 1 : 0;
	}
	const name = given.positionals[1];
	if (!name) return fail(misuse('routines'), json);
	const stop = () => {
		void routines.stop();
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	try {
		const result = await routines.run(name);
		if (json) writeJson(result);
		else
			writeOut(
				`${name}: ${result?.attempt?.outcome}\nLog: routines/${name}.local/output.log`,
			);
		return result?.attempt?.outcome === 'succeeded' ? 0 : 1;
	} catch (error) {
		return fail(CliError.Refused({ message: messageOf(error) }).error, json);
	} finally {
		process.removeListener('SIGINT', stop);
		process.removeListener('SIGTERM', stop);
		await routines.stop();
	}
}
