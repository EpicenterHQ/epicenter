import { join } from 'node:path';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { ScheduleAttempt, ScheduleListing } from '../call.ts';
import { readBytes, replaceFile } from '../disk.ts';
import { isPlainObject, parseJson } from '../json.ts';
import { isName, NAME_RULE } from '../name.ts';
import { stderrJsonLines } from './output.ts';
import type { Program } from './program.ts';
import { answerCall, inputProblem } from './run.ts';

const MINUTE = 60_000;
const log = createLogger('epicenter/schedule', stderrJsonLines);
const ScheduleError = defineErrors({
	ScheduleWriteFailed: ({
		schedule,
		scheduledFor,
		code,
	}: {
		schedule: string;
		scheduledFor: string;
		code: string;
	}) => ({
		message: 'could not save scheduled attempt',
		schedule,
		scheduledFor,
		code,
	}),
});

export type Schedule = {
	name: string;
	cron: string;
	action: readonly [string, string];
	inputJson: string;
};

const nextRun = (cron: string, after: number) =>
	Bun.cron.parse(cron, after)?.getTime() ?? null;

export function compileSchedules(
	program: Program,
	value: unknown,
): Schedule[] | string {
	if (!isPlainObject(value))
		return 'schedules must be an object keyed by schedule name';
	const schedules: Schedule[] = [];
	for (const [name, definition] of Object.entries(value)) {
		const problem = (message: string) => `schedules.${name}: ${message}`;
		if (!isName(name)) return problem(`the schedule name must be ${NAME_RULE}`);
		if (!isPlainObject(definition))
			return problem('expected { cron, action, input }');
		const { cron, action, input } = definition;
		if (typeof cron !== 'string') return problem('cron must be a string');
		try {
			if (nextRun(cron, Date.now()) === null)
				return problem('cron has no future occurrences');
		} catch (cause) {
			return problem(extractErrorMessage(cause));
		}
		if (!Array.isArray(action) || action.length !== 2 || !action.every(isName))
			return problem('action must be [app, action]');
		const [appName, actionName] = action as [string, string];
		const app = Object.hasOwn(program.apps, appName)
			? program.apps[appName]
			: undefined;
		const run =
			app && Object.hasOwn(app.actions, actionName)
				? app.actions[actionName]
				: undefined;
		const check = run && program.inputChecks.get(run);
		if (!run || !check)
			return problem(`there is no action ${appName} ${actionName}`);
		if (!isPlainObject(input)) return problem('input must be one JSON object');
		let inputJson: string;
		try {
			inputJson = JSON.stringify(input);
		} catch (cause) {
			return problem(
				`input cannot be JSON encoded: ${extractErrorMessage(cause)}`,
			);
		}
		const invalid = inputProblem(check, run.input, parseJson(inputJson));
		if (invalid !== undefined) return problem(invalid);
		schedules.push({ name, cron, action: [appName, actionName], inputJson });
	}
	return schedules;
}

const isTime = (value: unknown): value is string =>
	typeof value === 'string' && Number.isFinite(Date.parse(value));

function readAttempt(file: string): ScheduleAttempt | undefined {
	const bytes = readBytes(file);
	if (!bytes) return undefined;
	const value = parseJson(new TextDecoder().decode(bytes));
	if (
		!isPlainObject(value) ||
		!isTime(value.scheduledFor) ||
		!isTime(value.attemptedAt) ||
		(value.status !== 'dispatching' &&
			!(
				isTime(value.returnedAt) &&
				(value.status === 'returned' ||
					(value.status === 'error' && typeof value.error === 'string'))
			))
	)
		throw new Error('invalid attempt record');
	return value as ScheduleAttempt;
}

export function startSchedules(program: Program, state: string) {
	if (!program.schedules?.length) return undefined;
	const readyAt = Date.now();
	const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
	const entries = program.schedules.map((schedule) => ({
		schedule,
		file: join(state, 'schedules', `${schedule.name}.json`),
		next: nextRun(schedule.cron, readyAt),
		running: undefined as ScheduleAttempt | undefined,
	}));
	let timer: ReturnType<typeof setTimeout>;

	function save(entry: (typeof entries)[number], attempt: ScheduleAttempt) {
		try {
			replaceFile(
				entry.file,
				`${JSON.stringify(attempt, null, 2)}\n`,
				join(state, 'tmp'),
			);
			return true;
		} catch (cause) {
			log.error(
				ScheduleError.ScheduleWriteFailed({
					schedule: entry.schedule.name,
					scheduledFor: attempt.scheduledFor,
					code: (cause as NodeJS.ErrnoException).code ?? 'WriteFailed',
				}).error,
			);
			return false;
		}
	}

	async function dispatch(entry: (typeof entries)[number], due: number) {
		const { name, action, inputJson } = entry.schedule;
		const scheduledFor = new Date(due).toISOString();
		const attempt: ScheduleAttempt = {
			scheduledFor,
			attemptedAt: new Date().toISOString(),
			status: 'dispatching',
		};
		if (!save(entry, attempt)) return;
		entry.running = attempt;
		log.info('scheduled action started', { schedule: name, scheduledFor });
		const answer = await answerCall(program, ...action, parseJson(inputJson));
		const returnedAt = new Date().toISOString();
		const error = answer.error?.name;
		log.info('scheduled action returned', {
			schedule: name,
			scheduledFor,
			...(error === undefined ? {} : { error }),
		});
		if (entry.running !== attempt) return;
		entry.running = undefined;
		save(
			entry,
			error === undefined
				? { ...attempt, returnedAt, status: 'returned' }
				: { ...attempt, returnedAt, status: 'error', error },
		);
	}

	function tick() {
		const now = Date.now();
		timer = setTimeout(tick, MINUTE - (now % MINUTE));
		for (const entry of entries) {
			const current = Date.now();
			const due = entry.next;
			if (due === null || due > current) continue;
			entry.next = nextRun(entry.schedule.cron, current);
			const currentMinute = current - (current % MINUTE);
			const occurrence =
				due >= currentMinute
					? due
					: nextRun(entry.schedule.cron, currentMinute - 1);
			if (occurrence !== null && occurrence <= current)
				void dispatch(entry, occurrence);
		}
	}
	tick();

	return {
		stop: () => clearTimeout(timer),
		list(): ScheduleListing[] {
			return entries.map(
				({ schedule: { name, cron, action }, file, next, running }) => {
					const listing = {
						name,
						cron,
						action,
						timeZone,
						nextRun: next === null ? null : new Date(next).toISOString(),
					};
					try {
						const lastAttempt = readAttempt(file);
						if (!lastAttempt) return listing;
						return {
							...listing,
							lastAttempt,
							...(running ? { running: true } : {}),
						};
					} catch {
						return { ...listing, attemptUnreadable: true };
					}
				},
			);
		},
	};
}
