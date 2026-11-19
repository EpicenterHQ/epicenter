/**
 * Answer one call in serve: find `action` of `app` in the program, check
 * `input` against its schema, run it, and answer what it did. The route, MCP
 * and every caller through them share this one call, so a page, an agent and
 * the command get the one input check. Nothing is filled: an
 * absent key stays absent, and an action's `run` writes its own default.
 *
 * A call that cannot begin is `NotStarted`. A run answers its own Result as
 * JSON, or `Threw` when it throws, returns what JSON cannot carry, or returns
 * an error named `NotStarted`, `Threw` or `Unreachable`: only Epicenter says
 * whether a call began. When a run ends, serve logs one record: the app, the
 * action, the outcome and how long it took, never the input or the result,
 * which can hold personal data.
 */

import { Value } from 'typebox/value';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { ActionError, type Answer, PLATFORM_NAMES } from '../answer.ts';
import { type ObjectSchema, whyNot } from '../field.ts';
import { isPlainObject } from '../json.ts';
import { stderrJsonLines } from './output.ts';
import type { Program } from './program.ts';

/** Where serve writes one record for each run, when it ends. */
const runLog = createLogger('epicenter/run', stderrJsonLines);

export async function answerCall(
	program: Program,
	app: string,
	action: string,
	input: unknown,
	onUpdate?: (value: unknown) => unknown,
): Promise<Answer> {
	if (program.problem)
		return ActionError.NotStarted({
			message: `${program.problem}\nFix it, then restart serve.`,
		});
	const found = Object.hasOwn(program.apps, app)
		? program.apps[app]
		: undefined;
	if (!found)
		return ActionError.NotStarted({
			message: `There is no app "${app}"`,
			next: 'epicenter',
		});
	const run = Object.hasOwn(found.actions, action)
		? found.actions[action]
		: undefined;
	if (!run) {
		const names = Object.keys(found.actions);
		return ActionError.NotStarted({
			message: `${app} has no action ${JSON.stringify(action)}; ${names.length ? `its actions: ${names.join(', ')}` : 'it has none'}`,
			next: `epicenter ${app}`,
		});
	}
	const problem = inputProblem(run.input, input);
	if (problem !== undefined)
		return ActionError.NotStarted({
			message: problem,
			next: `epicenter ${app}`,
		});
	const started = performance.now();
	// defineAction checked that it returned a Result (`isAction`).
	const answer: Answer = await run(input, { onUpdate })
		.then((result) => {
			const { data, error } = result as Answer;
			if (error && PLATFORM_NAMES.includes(error.name))
				return ActionError.Threw({
					message: `The action "${action}" returned ${error.name}, a name only Epicenter answers`,
				});
			// JSON's own copy: undefined is null, and a cycle or a BigInt throws.
			return JSON.parse(
				JSON.stringify({ data: data ?? null, error }),
			) as Answer;
		})
		.catch((cause) =>
			ActionError.Threw({ message: extractErrorMessage(cause) }),
		);
	try {
		runLog.info('action run ended', {
			app,
			action,
			durationMs: Math.round(performance.now() - started),
			...(answer.error === null
				? { outcome: 'ok' }
				: { outcome: 'error', error: answer.error.name }),
		});
	} catch {
		// The record is for the owner; it must not change the caller's answer.
	}
	return answer;
}

/**
 * Why `value` is not an input `schema` takes, in words a caller reads, or
 * undefined when it is one. A key the action does not take is refused,
 * naming the keys it does.
 */
function inputProblem(schema: ObjectSchema, value: unknown) {
	if (Value.Check(schema, value)) return undefined;
	if (!isPlainObject(value)) return 'The input is not one JSON object';
	const keys = Object.keys(schema.properties);
	const unknown = Object.keys(value).find((key) => !keys.includes(key));
	if (unknown !== undefined)
		return `${JSON.stringify(unknown)} is not a key this action takes; ${keys.length ? `it takes ${keys.join(', ')}` : 'it takes none'}`;
	for (const [key, field] of Object.entries(schema.properties)) {
		if (!Object.hasOwn(value, key)) {
			if (schema.required.includes(key)) return `${key} is needed`;
		} else if (!Value.Check(field, value[key]))
			return whyNot(key, field, value[key]);
	}
	return 'The input does not fit';
}
