import { field } from '@epicenter/field';

import { BLOB_PUBLICATION_VERSION } from '../src/blob-v1/index.js';
import { DOCUMENT_PUBLICATION_VERSION } from '../src/document-v1/index.js';
import { defineLens, defineTable, defineValues } from '../src/lens/index.js';
import {
	type AuthorityState,
	createAuthority,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	submit,
} from '../src/protocol/v1/index.js';
import { makeLimits } from '../src/protocol/v1/kernel.test-support.js';
import {
	type BrowserEpicenter,
	type BrowserRuntimeWorker,
	openBrowserEpicenter,
} from '../src/runtime/browser.js';
import type { RowDocument } from '../src/runtime/row-document.js';
import type { AuthorityCarrier } from '../src/runtime/supervisor.js';
import type { BrowserRuntimeEvidenceDriver } from './runtime-contract.js';

declare global {
	interface Window {
		browserRuntimeEvidence: BrowserRuntimeEvidenceDriver;
	}
}

const lens = defineLens({
	namespace: 'so.epicenter.browser-runtime',
	title: 'Browser runtime evidence',
	description: 'Production elected-owner runtime evidence',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: {
				title: field.string(),
				body: field.string(),
			},
			optional: ['body'],
		}),
		settings: defineValues({
			title: 'Settings',
			values: {
				theme: field.string(),
			},
		}),
	},
});

const limits = makeLimits();
const createdAuthority = createAuthority('runtime-life', limits);
if (createdAuthority.error !== null) throw createdAuthority.error;
let authority: AuthorityState = createdAuthority.data;
let isOnline = true;
let forceLifetimeMismatch = false;
let holdDocuments = false;
let heldDocumentResolvers: (() => void)[] = [];
const counts = { facts: 0, submissions: 0, documents: 0, blobs: 0 };
let runtime: BrowserEpicenter | undefined;
let bound: ReturnType<typeof bindRuntime> | undefined;
let openedWorker: BrowserRuntimeWorker | undefined;
const documents = new Map<string, RowDocument>();
let holdDocumentAcknowledgement = false;
let heldDocumentAcknowledgement: (() => void)[] = [];
let hasHeldDocumentAcknowledgement = false;
let pendingDocumentDurability: Promise<void> | undefined;
let isDocumentDurabilitySettled = true;
let pendingDisposal: Promise<void> | undefined;
let isDisposalSettled = true;

function requireRuntime(): BrowserEpicenter {
	if (runtime === undefined) throw new Error('browser runtime is not open');
	return runtime;
}

function bindRuntime(opened: BrowserEpicenter) {
	return opened.bind(lens);
}

function requireBound(): ReturnType<typeof bindRuntime> {
	if (bound === undefined) throw new Error('browser runtime is not bound');
	return bound;
}

function unwrap<TValue>(result: {
	data: TValue;
	error: { message: string } | null;
}): TValue {
	if (result.error !== null) throw new Error(result.error.message);
	return result.data;
}

function requireOnline(): void {
	if (!isOnline) throw new Error('offline');
}

function requireCurrentLifetime(): void {
	if (!forceLifetimeMismatch) return;
	forceLifetimeMismatch = false;
	const mismatch = new Error('authority lifetime changed');
	mismatch.name = 'LifetimeMismatch';
	throw mismatch;
}

const carrier: AuthorityCarrier<Blob> = {
	async fetchFacts(request) {
		requireOnline();
		requireCurrentLifetime();
		counts.facts += 1;
		const admitted = parseFactsRequest(request, limits);
		if (admitted.error !== null) throw admitted.error;
		const result = readFacts(authority, admitted.data, limits);
		if (result.error !== null) throw result.error;
		return result.data;
	},
	async submit(bytes) {
		requireOnline();
		requireCurrentLifetime();
		counts.submissions += 1;
		const admitted = parseSubmissionRequest(JSON.parse(bytes), limits);
		if (admitted.error !== null) throw admitted.error;
		const result = submit(authority, admitted.data, limits);
		if (result.error !== null) throw result.error;
		authority = result.data.state;
		return result.data.response;
	},
	async publishDocument(address, publication) {
		requireOnline();
		requireCurrentLifetime();
		counts.documents += 1;
		if (holdDocuments) {
			await new Promise<void>((resolve) => heldDocumentResolvers.push(resolve));
		}
		return {
			kind: 'accepted',
			receipt: {
				authorityLifetime: authority.lifetime,
				address,
				protocolVersion: DOCUMENT_PUBLICATION_VERSION,
				digest: publication.digest,
			},
		};
	},
	async publishBlob(address, publication) {
		requireOnline();
		requireCurrentLifetime();
		counts.blobs += 1;
		return {
			kind: 'accepted',
			receipt: {
				authorityLifetime: authority.lifetime,
				address,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: publication.digest,
			},
		};
	},
};

