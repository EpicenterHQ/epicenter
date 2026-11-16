import type { Err, Ok, Result } from 'wellcrafted/result';
import {
	expectErr as checkErr,
	expectOk as checkOk,
} from 'wellcrafted/testing';

/** Preserve every member of a union of action answers when a test expects success. */
export function expectOk<R extends Result<unknown, unknown>>(
	answer: R,
): Extract<Exclude<R, Err<never>>, Ok<unknown>>['data'] {
	return checkOk<unknown>(answer) as Extract<
		Exclude<R, Err<never>>,
		Ok<unknown>
	>['data'];
}

/** Assert failure and keep the error types of the action under test. */
export function expectErr<R extends Result<unknown, unknown>>(
	answer: R,
): Exclude<Extract<R, Err<unknown>>['error'], null> {
	return checkErr<unknown>(answer) as Exclude<
		Extract<R, Err<unknown>>['error'],
		null
	>;
}
