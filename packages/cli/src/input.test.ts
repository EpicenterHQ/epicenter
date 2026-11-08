/**
 * Action matching separates name words from values and flags. Input schemas keep
 * field names while stripping the runner's positional metadata.
 */
import { expect, test } from 'bun:test';
import { type Action, defineApp, field } from '@epicenter/app';
import { inputSchema, matchAction } from './input.ts';

test('action matching leaves negative numbers and dates as values and rejects leading flags', () => {
	const app = defineApp({
		name: 'reading',
		description: 'Reading and calendar records',
		actions: {
			log: {
				description: 'Record reading',
				input: { minutes: field.number({ positional: true }) },
				run: (input) => input,
			},
			'calendar show': {
				description: 'Show a day',
				input: { day: field.date({ positional: true }) },
				run: (input) => input,
			},
			'calendar add': {
				description: 'Add a day',
				input: { day: field.date({ positional: true }) },
				run: (input) => input,
			},
		},
	});
	expect(matchAction(app, ['log', '-3'])).toEqual({
		key: 'log',
		rest: ['-3'],
	});
	expect(matchAction(app, ['calendar', 'show', '2026-11-08'])).toEqual({
		key: 'calendar show',
		rest: ['2026-11-08'],
	});
	expect(matchAction(app, ['--json'])).toBeUndefined();
});

test('a field named positional survives schema rendering without changing the app schema', () => {
	const action: Action = {
		description: 'Read a value',
		input: { positional: field.text({ positional: true }) },
		run: (input) => input,
	};
	const schema = inputSchema(action);
	expect(schema.properties).toEqual({ positional: { type: 'string' } });
	expect(schema.required).toEqual(['positional']);
	expect(action.input.positional).toMatchObject({ positional: true });
});