async function open({
	coordinationId,
	storage,
	replicaId = 'rrrrrrrrrrrrrrrrrrrrrrrr',
	owner,
	withCarrier = false,
}: Parameters<BrowserRuntimeEvidenceDriver['open']>[0]): Promise<void> {
	if (runtime !== undefined) await dispose();
	runtime = await openBrowserEpicenter({
		owner,
		carrier: withCarrier ? carrier : null,
		limits,
		replicaId,
		authorityLifetime: 'runtime-life',
		coordinationId,
		storage,
		createWorker() {
			const raw = new Worker(
				new URL('../src/browser-replica-candidate-worker.ts', import.meta.url),
				{ type: 'module' },
			);
			const delayedIds = new Set<number>();
			const worker: BrowserRuntimeWorker = {
				postMessage(message) {
					if (
						holdDocumentAcknowledgement &&
						message.type === 'request' &&
						message.operation.kind === 'append-local-document'
					) {
						delayedIds.add(message.id);
					}
					raw.postMessage(message);
				},
				addEventListener(type, listener) {
					if (type === 'error') {
						raw.addEventListener(
							'error',
							listener as (event: ErrorEvent) => void,
						);
						return;
					}
					raw.addEventListener('message', (event) => {
						const message = event.data;
						if (
							(message.type === 'result' || message.type === 'error') &&
							delayedIds.delete(message.id)
						) {
							hasHeldDocumentAcknowledgement = true;
							heldDocumentAcknowledgement.push(() =>
								listener({ data: message }),
							);
							return;
						}
						listener({ data: message });
					});
				},
				terminate() {
					raw.terminate();
				},
			};
			openedWorker = worker;
			return worker;
		},
	});
	bound = bindRuntime(runtime);
}

async function create(title: string): Promise<string> {
	return (await requireBound().notes.create({ title })).id;
}

async function get(id: string) {
	return unwrap(await requireBound().notes.record(id).get()) ?? null;
}

async function update(id: string, title: string): Promise<void> {
	unwrap(await requireBound().notes.record(id).update({ title }));
}

async function setTheme(value: string): Promise<void> {
	unwrap(await requireBound().settings.record('theme').set(value));
}

async function unsetTheme(): Promise<void> {
	unwrap(await requireBound().settings.record('theme').unset());
}

async function getTheme(): Promise<string | null> {
	return unwrap(await requireBound().settings.record('theme').get()) ?? null;
}

async function openDocument(label: string, id: string): Promise<void> {
	const result = await requireBound().notes.record(id).document.open();
	const document = unwrap(result);
	if (document === null) throw new Error('document did not open');
	documents.set(label, document);
}

function requireDocument(label: string): RowDocument {
	const document = documents.get(label);
	if (document === undefined)
		throw new Error(`document '${label}' is not open`);
	return document;
}

function insertDocument(label: string, index: number, text: string): void {
	requireDocument(label).getText('body').insert(index, text);
}

function documentText(label: string): string {
	return requireDocument(label).getText('body').toString();
}

async function whenDocumentDurable(label: string): Promise<void> {
	await requireDocument(label).whenDurable();
}

function beginDocumentDurability(label: string): void {
	if (pendingDocumentDurability !== undefined) {
		throw new Error('document durability is already pending');
	}
	isDocumentDurabilitySettled = false;
	pendingDocumentDurability = requireDocument(label)
		.whenDurable()
		.finally(() => {
			isDocumentDurabilitySettled = true;
		});
}

function documentDurabilitySettled(): boolean {
	return isDocumentDurabilitySettled;
}

