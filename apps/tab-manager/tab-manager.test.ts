/**
 * Tab Manager Web Capture Tests
 *
 * Verifies the version 1 SQLite inbox through its application-owned actions.
 *
 * Key behaviors:
 * - Capture stores one browser page without browser side effects
 * - Open consumes a capture only after browser creation succeeds
 * - Discard removes a capture without opening it
 */

import { expect, test } from 'bun:test';
import { openStandaloneWorkspace } from '@epicenter/workspace/sqlite/bun';
import { tabManagerWorkspaceDefinition } from './src/versions/v1/definition.js';
import { createTabManagerActions } from './tab-manager.js';

async function createTestTabManager(open: (url: string) => Promise<void>) {
	const workspace = await openStandaloneWorkspace(tabManagerWorkspaceDefinition, {
		storage: { kind: 'memory' },
		onObserverError(error) {
			throw error;
		},
	});
	return {
		workspace,
		actions: createTabManagerActions(workspace, { open }),
		async [Symbol.asyncDispose]() {
			await workspace[Symbol.asyncDispose]();
		},
	};
}

test('capture stores a page without opening it', async () => {
	const opened: string[] = [];
	await using tabManager = await createTestTabManager(async (url) => {
		opened.push(url);
	});

	const id = await tabManager.actions.web_captures_capture({
		url: 'https://example.com/article',
		title: 'An article',
		favIconUrl: null,
	});

	expect(await tabManager.workspace.tables.webCaptures.get(id)).toEqual(
		expect.objectContaining({
			id,
			url: 'https://example.com/article',
			title: 'An article',
			favIconUrl: null,
		}),
	);
	expect(opened).toEqual([]);
});

test('open creates a browser tab before consuming the capture', async () => {
	const opened: string[] = [];
	await using tabManager = await createTestTabManager(async (url) => {
		opened.push(url);
	});
	const id = await tabManager.actions.web_captures_capture({
		url: 'https://example.com',
		title: 'Example',
		favIconUrl: null,
	});

	await tabManager.actions.web_captures_open({
		id,
		url: 'https://example.com',
	});

	expect(opened).toEqual(['https://example.com']);
	expect(await tabManager.workspace.tables.webCaptures.get(id)).toBeNull();
});

test('failed browser open preserves the capture', async () => {
	await using tabManager = await createTestTabManager(async () => {
		throw new Error('browser refused');
	});
	const id = await tabManager.actions.web_captures_capture({
		url: 'https://example.com',
		title: 'Example',
		favIconUrl: null,
	});

	await expect(
		tabManager.actions.web_captures_open({
			id,
			url: 'https://example.com',
		}),
	).rejects.toThrow('browser refused');
	expect(await tabManager.workspace.tables.webCaptures.get(id)).not.toBeNull();
});

test('discard removes a capture without opening it', async () => {
	const opened: string[] = [];
	await using tabManager = await createTestTabManager(async (url) => {
		opened.push(url);
	});
	const id = await tabManager.actions.web_captures_capture({
		url: 'https://example.com',
		title: 'Example',
		favIconUrl: null,
	});

	await tabManager.actions.web_captures_discard({ id });

	expect(await tabManager.workspace.tables.webCaptures.get(id)).toBeNull();
	expect(opened).toEqual([]);
});
