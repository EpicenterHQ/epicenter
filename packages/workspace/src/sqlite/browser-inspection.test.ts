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
	type InspectLocalWorkspaceOptions,
	inspectLocalWorkspace,
} from './browser.js';
import {
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

	function listenersFor(type: string): Set<Listener> {
		let values = listeners.get(type);
		if (!values) {
			values = new Set();
			listeners.set(type, values);
		}
		return values;
	}

	const worker = {
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
	const inspection = inspectLocalWorkspace(definition, {
		worker: () => fake.worker,
		workspaceKind: 'standalone',
	});
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
	const inspection = inspectLocalWorkspace(definition, {
		worker: () => fake.worker,
		workspaceKind: 'standalone',
	});
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
	const inspection = inspectLocalWorkspace(definition, {
		worker: () => fake.worker,
		workspaceKind: 'standalone',
	});
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
	const remoteFailure = inspectLocalWorkspace(definition, {
		worker: () => failed.worker,
		workspaceKind: 'standalone',
	});
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
	const workerCrash = inspectLocalWorkspace(definition, {
		worker: () => crashed.worker,
		workspaceKind: 'standalone',
	});
	crashed.emit('error', { message: 'worker crashed' });
	await expect(workerCrash).rejects.toThrow('worker crashed');
	expect(crashed.isCleanedUp).toBe(true);

	const timedOut = createWorker();
	await expect(
		inspectLocalWorkspace(definition, {
			worker: () => timedOut.worker,
			workspaceKind: 'standalone',
			timeoutMs: 1,
		}),
	).rejects.toThrow('timed out');
	expect(timedOut.isCleanedUp).toBe(true);
});

test('unlocked candidate is rejected before an inspector Worker is created', () => {
	const candidate = defineWorkspace({
		appId: 'unlocked-inspection-test',
		version: 1,
		tables: { rows },
	});
	let workerCreated = false;
	const options: InspectLocalWorkspaceOptions = {
		workspaceKind: 'standalone',
		worker() {
			workerCreated = true;
			return createWorker().worker;
		},
	};

	expect(() =>
		inspectLocalWorkspace(candidate as unknown as WorkspaceDefinition, options),
	).toThrow('lockWorkspace');
	expect(workerCreated).toBe(false);
});