async function waitForDocumentDurability(): Promise<void> {
	const durability = pendingDocumentDurability;
	if (durability === undefined) {
		throw new Error('document durability is not pending');
	}
	try {
		await durability;
	} finally {
		pendingDocumentDurability = undefined;
	}
}

function holdDocumentAcknowledgements(): void {
	holdDocumentAcknowledgement = true;
	hasHeldDocumentAcknowledgement = false;
}

function documentAcknowledgementHeld(): boolean {
	return hasHeldDocumentAcknowledgement;
}

function releaseDocumentAcknowledgements(): void {
	holdDocumentAcknowledgement = false;
	const acknowledgements = heldDocumentAcknowledgement;
	heldDocumentAcknowledgement = [];
	for (const acknowledge of acknowledgements) acknowledge();
}

async function closeDocument(label: string): Promise<void> {
	const document = requireDocument(label);
	documents.delete(label);
	await document[Symbol.asyncDispose]();
}

async function captureBlob(id: string, text: string): Promise<void> {
	unwrap(
		await requireBound()
			.notes.record(id)
			.blob.capture(new Blob([text], { type: 'text/plain' })),
	);
}

async function readBlob(id: string): Promise<string | null> {
	return (await requireBound().notes.record(id).blob.read())?.text() ?? null;
}

function publication(id: string) {
	return requireBound().notes.record(id).publication.get();
}

function status() {
	return requireRuntime().sync.status;
}

function setOnline(value: boolean): void {
	isOnline = value;
}

function nudgeOnline(): void {
	globalThis.dispatchEvent(new Event('online'));
}

function holdDocumentReceipts(): void {
	holdDocuments = true;
}

function releaseDocumentReceipts(): void {
	holdDocuments = false;
	const resolvers = heldDocumentResolvers;
	heldDocumentResolvers = [];
	for (const resolve of resolvers) resolve();
}

function replaceAuthority(lifetime: string): void {
	const replacement = createAuthority(lifetime, limits);
	if (replacement.error !== null) throw replacement.error;
	authority = replacement.data;
	forceLifetimeMismatch = true;
}

function authorityCounts() {
	return structuredClone(counts);
}

async function disposeRuntimeKeepingDocuments(): Promise<void> {
	const opened = runtime;
	runtime = undefined;
	bound = undefined;
	if (opened !== undefined) await opened[Symbol.asyncDispose]();
	openedWorker = undefined;
}

function beginDisposeRuntimeKeepingDocuments(): void {
	if (pendingDisposal !== undefined) {
		throw new Error('browser runtime disposal is already pending');
	}
	isDisposalSettled = false;
	pendingDisposal = disposeRuntimeKeepingDocuments().finally(() => {
		isDisposalSettled = true;
	});
}

function disposalSettled(): boolean {
	return isDisposalSettled;
}

async function waitForDisposal(): Promise<void> {
	const disposal = pendingDisposal;
	if (disposal === undefined)
		throw new Error('browser runtime disposal is not pending');
	try {
		await disposal;
	} finally {
		pendingDisposal = undefined;
	}
}

async function dispose(): Promise<void> {
	for (const [label, document] of documents) {
		documents.delete(label);
		await document[Symbol.asyncDispose]();
	}
	const opened = runtime;
	runtime = undefined;
	bound = undefined;
	if (opened !== undefined) await opened[Symbol.asyncDispose]();
	openedWorker = undefined;
}

function terminate(): void {
	openedWorker?.terminate();
	openedWorker = undefined;
}

window.browserRuntimeEvidence = Object.freeze({
	open,
	create,
	get,
	update,
	setTheme,
	unsetTheme,
	getTheme,
	openDocument,
	insertDocument,
	documentText,
	whenDocumentDurable,
	beginDocumentDurability,
	documentDurabilitySettled,
	waitForDocumentDurability,
	holdDocumentAcknowledgements,
	documentAcknowledgementHeld,
	releaseDocumentAcknowledgements,
	closeDocument,
	captureBlob,
	readBlob,
	publication,
	status,
	setOnline,
	nudgeOnline,
	holdDocumentReceipts,
	releaseDocumentReceipts,
	replaceAuthority,
	authorityCounts,
	disposeRuntimeKeepingDocuments,
	beginDisposeRuntimeKeepingDocuments,
	disposalSettled,
	waitForDisposal,
	dispose,
	terminate,
});
