/**
 * Open Refusal Tests
 *
 * The refusal screen's words for storage that might become available again.
 *
 * Key behaviors:
 * - A transient storage failure offers "Try again"
 * - A permanently invalid table name does not
 */
import { expect, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder/testing';
import { describeOpenRefusal } from './open-refusal.js';

test('an invalid table name cannot be fixed by opening again', () => {
	const { error } = OpenFolderError.InvalidTable({ table: 'bad/name' });
	expect(describeOpenRefusal(error)).toEqual({
		description: error.message,
		retry: false,
	});
});

test('a storage failure can be retried', () => {
	expect(
		describeOpenRefusal(
			OpenFolderError.Unavailable({ cause: new Error('disk') }).error,
		).retry,
	).toBe(true);
});
