import { extractErrorMessage } from 'wellcrafted/error';
import type { ScheduleListing } from '../call.ts';
import { isPlainObject, parseJson } from '../json.ts';
import { isName, NAME_RULE } from '../name.ts';
import type { Program } from './program.ts';
import { callAction, inputProblem } from './run.ts';

const MINUTE = 60_000;
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

export function startSchedules(program: Program) {
	if (!program.schedules?.length) return undefined;
	const readyAt = Date.now();
	const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
	const entries = program.schedules.map((schedule) => ({
		...schedule,
		next: nextRun(schedule.cron, readyAt),
	}));
	let timer: ReturnType<typeof setTimeout>;

	function tick() {
		const now = Date.now();
		timer = setTimeout(tick, MINUTE - (now % MINUTE));
		for (const entry of entries) {
			const current = Date.now();
			const {
				cron,
				action: [app, action],
				inputJson,
				next: due,
			} = entry;
			if (due === null || due > current) continue;
			entry.next = nextRun(cron, current);
			const currentMinute = current - (current % MINUTE);
			const occurrence =
				due >= currentMinute ? due : nextRun(cron, currentMinute - 1);
			if (occurrence !== null && occurrence <= current)
				// Nobody awaits a scheduled run; the runner's line records how it ended.
				void callAction(program, { app, action, input: parseJson(inputJson) });
		}
	}
	tick();

	return {
		stop: () => clearTimeout(timer),
		list(): ScheduleListing[] {
			return entries.map(({ name, cron, action, next }) => ({
				name,
				cron,
				action,
				timeZone,
				nextRun: next === null ? null : new Date(next).toISOString(),
			}));
		},
	};
}
