/** Type checks for a page's calls: inputs, answers, returned errors, and updates. */
import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { defineAction, type Update } from './action.ts';
import { connect } from './client.ts';
import { field } from './field.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

const count = defineAction({
	description: 'Count',
	input: { to: field.integer() },
	async run({ to }, update: Update<{ at: number; note?: string }>) {
		update({ at: to });
		return Ok('done');
	},
});
const empty = defineAction({
	description: 'Empty',
	input: {},
	run: () => Ok(null),
});
const classify = defineAction({
	description: 'Classify',
	input: { yes: field.boolean() },
	run: ({ yes }) =>
		yes
			? Ok(1)
			: Err({ name: 'NoRoute' as const, message: 'No route', airport: 'LAX' }),
});
// @ts-expect-error An action must return a Result even when it always succeeds.
defineAction({ description: 'Plain', input: {}, run: () => 1 });
const app = connect<
	() => {
		actions: {
			classify: typeof classify;
			count: typeof count;
			daily: { start: typeof empty };
		};
	}
>({ app: 'types' });
// Typecheck these calls without making network requests during bun test.
function clientUsage() {
	void app.classify({}).then(({ data, error }) => {
		if (error === null) {
			const count: number = data;
			return count;
		}
		if (error.name === 'NoRoute') {
			const airport: string = error.airport;
			return airport;
		}
		return error.message;
	});
	// A call's error is exactly what its action returns and the three only
	// Epicenter answers, so a switch on the name is exhaustive.
	void app.classify({}).then(({ error }) => {
		if (error === null) return 'ok';
		switch (error.name) {
			case 'NoRoute':
				return error.airport;
			case 'NotStarted':
				return error.cause;
			case 'Threw':
			case 'Unreachable':
				return error.message;
			default:
				return error satisfies never;
		}
	});
	void app.classify({}).then(({ error }) => {
		if (error === null) return;
		assertType<
			Equal<
				(typeof error)['name'],
				'NoRoute' | 'NotStarted' | 'Threw' | 'Unreachable'
			>
		>();
		// @ts-expect-error classify never returns Missing, so comparing it is a mistake.
		if (error.name === 'Missing') return;
	});
	// An action with no error of its own still answers the platform's three.
	void app.daily.start().then(({ error }) => {
		if (error === null) return;
		assertType<
			Equal<(typeof error)['name'], 'NotStarted' | 'Threw' | 'Unreachable'>
		>();
	});
	void app.count(
		{ to: 3 },
		{
			onUpdate: (value) => {
				const at: number = value.at;
				const note: string | undefined = value.note;
				void [at, note];
			},
		},
	);
	void app.count({ to: 3 });
	// @ts-expect-error The input is still checked.
	void app.count({ to: 'three' });
	// @ts-expect-error A call takes no signal: nothing stops an action from outside.
	void app.count({ to: 3 }, { signal: new AbortController().signal });
	// @ts-expect-error An action that sends no updates takes no options.
	void app.daily.start({}, { onUpdate: () => {} });
	void app.daily.start({});
	void app.daily.start();
}
test('client type assertions compile', () =>
	expect(clientUsage).toBeFunction());
