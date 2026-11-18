/**
 * Run Record Tests
 *
 * `runAction` writes one record when a run ends, so a run whose caller left
 * still leaves a trace in serve's log. The record names the run and how it
 * ended, and holds none of the input or result data, which can be personal.
 *
 * Key behaviors:
 * - Each outcome (ok, or an error by its name) writes exactly one `info` record
 * - A failure's record carries only its name: a message can quote the input
 * - Neither the input nor the result reaches the record
 * - A logger that throws does not change the answer
 */

import { expect, test } from 'bun:test';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineAction, Err, field, Ok } from '../index.ts';
import type { LoadedApp } from './home.ts';
import { runAction } from './run.ts';

const SECRET = 'diary entry 4417';

// The record names the app, which is all a run reads of it.
const notes = { name: 'notes' } as LoadedApp;

function run(
	key: string,
	run: (input: { text: string }) => unknown,
	log: Logger,
) {
	const action = defineAction({
		description: key,
		input: { text: field.text() },
		run: run as never,
	});
	return runAction(
		{ app: notes, key, action, input: { text: SECRET } },
		{ log },
	);
}

function recorder() {
	const { sink, events } = memorySink();
	return { log: createLogger('cli/run', sink), events };
}

test('a run that returns Ok writes one ok record without its input or result', async () => {
	const { log, events } = recorder();
	const answer = await run('save', ({ text }) => Ok({ saved: text }), log);
	expect(expectOk(answer)).toEqual({ saved: SECRET });
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		level: 'info',
		source: 'cli/run',
		data: {
			app: 'notes',
			action: 'save',
			outcome: 'ok',
			durationMs: expect.any(Number),
		},
	});
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

test('a run that returns Err writes one error record with only its name', async () => {
	const { log, events } = recorder();
	const answer = await run(
		'route',
		({ text }) =>
			Err({ name: 'NoRoute', message: 'No route from LAX', asked: text }),
		log,
	);
	expect(expectErr(answer).name).toBe('NoRoute');
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		action: 'route',
		outcome: 'error',
		error: 'NoRoute',
	});
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

test('a run that throws writes one Threw record with only the thrown name', async () => {
	const { log, events } = recorder();
	const answer = await run(
		'print',
		({ text }) => {
			throw { name: 'Jammed', message: 'The printer jammed', page: text };
		},
		log,
	);
	expect(expectErr(answer).name).toBe('Threw');
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		action: 'print',
		outcome: 'error',
		error: 'Threw',
		thrown: 'Jammed',
	});
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

test('a logger that throws leaves the answer unchanged', async () => {
	const throwing: Logger = {
		...createLogger('cli/run', memorySink().sink),
		info() {
			throw new Error('log is broken');
		},
	};
	const answer = await run('save', () => Ok('kept'), throwing);
	expect(expectOk(answer)).toBe('kept');
});
