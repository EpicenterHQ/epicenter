/**
 * The platform errors' types. Each check is a compile-time assertion run by
 * `tsc`; the test body only keeps `bun test` from skipping the file.
 */
import { expect, test } from 'bun:test';
import {
	ActionError,
	type NotStarted,
	type Threw,
	type Unreachable,
} from './errors.ts';
import { assertType, type Equal } from './library.test-support.ts';

function factoryChecks() {
	assertType<Equal<keyof NotStarted, 'name' | 'message' | 'next'>>();
	assertType<Equal<NotStarted['next'], string | undefined>>();
	assertType<Equal<Threw['name'], 'Threw'>>();
	assertType<Equal<Unreachable['name'], 'Unreachable'>>();
	ActionError.NotStarted({ message: 'm', next: 'epicenter' });
	// @ts-expect-error NotStarted has no cause.
	ActionError.NotStarted({ message: 'm', cause: 'usage' });
}

test('NotStarted type assertions compile', () => {
	expect(factoryChecks).toBeFunction();
});
