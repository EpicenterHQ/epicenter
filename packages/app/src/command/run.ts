/**
 * Answer one call in serve: find `action` of `app` in the program, check
 * `input` against its schema, run it, and answer what it did. The route, MCP
 * and every caller through them share this one call.
 *
 * A call that cannot begin is `NotStarted`. A run answers its own Result as
 * JSON, or `Threw` when it throws, returns what JSON cannot carry, or returns
 * an error named `NotStarted`, `Threw` or `Unreachable`: only Epicenter says
 * whether a call began. When a run ends, serve logs one record: the app, the
 * action, the outcome and how long it took, never the input or the result,
 * which can hold personal data.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, trySync } from 'wellcrafted/result';
import type { Answer } from '../call.ts';
import { ActionError, type Thrown } from '../errors.ts';
import { isPlainObject } from '../json.ts';
import { inputProblem } from './input.ts';
import { stderrJsonLines } from './output.ts';
import type { Program } from './program.ts';

/** The names only Epicenter answers. */
const RESERVED_NAMES = ['NotStarted', 'Threw', 'Unreachable'];

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
			if (error && RESERVED_NAMES.includes(error.name))
				return ActionError.Threw({
					message: `The action "${action}" returned ${error.name}, a name only Epicenter answers`,
				});
			// JSON's own copy: undefined is null, and a cycle or a BigInt throws.
			return JSON.parse(
				JSON.stringify({ data: data ?? null, error }),
			) as Answer;
		})
		.catch((cause) => ActionError.Threw(describeThrown(cause)));
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
 * What a thrown value becomes in `Threw`: its message, and the value itself
 * when it is a tagged error (`{ name, message, ... }`) that survives JSON.
 * Reading a hostile value never stops the answer.
 */
function describeThrown(cause: unknown): { message: string; thrown?: Thrown } {
	// Even extracting a message can fail, for a cyclic array or a getter.
	const { data: message } = trySync({
		try: () => extractErrorMessage(cause).slice(0, 4096),
		catch: () => Ok('The action threw a value that could not be read'),
	});
	try {
		if (typeof cause !== 'object' || cause === null || cause instanceof Error)
			return { message };
		const json = JSON.stringify(cause);
		const copy: unknown = json.length > 4096 ? undefined : JSON.parse(json);
		if (
			isPlainObject(copy) &&
			typeof copy.name === 'string' &&
			typeof copy.message === 'string'
		)
			return { message, thrown: copy as Thrown };
	} catch {
		// Details are best effort.
	}
	return { message };
}
