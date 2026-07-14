/**
 * Workspace Version Lock Tests
 *
 * Verifies that source declarations produce one canonical durable-plane map
 * and that only an exact published entry authorizes a workspace at runtime.
 *
 * Key behaviors:
 * - App and version derive the only workspace identity
 * - KV defaults are excluded while durable schemas and formats are locked
 * - Lock parsing rejects drift, malformed history, and noncanonical planes
 */

import { describe, expect, test } from 'bun:test';
import { openStandaloneWorkspace as openBrowserWorkspace } from './browser.js';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	inspectWorkspaceCandidate,
	lockWorkspace,
	type WorkspaceCandidate,
	type WorkspaceDefinition,
} from './definition.js';
import { document } from './document-format.js';
import { field } from './field.js';
import {
	deriveWorkspaceId,
	parseWorkspaceVersionLock,
} from './workspace-version.js';

function lockFor(
	candidate: ReturnType<typeof defineWorkspace>,
	entries: unknown[] = [candidate.proposedLockEntry],
) {
	return {
		format: 'epicenter.workspace-version-lock/1',
		appId: candidate.appId,
		versions: entries,
	};
}

function candidateFor(version = 1) {
	return defineWorkspace({
		appId: 'version-test',
		version,
		tables: {
			notes: defineTable({
				fields: {
					id: field.string(),
					title: field.string(),
					body: field.doc(document.plainText),
					attachment: field.blob(),
				},
			}),
		},
		kv: { theme: defineKv(field.string(), () => 'light') },
	});
}

describe('workspace version source', () => {
	test('derives one version-qualified identity and canonical plane map', () => {
		const candidate = candidateFor(2);

		expect(candidate.workspaceId).toBe('version-test-v2');
		expect(candidate.kvDocumentGuid).toBe('version-test-v2.kv');
		expect(Object.keys(candidate.proposedLockEntry.planes)).toEqual([
			'document.notes.body',
			'kv',
			'kv.theme',
		]);
		expect(candidate.proposedLockEntry.planes.kv).toBe('version-test-v2.kv');
		expect(candidate.proposedLockEntry.planes['kv.theme']).toMatch(
			/^sha256:[0-9a-f]{64}$/,
		);
		expect(candidate.proposedLockEntry.planes['document.notes.body']).toMatch(
			/^epicenter\.sqlite-child-document-guid\/1;row-id=epicenter\.document-row\/1;guid=version-test-v2\.notes\.<row-id-sha256>\.body\.[0-9a-f]{64}$/,
		);
		expect(candidate.tables.notes.blobs.attachment).toEqual(
			candidate.tables.notes.fields.attachment,
		);
		expect(Object.isFrozen(candidate.proposedLockEntry)).toBe(true);
		expect(Object.isFrozen(candidate.proposedLockEntry.planes)).toBe(true);
	});

	test('KV executable defaults do not participate in durable identity', () => {
		function planes(defaultValue: string) {
			return defineWorkspace({
				appId: 'defaults-test',
				version: 1,
				tables: {
					rows: defineTable({ fields: { id: field.string() } }),
				},
				kv: { theme: defineKv(field.string(), () => defaultValue) },
			}).proposedLockEntry.planes;
		}

		expect(planes('light')).toEqual(planes('dark'));
	});

	test('rejects unsafe app ids and non-positive versions', () => {
		expect(() => deriveWorkspaceId('Unsafe', 1)).toThrow(
			'Invalid application id',
		);
		expect(() => deriveWorkspaceId('safe', 0)).toThrow('positive integer');
		expect(() => deriveWorkspaceId('safe', 1.5)).toThrow('positive integer');
	});
});

