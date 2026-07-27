import { defineLens, defineTable } from '@epicenter/data';
import {
	type BrowserEpicenter,
	openBrowserEpicenter,
} from '@epicenter/data/browser';
import { field } from '@epicenter/field';

import type {
	BrowserEvidenceDriver,
	EvidenceFeatures,
	EvidenceSnapshot,
	HungSyncStatus,
} from './contract.js';

declare global {
	interface Window {
		browserEvidence: BrowserEvidenceDriver;
	}
}

const evidenceLens = defineLens({
	namespace: 'so.epicenter.evidence',
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				writer: field.string(),
			},
		}),
	},
	values: {},
});

let epicenter: BrowserEpicenter | undefined;
let data: ReturnType<typeof bindEvidenceData> | undefined;
let controlledWorker: Worker | undefined;
let hungStarted = false;
let hungOutcome: string | undefined;

function bindEvidenceData(opened: BrowserEpicenter) {
	return opened.bind(evidenceLens);
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
		dedicatedWorker: typeof Worker !== 'undefined',
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
	epicenter = await openBrowserEpicenter({
		createWorker: () => {
			if (typeof Worker === 'undefined') {
				throw new Error('Dedicated Worker is unavailable');
			}
			const worker = new Worker(
				new URL('./controlled-worker.ts', import.meta.url),
				{ type: 'module', name: nextWorkerName },
			);
			controlledWorker = worker;
			return {
				port: {
					postMessage: (message) => worker.postMessage(message),
					addEventListener: (type, listener) =>
						worker.addEventListener(type, listener),
					close: () => worker.terminate(),
				},
				addEventListener: (type, listener) =>
					worker.addEventListener(type, listener),
			};
		},
	});
	data = bindEvidenceData(epicenter);
}

async function dispose(): Promise<void> {
	const opened = epicenter;
	const worker = controlledWorker;
	epicenter = undefined;
	data = undefined;
	controlledWorker = undefined;
	if (opened === undefined) worker?.terminate();
	else await opened[Symbol.asyncDispose]();
	await waitForStorageLeaseRelease();
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
			// A transport that never answers, to prove attaching does not block on
			// the network. Both operations hang: the supervisor wakes each lane
			// independently, so leaving either one answering would let the other
			// lane's progress mask a stall.
			transport: {
				readFacts() {
					hungStarted = true;
					return new Promise(() => undefined);
				},
				submit() {
					hungStarted = true;
					return new Promise(() => undefined);
				},
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
	const worker = controlledWorker;
	if (worker === undefined) {
		throw new Error('Only a controlled evidence worker can be terminated');
	}
	epicenter = undefined;
	data = undefined;
	controlledWorker = undefined;
	worker.terminate();
	await waitForStorageLeaseRelease();
}

async function waitForStorageLeaseRelease(): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (
		(await navigator.locks.query()).held?.some(
			({ name }) => name === 'epicenter-data-sqlite',
		)
	) {
		if (Date.now() >= deadline) {
			throw new Error('DedicatedWorker did not release its storage lease');
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
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
	startHungSync,
	hungSyncStatus,
	terminateWorker,
});
