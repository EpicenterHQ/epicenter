import { defineTable } from '@epicenter/data';
import {
	type BrowserEpicenter,
	openBrowserEpicenter,
} from '@epicenter/data/browser';
import type { ExchangeResponse } from '@epicenter/data/protocol';
import { field } from '@epicenter/field';

import './replica-owner-client.js';
import './replica-conformance-client.js';
import './replica-candidate-client.js';
import './runtime-client.js';

import {
	type BrowserEvidenceDriver,
	CONTROL_CHANNEL,
	type EvidenceFeatures,
	type EvidenceSnapshot,
	type HungSyncStatus,
} from './contract.js';

declare global {
	interface Window {
		browserEvidence: BrowserEvidenceDriver;
	}
}

const notesDefinition = defineTable({
	key: 'so.epicenter.evidence.notes',
	fields: {
		title: field.string(),
		writer: field.string(),
	},
});

let epicenter: BrowserEpicenter | undefined;
let data: ReturnType<typeof bindEvidenceData> | undefined;
let workerName: string | undefined;
let stopInvalidations: (() => void) | undefined;
let invalidations: string[] = [];
let hungStarted = false;
let hungOutcome: string | undefined;

function bindEvidenceData(opened: BrowserEpicenter) {
	return opened.bind({ tables: { notes: notesDefinition }, values: {} });
}

function requireData(): ReturnType<typeof bindEvidenceData> {
	if (data === undefined)
		throw new Error('Browser evidence runtime is not open');
	return data;
}

