/**
 * The platform errors' types. `NotStarted` is one name whose fields depend on
 * its `cause`: narrowing on `cause` gives each cause exactly its own fields,
 * and the factory refuses a body that mixes them. Each check is a
 * compile-time assertion run by `tsc`; the test body only keeps `bun test`
 * from skipping the file.
 */
import { expect, test } from 'bun:test';
import {
	ActionError,
	type NotStarted,
	type NotStartedCause,
	type Threw,
	type Unreachable,
} from './errors.ts';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
const assertType = <T extends true>(): T | undefined => undefined;

/** Each cause's own fields, read only after narrowing on `cause`. */
function causeFields(error: NotStarted) {
	switch (error.cause) {
		case 'usage':
		case 'refused':
		case 'unavailable':
			assertType<Equal<typeof error.next, string | undefined>>();
			// @ts-expect-error Only `app-problems` carries the app's problems.
			void error.problems;
			return error.next;
		case 'app-problems': {
			const app: string = error.app;
			const problems: string[] = error.problems;
			// @ts-expect-error `app-problems` has no next step of its own.
			void error.next;
			return [app, ...problems].join('\n');
		}
		case 'internal':
			// @ts-expect-error `internal` carries only its message.
			void error.next;
			return error.message;
		default:
			return error satisfies never;
	}
}

function factoryChecks() {
	assertType<
		Equal<
			NotStartedCause,
			'usage' | 'app-problems' | 'refused' | 'internal' | 'unavailable'
		>
	>();
	// `InferErrors` keeps the union: `ActionError` holds each cause apart.
	assertType<
		Equal<
			Extract<ActionError, { name: 'NotStarted'; cause: 'app-problems' }>,
			Extract<NotStarted, { cause: 'app-problems' }>
		>
	>();
	assertType<Equal<Threw['name'], 'Threw'>>();
	assertType<Equal<Unreachable['name'], 'Unreachable'>>();
	ActionError.NotStarted({
		cause: 'app-problems',
		message: 'notes: code/epicenter.ts is missing',
		app: 'notes',
		problems: ['code/epicenter.ts is missing'],
	});
	// @ts-expect-error `app-problems` needs the app and its problems.
	ActionError.NotStarted({ cause: 'app-problems', message: 'm' });
	// @ts-expect-error `internal` takes no next step.
	ActionError.NotStarted({ cause: 'internal', message: 'm', next: 'x' });
	// @ts-expect-error A cause outside the list is refused.
	ActionError.NotStarted({ cause: 'other', message: 'm' });
}

test('NotStarted type assertions compile', () => {
	expect(causeFields).toBeFunction();
	expect(factoryChecks).toBeFunction();
});