describe('lockWorkspace', () => {
	test('browser opening rejects an unlocked cast before creating a Worker', async () => {
		const candidate = candidateFor();
		let workerCreated = false;

		await expect(
			openBrowserWorkspace(
				candidate as unknown as WorkspaceDefinition<typeof candidate.tables>,
				{
					worker() {
						workerCreated = true;
						return null as never;
					},
					onObserverError() {},
				},
			),
		).rejects.toThrow('must be returned by lockWorkspace()');
		expect(workerCreated).toBe(false);
	});

	test('rejects casted and copied candidate lookalikes', () => {
		const candidate = candidateFor();
		const copied = {
			...candidate,
		} as unknown as WorkspaceCandidate;

		expect(() => inspectWorkspaceCandidate(copied)).toThrow(
			'must be returned by defineWorkspace()',
		);
		expect(() => lockWorkspace(copied, lockFor(candidate))).toThrow(
			'must be returned by defineWorkspace()',
		);
		expect(inspectWorkspaceCandidate(candidate)).toEqual({
			appId: candidate.appId,
			proposedLockEntry: candidate.proposedLockEntry,
		});
	});

	test('authorizes a published historical version in a later lock', () => {
		const versionOne = candidateFor(1);
		const versionTwo = candidateFor(2);
		const lock = lockFor(versionOne, [
			versionOne.proposedLockEntry,
			versionTwo.proposedLockEntry,
		]);

		const workspace = lockWorkspace(versionOne, lock);
		expect(workspace.workspaceId).toBe('version-test-v1');
		expect(Object.isFrozen(workspace)).toBe(true);
	});

	test('rejects a missing or drifted source entry', () => {
		const versionOne = candidateFor(1);
		const versionTwo = candidateFor(2);
		expect(() =>
			lockWorkspace(
				versionOne,
				lockFor(versionOne, [versionTwo.proposedLockEntry]),
			),
		).toThrow('does not publish version 1');

		const drifted = {
			...versionOne.proposedLockEntry,
			planes: {
				...versionOne.proposedLockEntry.planes,
				'kv.theme': `sha256:${'0'.repeat(64)}`,
			},
		};
		expect(() =>
			lockWorkspace(versionOne, lockFor(versionOne, [drifted])),
		).toThrow('does not publish version 1');
	});
});

describe('parseWorkspaceVersionLock', () => {
	test('returns an immutable exact lock', () => {
		const candidate = candidateFor();
		const parsed = parseWorkspaceVersionLock(lockFor(candidate));

		expect(parsed.appId).toBe(candidate.appId);
		expect(parsed.versions).toEqual([candidate.proposedLockEntry]);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.versions)).toBe(true);
		expect(Object.isFrozen(parsed.versions[0]?.planes)).toBe(true);
	});

	test('rejects extra keys, invalid generated ids, and unordered history', () => {
		const one = candidateFor(1);
		const two = candidateFor(2);
		expect(() =>
			parseWorkspaceVersionLock({ ...lockFor(one), extra: true }),
		).toThrow('Invalid workspace version lock');
		expect(() =>
			parseWorkspaceVersionLock(
				lockFor(one, [{ ...one.proposedLockEntry, workspaceId: 'forged' }]),
			),
		).toThrow('invalid workspace id');
		expect(() =>
			parseWorkspaceVersionLock(
				lockFor(one, [two.proposedLockEntry, one.proposedLockEntry]),
			),
		).toThrow('strictly increasing');
	});

	test('rejects noncanonical or unknown durable planes', () => {
		const candidate = candidateFor();
		const entries = (planes: Record<string, string>) => [
			{ ...candidate.proposedLockEntry, planes },
		];
		expect(() =>
			parseWorkspaceVersionLock(
				lockFor(
					candidate,
					entries({ kv: candidate.kvDocumentGuid, 'blob.bad': 'bad' }),
				),
			),
		).toThrow('canonically sorted');
		expect(() =>
			parseWorkspaceVersionLock(
				lockFor(
					candidate,
					entries({ kv: candidate.kvDocumentGuid, unknown: 'value' }),
				),
			),
		).toThrow("Unknown workspace version plane 'unknown'");
	});
});
