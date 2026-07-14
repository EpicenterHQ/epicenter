/**
 * Browser Workspace Inspection Tests
 *
 * Verifies the one-shot inspector protocol and page-side Worker lifecycle.
 * Malformed messages, mismatched definitions, remote failures, and timeouts
 * must terminate the Worker, while unlocked definitions fail before creation.
 */

import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import {
	type InspectBrowserWorkspaceOptions,
	inspectBrowserWorkspace,
} from './browser.js';
import {
	parseWorkspaceInspectionCommand,
	parseWorkspaceInspectionEvent,
	WORKSPACE_INSPECTION_PROTOCOL,
} from './browser-inspection.js';
import {
	defineTable,
	defineWorkspace,
	type WorkspaceDefinition,
} from './definition.js';
import { defineTestWorkspace } from './test-workspace.js';

type Listener = (event: { data?: unknown; message?: string }) => void;

function createWorker() {
	const listeners = new Map<string, Set<Listener>>();
	let terminated = false;
	let markPosted!: () => void;
	const whenPosted = new Promise<void>((resolve) => {
		markPosted = resolve;
	});

	function listenersFor(type: string): Set<Listener> {
		let values = listeners.get(type);
		if (!values) {
			values = new Set();
			listeners.set(type, values);
		}
		return values;
	}

	const worker = {
		postMessage() {
			markPosted();
		},
		addEventListener(type: string, listener: Listener) {
			listenersFor(type).add(listener);
		},
		removeEventListener(type: string, listener: Listener) {
			listenersFor(type).delete(listener);
		},
		terminate() {
			terminated = true;
		},
	} as unknown as Worker;

	return {
		worker,
		whenPosted,
		emit(type: string, event: { data?: unknown; message?: string }) {
			for (const listener of [...listenersFor(type)]) listener(event);
		},
		get isCleanedUp() {
			return (
				terminated &&
				[...listeners.values()].every((values) => values.size === 0)
			);
		},
	};
}

const rows = defineTable({ fields: { id: field.string() } });
const definition = defineTestWorkspace({
	appId: 'browser-inspection-test',
	tables: { rows },
});

test('inspection protocol accepts exact results and rejects malformed events', () => {
	expect(
		parseWorkspaceInspectionCommand({
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'inspect',
			workspaceKind: 'standalone',
			databaseName: 'notes-v1.standalone.sqlite3',
		}),
	).toEqual({
		protocol: WORKSPACE_INSPECTION_PROTOCOL,
		type: 'inspect',
		workspaceKind: 'standalone',
		databaseName: 'notes-v1.standalone.sqlite3',
	});
	const initialized = {
		protocol: WORKSPACE_INSPECTION_PROTOCOL,
		type: 'result',
		workspaceKind: 'standalone',
		workspaceId: definition.workspaceId,
		recordsDescriptor: definition.recordsDescriptor,
		recordsSchemaHash: definition.recordsSchemaHash,
		inspection: { status: 'initialized' },
	} as const;
	expect(parseWorkspaceInspectionEvent(initialized)).toEqual(initialized);

	for (const invalid of [
		null,
		{ ...initialized, extra: true },
		{ ...initialized, inspection: { status: 'absent', reason: 'extra' } },
		{ ...initialized, inspection: { status: 'invalid', reason: '' } },
		{
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'error',
			error: { name: 'Error', message: 'broken', extra: true },
		},
	]) {
		expect(() => parseWorkspaceInspectionEvent(invalid)).toThrow('Invalid');
	}
});

test('successful inspection resolves and cleans up its Worker', async () => {
	const fake = createWorker();
	const inspection = inspectBrowserWorkspace(definition, {
		worker: () => fake.worker,
		authority: { kind: 'local' },
	});
	await fake.whenPosted;
	fake.emit('message', {
		data: {
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'result',
			workspaceKind: 'standalone',
			workspaceId: definition.workspaceId,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: definition.recordsSchemaHash,
			inspection: { status: 'absent' },
		},
	});

	await expect(inspection).resolves.toEqual({ status: 'absent' });
	expect(fake.isCleanedUp).toBe(true);
});

test('lifecycle mismatch terminates the inspector', async () => {
	const fake = createWorker();
	const inspection = inspectBrowserWorkspace(definition, {
		worker: () => fake.worker,
		authority: { kind: 'local' },
	});
	await fake.whenPosted;
	fake.emit('message', {
		data: {
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'result',
			workspaceKind: 'replica',
			workspaceId: definition.workspaceId,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: definition.recordsSchemaHash,
			inspection: { status: 'initialized' },
		},
	});

	await expect(inspection).rejects.toThrow('definition does not match');
	expect(fake.isCleanedUp).toBe(true);
});

test('same-workspace schema mismatch terminates the inspector', async () => {
	const fake = createWorker();
	const inspection = inspectBrowserWorkspace(definition, {
		worker: () => fake.worker,
		authority: { kind: 'local' },
	});
	await fake.whenPosted;
	fake.emit('message', {
		data: {
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'result',
			workspaceKind: 'standalone',
			workspaceId: definition.workspaceId,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: `sha256:${'0'.repeat(64)}`,
			inspection: { status: 'initialized' },
		},
	});
	await expect(inspection).rejects.toThrow('definition does not match');
	expect(fake.isCleanedUp).toBe(true);
});

test('remote error, Worker crash, and timeout clean up inspector Workers', async () => {
	const failed = createWorker();
	const remoteFailure = inspectBrowserWorkspace(definition, {
		worker: () => failed.worker,
		authority: { kind: 'local' },
	});
	await failed.whenPosted;
	failed.emit('message', {
		data: {
			protocol: WORKSPACE_INSPECTION_PROTOCOL,
			type: 'error',
			error: { name: 'SecurityError', message: 'denied' },
		},
	});
	await expect(remoteFailure).rejects.toThrow('denied');
	expect(failed.isCleanedUp).toBe(true);

	const crashed = createWorker();
	const workerCrash = inspectBrowserWorkspace(definition, {
		worker: () => crashed.worker,
		authority: { kind: 'local' },
	});
	await crashed.whenPosted;
	crashed.emit('error', { message: 'worker crashed' });
	await expect(workerCrash).rejects.toThrow('worker crashed');
	expect(crashed.isCleanedUp).toBe(true);

	const timedOut = createWorker();
	await expect(
		inspectBrowserWorkspace(definition, {
			worker: () => timedOut.worker,
			authority: { kind: 'local' },
			timeoutMs: 1,
		}),
	).rejects.toThrow('timed out');
	expect(timedOut.isCleanedUp).toBe(true);
});

test('unlocked candidate is rejected before an inspector Worker is created', async () => {
	const candidate = defineWorkspace({
		appId: 'unlocked-inspection-test',
		version: 1,
		tables: { rows },
	});
	let workerCreated = false;
	const options: InspectBrowserWorkspaceOptions = {
		authority: { kind: 'local' },
		worker() {
			workerCreated = true;
			return createWorker().worker;
		},
	};

	await expect(
		inspectBrowserWorkspace(
			candidate as unknown as WorkspaceDefinition,
			options,
		),
	).rejects.toThrow('lockWorkspace');
	expect(workerCreated).toBe(false);
});
