/** Type checks for ordinary actions, file inputs, run controls, and yields. */
import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { defineAction } from './action.ts';
import { type ActionRun, connect, runs } from './client.ts';
import { field } from './field.ts';

const upload = defineAction({
	description: 'Upload',
	input: { file: field.file() },
	async *run() {
		yield 1 as const;
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
const app = connect<{
	actions: {
		classify: typeof classify;
		upload: typeof upload;
		daily: { start: typeof empty };
		practice: { start: typeof empty };
	};
}>({ app: 'types' });
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
	void app.upload(
		{ file: new Blob() },
		{
			onYield: (value) => {
				const one: 1 = value;
				void one;
			},
		},
	);
	// @ts-expect-error A file input accepts Blob, not a path.
	void app.upload({ file: 'file.txt' });
	void app.upload(
		{ file: new Blob() },
		// @ts-expect-error Ordinary calls have no observer signal.
		{ signal: new AbortController().signal },
	);
	// @ts-expect-error Non-yielding ordinary calls have no options.
	void app.daily.start({}, { signal: new AbortController().signal });
	void app.daily.start({});
	void app.practice.start({});
	const run: ActionRun<typeof upload> = runs.start(app.upload, {
		file: new Blob(),
	});
	void run.events({ signal: new AbortController().signal });
	// @ts-expect-error Observers replay the run; offsets belong to the transport.
	void run.events({ after: 1 });
	void run.result({
		onYield: (value) => {
			const one: 1 = value;
			void one;
		},
	});
	void runs.start(app.daily.start, {});
	// @ts-expect-error Runs are not thenable.
	void run.then;
}
test('client type assertions compile', () =>
	expect(clientUsage).toBeFunction());
