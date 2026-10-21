/** Copyable failed input is the exact source accepted by FileEdit. */
import { expect, test } from 'bun:test';
import type { Pending } from '@epicenter/folder/edits';
import { pendingFailure, unsavedText } from './write-failure.js';

const pending: Pending = {
	path: 'notes/a.md',
	text: '﻿---\r\ntitle: Milk\r\n---\r\nTwo litres\r\n',
	saving: false,
	error: undefined,
};

test('failed input copies the exact source including its byte-order mark and line endings', () => {
	expect(unsavedText(pending)).toBe(pending.text);
	expect(pendingFailure(pending).unsaved).toBe(pending.text);
});
