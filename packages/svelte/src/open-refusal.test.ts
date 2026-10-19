/**
 * Open Refusal Tests
 *
 * The refusal screen's words for browser data retained by the earlier
 * opener and for native storage that might become available again.
 *
 * Key behaviors:
 * - Earlier data is named and never replaced by an empty workspace
 * - A transient storage failure offers "Try again"
 * - A permanently invalid table name does not
 */
import { expect, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder';
import { describeOpenRefusal } from './open-refusal.js';

test('an invalid table name cannot be fixed by opening again', () => {
	const { error } = OpenFolderError.InvalidTable({ table: 'bad/name' });
	expect(describeOpenRefusal(error, 'Todos')).toEqual({
		description: error.message,
		retry: false,
	});
});

test('a storage failure can be retried', () => {
	expect(
		describeOpenRefusal(
			OpenFolderError.Unavailable({ cause: new Error('disk') }).error,
			'Todos',
		).retry,
	).toBe(true);
});

test('older browser data is named as retained without offering an empty retry', () => {
	expect(
		describeOpenRefusal(
			OpenFolderError.LegacyDataPresent({ folders: ['so.epicenter.todos'] }).error,
			'Todos',
		),
	).toEqual({
		description:
			'Earlier folder files are still stored in this browser (so.epicenter.todos). Todos cannot read them yet, so it stopped before showing an empty workspace.',
		retry: false,
	});
});
