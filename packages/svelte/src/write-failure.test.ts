/** Copyable failed input is the exact source accepted by FileEdit. */
import { expect, test } from 'bun:test';
import { SaveError } from '@epicenter/folder';
import type { Recovery } from '@epicenter/folder/edits';
import { recoveryFailure, unsavedText } from './write-failure.js';

const pending: Recovery = {
	path: 'notes/a.md',
	text: '﻿---\r\ntitle: Milk\r\n---\r\nTwo litres\r\n',
	error: undefined,
};

test('failed input copies the exact source including its byte-order mark and line endings', () => {
	expect(unsavedText(pending)).toBe(pending.text);
	expect(recoveryFailure(pending).unsaved).toBe(pending.text);
	expect(recoveryFailure(pending).error.name).toBe('Unsaved');
});

test('a recovery that failed to save carries its error to the person', () => {
	const error = SaveError.StorageFailed({ cause: 'disk full' }).error;
	expect(recoveryFailure({ ...pending, error }).error).toBe(error);
});
