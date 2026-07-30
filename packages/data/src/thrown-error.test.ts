/**
 * What a data carrier says about a value someone threw at it.
 *
 * The tagged-error case is the one worth pinning. A bound Lens reports its
 * refusals by throwing what a `defineErrors` factory produced, and those are
 * frozen plain objects rather than `Error` instances, so an `instanceof` test
 * describes every one of them as `Error` / `[object Object]` and the client
 * that reconstructs the pair learns nothing.
 */
import { expect, test } from 'bun:test';

import { defineErrors } from 'wellcrafted/error';

import { describeThrownError } from './thrown-error.js';

const TestError = defineErrors({
	InvalidInput: ({ boundary }: { boundary: string }) => ({
		message: `Refused invalid input at ${boundary}`,
		boundary,
	}),
});

test('a thrown tagged error keeps its variant name and its sentence', () => {
	const { error } = TestError.InvalidInput({ boundary: 'intent' });
	// The premise: this is why an `instanceof Error` test cannot describe it.
	expect(error instanceof Error).toBeFalse();
	expect(describeThrownError(error)).toEqual({
		name: 'InvalidInput',
		message: 'Refused invalid input at intent',
	});
});

test('a thrown Error keeps its own subclass name', () => {
	expect(describeThrownError(new TypeError('bad argument'))).toEqual({
		name: 'TypeError',
		message: 'bad argument',
	});
});

test('a thrown Error carrying an assigned name keeps the assigned one', () => {
	const sentinel = new Error('no open surface');
	sentinel.name = 'EpicenterSurfaceNotOpenError';
	expect(describeThrownError(sentinel)).toEqual({
		name: 'EpicenterSurfaceNotOpenError',
		message: 'no open surface',
	});
});

test.each([
	['a string', 'something went wrong', 'something went wrong'],
	['null', null, 'null'],
	['undefined', undefined, 'undefined'],
	['a number', 42, '42'],
])('%s carries no name, so it is described as Error', (_label, thrown, message) => {
	expect(describeThrownError(thrown)).toEqual({ name: 'Error', message });
});

test('an object whose name is not a usable string is described as Error', () => {
	expect(describeThrownError({ name: '', message: 'empty name' })).toEqual({
		name: 'Error',
		message: 'empty name',
	});
	expect(describeThrownError({ name: 7, message: 'numeric name' })).toEqual({
		name: 'Error',
		message: 'numeric name',
	});
});