function unwrap<TValue>(result: {
	data: TValue;
	error: { name?: string; message?: string } | null;
}): TValue {
	if (result.error === null) return result.data;
	const error = new Error(result.error.message ?? 'Evidence data read failed');
	error.name = result.error.name ?? 'EvidenceDataError';
	throw error;
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function probeSyncAccessHandle(): Promise<boolean> {
	if (navigator.storage?.getDirectory === undefined) return false;
	const source = `self.onmessage = async () => {
		const name = 'epicenter-evidence-probe';
		try {
			const root = await navigator.storage.getDirectory();
			const file = await root.getFileHandle(name, { create: true });
			const handle = await file.createSyncAccessHandle();
			handle.close();
			await root.removeEntry(name);
			self.postMessage(true);
		} catch {
			self.postMessage(false);
		}
	};`;
	const url = URL.createObjectURL(
		new Blob([source], { type: 'text/javascript' }),
	);
	try {
		const worker = new Worker(url);
		return await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				worker.terminate();
				resolve(false);
			}, 5_000);
			worker.onmessage = ({ data: supported }) => {
				clearTimeout(timer);
				worker.terminate();
				resolve(supported === true);
			};
			worker.onerror = () => {
				clearTimeout(timer);
				worker.terminate();
				resolve(false);
			};
			worker.postMessage(undefined);
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function features(): Promise<EvidenceFeatures> {
	const estimate = await navigator.storage?.estimate?.();
	return {
		secureContext: globalThis.isSecureContext,
		sharedWorker: typeof SharedWorker !== 'undefined',
		opfs: navigator.storage?.getDirectory !== undefined,
		webLocks: navigator.locks !== undefined,
		syncAccessHandle: await probeSyncAccessHandle(),
		...(estimate?.usage === undefined
			? {}
			: { storageUsageBytes: Math.floor(estimate.usage) }),
		...(estimate?.quota === undefined
			? {}
			: { storageQuotaBytes: Math.floor(estimate.quota) }),
	};
}

async function open(nextWorkerName: string): Promise<void> {
	if (epicenter !== undefined) await dispose();
	workerName = nextWorkerName;
	epicenter = await openBrowserEpicenter({
		createSharedWorker: () => {
			if (typeof SharedWorker === 'undefined') {
				throw new Error('SharedWorker is unavailable');
			}
			return new SharedWorker(
				new URL('./controlled-worker.ts', import.meta.url),
				{ type: 'module', name: nextWorkerName },
			);
		},
	});
	data = bindEvidenceData(epicenter);
}

async function dispose(): Promise<void> {
	stopInvalidations?.();
	stopInvalidations = undefined;
	invalidations = [];
	const opened = epicenter;
	epicenter = undefined;
	data = undefined;
	workerName = undefined;
	if (opened !== undefined) await opened[Symbol.asyncDispose]();
}

async function create(title: string, writer: string): Promise<{ id: string }> {
	const row = await requireData().tables.notes.create({ title, writer });
	return { id: row.id };
}

async function get(
	rowId: string,
): Promise<{ id: string; title: string; writer: string } | undefined> {
	return unwrap(await requireData().tables.notes.get(rowId)) ?? undefined;
}

async function snapshot(): Promise<EvidenceSnapshot> {
	const rows: EvidenceSnapshot['rows'] = [];
	for await (const entry of requireData().tables.notes.entries()) {
		const row = unwrap(entry);
		if (row === null)
			throw new Error('Live evidence entry was unexpectedly null');
		rows.push(row);
	}
	rows.sort((left, right) => left.id.localeCompare(right.id));
	const semanticSha256 = await sha256(JSON.stringify(rows));
	const estimate = await navigator.storage?.estimate?.();
	return {
		rowCount: rows.length,
		semanticSha256,
		rows,
		...(estimate?.usage === undefined
			? {}
			: { storageUsageBytes: Math.floor(estimate.usage) }),
		...(estimate?.quota === undefined
			? {}
			: { storageQuotaBytes: Math.floor(estimate.quota) }),
	};
}

async function setDocument(rowId: string, content: string): Promise<string> {
	const document = await requireData().tables.notes.openDocument(rowId);
	try {
		const text = document.get('content');
		text.delete(0, text.length);
		text.insert(0, content);
		await document.whenDurable();
		return sha256(text.toString());
	} finally {
		await document[Symbol.asyncDispose]();
	}
}

async function readDocument(rowId: string): Promise<string> {
	const document = await requireData().tables.notes.openDocument(rowId);
	try {
		return document.get('content').toString();
	} finally {
		await document[Symbol.asyncDispose]();
	}
}

function startInvalidationCapture(): void {
	stopInvalidations?.();
	invalidations = [];
	stopInvalidations = requireData().tables.notes.subscribe((ids) => {
		invalidations.push(...ids);
	});
}

function takeInvalidations(): string[] {
	const captured = invalidations;
	invalidations = [];
	return captured;
}

function startHungSync(): void {
	const opened = epicenter;
	if (opened === undefined)
		throw new Error('Browser evidence runtime is not open');
	hungStarted = false;
	hungOutcome = undefined;
	void opened
		.attachSync({
			deploymentId: 'https://evidence.invalid/',
			principalId: 'evidence-principal',
			exchange() {
				hungStarted = true;
				return new Promise<ExchangeResponse>(() => undefined);
			},
		})
		.then((result) => {
			hungOutcome = result.error?.name ?? 'attached';
		})
		.catch((cause: unknown) => {
			hungOutcome = cause instanceof Error ? cause.name : 'Error';
		});
}

function hungSyncStatus(): HungSyncStatus {
	return {
		started: hungStarted,
		...(hungOutcome === undefined ? {} : { hungOutcome }),
	};
}

async function terminateWorker(): Promise<void> {
	const target = workerName;
	if (target === undefined) {
		throw new Error('Only a controlled evidence worker can be terminated');
	}
	const channel = new BroadcastChannel(CONTROL_CHANNEL);
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error('Controlled SharedWorker did not acknowledge close'),
					),
				5_000,
			);
			channel.onmessage = ({ data: message }) => {
				if (
					typeof message !== 'object' ||
					message === null ||
					!('type' in message) ||
					message.type !== 'terminating' ||
					!('workerName' in message) ||
					message.workerName !== target
				)
					return;
				clearTimeout(timer);
				resolve();
			};
			channel.postMessage({ type: 'terminate', workerName: target });
		});
	} finally {
		channel.close();
	}
}

window.browserEvidence = Object.freeze({
	features,
	open,
	dispose,
	create,
	get,
	snapshot,
	setDocument,
	readDocument,
	startInvalidationCapture,
	takeInvalidations,
	startHungSync,
	hungSyncStatus,
	terminateWorker,
	visibilityState: () => document.visibilityState,
});
