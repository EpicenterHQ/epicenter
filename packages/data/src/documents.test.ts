/**
 * Row-Document Publication and Pull Tests
 *
 * Verifies the durable authority-publication record that ADR-0171/0174 attach
 * to locally authored document work: local appends advance the obligation in
 * the append transaction, authority-accepted installs never mint one, capture
 * reconstructs current state so retries are semantically idempotent, settling
 * revision N never clears N+1, `too-large` records a terminal address-scoped
 * issue, settled row deletion removes chain and obligation together, and
 * explicit pulls deliver accepted state without creating outbound work.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	acceptedDocumentOrigin,
	applyRowDocumentUpdate,
	createDocumentRuntime,
	type DocumentPullResponse,
	type PullDocument,
} from './documents.js';
import type { RowAddress } from './protocol/index.js';
import {
	type AuthorityState,
	createAuthority,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	SCALAR_V1_LIMITS,
	submit,
} from './protocol/v1/index.js';
import {
	openReplicaV1,
	type ScalarTransport,
	type TransportOutcome,
} from './replica/v1-replica.js';

const AUTHORITY_LIFETIME = 'documents-test-lifetime';

function rowId(seed: string): string {
	return seed
		.replaceAll(/[^a-z0-9]/g, '')
		.padEnd(24, '0')
		.slice(0, 24);
}

function address(seed: string): RowAddress {
	return {
		kind: 'row',
		namespace: 'so.epicenter.tests',
		tableName: 'notes',
		rowId: rowId(seed),
	};
}

function setup({ pull }: { pull?: PullDocument } = {}) {
	const rawDatabase = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(rawDatabase);
	const replica = expectOk(openReplicaV1({ database }));
	const documents = createDocumentRuntime({
		database,
		replica,
		...(pull === undefined ? {} : { getPullTransport: () => pull }),
	});
	function createRow(target: RowAddress): void {
		expectOk(
			replica.write({
				address: target,
				presence: 'present',
				set: { title: 'owned' },
				unset: [],
			}),
		);
	}
	function chainLength(target: RowAddress): number {
		return (
			database.all<{ count: number }>(
				`SELECT COUNT(*) AS count FROM document_updates
				 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				[target.namespace, target.tableName, target.rowId],
			)[0]?.count ?? 0
		);
	}
	return { rawDatabase, database, replica, documents, createRow, chainLength };
}

function createScriptedAuthority() {
	let state: AuthorityState = expectOk(
		createAuthority(AUTHORITY_LIFETIME, SCALAR_V1_LIMITS),
	);

	const transport: ScalarTransport = {
		async readFacts(request): Promise<TransportOutcome> {
			const admitted = parseFactsRequest(request, SCALAR_V1_LIMITS);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const result = readFacts(state, admitted.data, SCALAR_V1_LIMITS);
			if (result.error !== null) {
				return result.error.name === 'LifetimeMismatch'
					? {
							kind: 'refused',
							refusal: {
								code: 'lifetime-mismatch',
								activeLifetime: state.lifetime,
							},
						}
					: { kind: 'refused', refusal: { code: 'sequence-ahead' } };
			}
			return { kind: 'response', body: result.data };
		},
		async submit(request): Promise<TransportOutcome> {
			const admitted = parseSubmissionRequest(request, SCALAR_V1_LIMITS);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const result = submit(state, admitted.data, SCALAR_V1_LIMITS);
			if (result.error !== null) {
				const refusal =
					result.error.name === 'LifetimeMismatch'
						? ({
								code: 'lifetime-mismatch',
								activeLifetime: state.lifetime,
							} as const)
						: result.error.name === 'SubmissionFork'
							? ({ code: 'submission-fork' } as const)
							: ({ code: 'submission-gap' } as const);
				return { kind: 'refused', refusal };
			}
			state = result.data.state;
			return { kind: 'response', body: result.data.response };
		},
	};

	return { transport };
}

function encodeText(text: string): Uint8Array {
	const authored = new Y.Doc();
	try {
		authored.get('content').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(authored));
	} finally {
		authored.destroy();
	}
}

test('local edits advance the obligation; accepted installs never do', async () => {
	const context = setup();
	try {
		const target = address('provenance');
		context.createRow(target);
		const document = await context.documents.open(target);

		document.transact(() => document.get('content').insert(0, 'local'));
		expect(context.documents.publication.status(target)).toEqual({
			revision: 1,
			acceptedRevision: 0,
			issue: null,
		});
		expect(context.documents.publication.listDirty()).toEqual([target]);

		applyRowDocumentUpdate(
			document,
			encodeText('remote'),
			acceptedDocumentOrigin,
		);
		// The accepted bytes are durably persisted, yet the obligation is
		// untouched: authority state never republishes itself.
		expect(context.chainLength(target)).toBe(2);
		expect(context.documents.publication.status(target)?.revision).toBe(1);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('an accepted-only document never enters the drain', async () => {
	const context = setup();
	try {
		const target = address('accepted-only');
		context.createRow(target);
		const document = await context.documents.open(target);
		applyRowDocumentUpdate(
			document,
			encodeText('hydrated from authority'),
			acceptedDocumentOrigin,
		);
		expect(context.chainLength(target)).toBe(1);
		expect(context.documents.publication.status(target)).toBeUndefined();
		expect(context.documents.publication.listDirty()).toEqual([]);
		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('capture reads current state; a racing edit advances the revision', async () => {
	const context = setup();
	try {
		const target = address('capture');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'first'));

		const first = context.documents.publication.capture(target);
		expect(first?.revision).toBe(1);

		// A racing local edit advances the revision; the next capture
		// reconstructs the newer complete state instead of replaying old bytes.
		document.transact(() => document.get('content').insert(5, ' race'));
		const second = context.documents.publication.capture(target);
		expect(second?.revision).toBe(2);
		expect(second?.update).not.toEqual(first?.update);

		const hydrated = new Y.Doc();
		try {
			Y.applyUpdateV2(hydrated, second?.update ?? new Uint8Array());
			expect(hydrated.get('content').toString()).toBe('first race');
		} finally {
			hydrated.destroy();
		}

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('settling revision N never clears revision N+1', async () => {
	const context = setup();
	try {
		const target = address('settle');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'one'));
		const captured = context.documents.publication.capture(target);
		if (captured === undefined) throw new Error('expected a capture');

		// Work authored while revision 1 is in flight stays owed through its
		// acceptance: the authority proved revision 1, not revision 2.
		document.transact(() => document.get('content').insert(3, ' two'));
		context.documents.publication.settle(target, captured.revision);
		expect(context.documents.publication.status(target)).toEqual({
			revision: 2,
			acceptedRevision: 1,
			issue: null,
		});
		expect(context.documents.publication.listDirty()).toEqual([target]);

		// Publishing the newer revision settles it completely.
		const next = context.documents.publication.capture(target);
		if (next === undefined) throw new Error('expected a second capture');
		expect(next.revision).toBe(2);
		context.documents.publication.settle(target, next.revision);
		expect(context.documents.publication.listDirty()).toEqual([]);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('too-large records a terminal issue that later edits do not resume', async () => {
	const context = setup();
	try {
		const target = address('toolarge');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'huge'));

		context.documents.publication.recordIssue(target);
		expect(context.documents.publication.listDirty()).toEqual([]);
		expect(context.documents.publication.capture(target)).toBeUndefined();
		expect(await document.syncIssue()).toEqual({ kind: 'too-large' });

		// The lineage stays locally durable and editable, but a later edit
		// does not silently resume publication (ADR-0174).
		document.transact(() => document.get('content').insert(0, 'still local'));
		expect(context.documents.publication.listDirty()).toEqual([]);
		expect(context.documents.publication.status(target)?.issue).toEqual({
			kind: 'too-large',
		});

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('settled row deletion removes the obligation in the same transaction as the chain', async () => {
	const context = setup();
	try {
		const authority = createScriptedAuthority();
		expectOk(
			context.replica.attach({
				deploymentId: 'https://example.com/',
				principalId: 'principal-a',
			}),
		);
		expectOk(await context.replica.pullFacts(authority.transport));
		const doomed = address('doomed');
		const kept = address('kept');
		context.createRow(doomed);
		context.createRow(kept);
		expectOk(await context.replica.pushSubmissions(authority.transport));
		for (const target of [doomed, kept]) {
			const document = await context.documents.open(target);
			document.transact(() => document.get('content').insert(0, 'owed'));
			await document[Symbol.asyncDispose]();
		}

		expectOk(
			context.replica.write({
				address: doomed,
				presence: 'absent',
			}),
		);
		expectOk(await context.replica.pushSubmissions(authority.transport));
		expect(context.chainLength(doomed)).toBe(0);
		expect(context.documents.publication.status(doomed)).toBeUndefined();
		expect(context.documents.publication.listDirty()).toEqual([kept]);
	} finally {
		context.rawDatabase.close();
	}
});

test('compaction preserves the obligation record and its revisions', async () => {
	const context = setup();
	try {
		const target = address('compact');
		context.createRow(target);
		const document = await context.documents.open(target);
		for (let index = 0; index < 64; index += 1) {
			document.transact(() =>
				document.get('content').insert(document.get('content').length, 'b'),
			);
		}
		expect(context.chainLength(target)).toBe(1);
		expect(context.documents.publication.status(target)?.revision).toBe(64);
		expect(context.documents.publication.capture(target)?.revision).toBe(64);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('drain settles accepted work, records too-large, and keeps not-live dirty', async () => {
	const context = setup();
	try {
		const settled = address('drainsettles');
		const refused = address('draintoolarge');
		const dead = address('drainnotlive');
		for (const target of [settled, refused, dead]) {
			context.createRow(target);
			const document = await context.documents.open(target);
			document.transact(() => document.get('content').insert(0, 'owed'));
			await document[Symbol.asyncDispose]();
		}

		const published: string[] = [];
		const outcome = await context.documents.drainPublications(
			({ address: target }) => {
				published.push(target.rowId);
				if (target.rowId === settled.rowId) return 'accepted';
				if (target.rowId === refused.rowId) return 'too-large';
				return 'not-live';
			},
		);
		expect(outcome.error).toBeNull();
		expect(published.toSorted()).toEqual(
			[settled.rowId, refused.rowId, dead.rowId].toSorted(),
		);

		expect(context.documents.publication.status(settled)).toEqual({
			revision: 1,
			acceptedRevision: 1,
			issue: null,
		});
		// The bound refusal is terminal for the lineage and blocks nothing else.
		expect(context.documents.publication.status(refused)?.issue).toEqual({
			kind: 'too-large',
		});
		// The not-live address stays dirty; the scalar plane will deliver the
		// deletion that removes the whole record.
		expect(context.documents.publication.status(dead)).toEqual({
			revision: 1,
			acceptedRevision: 0,
			issue: null,
		});
		expect(context.documents.publication.listDirty()).toEqual([dead]);
	} finally {
		context.rawDatabase.close();
	}
});

test('transport interruption keeps work owed; the retry sends current state', async () => {
	const context = setup();
	try {
		const target = address('draininterrupted');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'one'));

		const failing = await context.documents.drainPublications(() => {
			throw new Error('connection dropped');
		});
		expect(failing.error?.name).toBe('TransportFailed');
		expect(context.documents.publication.listDirty()).toEqual([target]);

		// An edit between attempts means the retry reconstructs and submits
		// newer state; nothing pins the failed attempt's exact bytes.
		document.transact(() => document.get('content').insert(3, ' two'));
		const sent: Uint8Array[] = [];
		const retried = await context.documents.drainPublications(({ update }) => {
			sent.push(update);
			return 'accepted';
		});
		expect(retried.error).toBeNull();
		const hydrated = new Y.Doc();
		try {
			Y.applyUpdateV2(hydrated, sent[0] ?? new Uint8Array());
			expect(hydrated.get('content').toString()).toBe('one two');
		} finally {
			hydrated.destroy();
		}
		expect(context.documents.publication.listDirty()).toEqual([]);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('repeated publication of the same state is semantically idempotent', async () => {
	const context = setup();
	try {
		const target = address('idempotent');
		context.createRow(target);
		const document = await context.documents.open(target);
		document.transact(() => document.get('content').insert(0, 'same'));
		const captured = context.documents.publication.capture(target);
		if (captured === undefined) throw new Error('expected a capture');

		// The authority applying the same full-state update twice converges to
		// one identical document: a lost acknowledgement retries safely.
		const authority = new Y.Doc({ gc: true });
		try {
			Y.applyUpdateV2(authority, new Uint8Array(captured.update));
			const once = new Uint8Array(Y.encodeStateAsUpdateV2(authority));
			Y.applyUpdateV2(authority, new Uint8Array(captured.update));
			const twice = new Uint8Array(Y.encodeStateAsUpdateV2(authority));
			expect(twice).toEqual(once);
			expect(authority.get('content').toString()).toBe('same');
		} finally {
			authority.destroy();
		}

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('pull applies accepted state without minting an outbound obligation', async () => {
	const remote = encodeText('remote content');
	const pulls: { sinceVersion: string | undefined }[] = [];
	const context = setup({
		pull: async ({ sinceVersion }) => {
			pulls.push({ sinceVersion });
			if (sinceVersion === 'v1') return { kind: 'unchanged' };
			return { kind: 'state', version: 'v1', update: remote };
		},
	});
	try {
		const target = address('pullaccepts');
		context.createRow(target);
		const document = await context.documents.open(target);

		const first = await document.pull();
		expect(first.error).toBeNull();
		expect(document.get('content').toString()).toBe('remote content');
		// Accepted inbound bytes are durable but owe nothing outbound.
		expect(context.chainLength(target)).toBe(1);
		expect(context.documents.publication.status(target)).toBeUndefined();

		// The second pull presents the cached version and transfers no body.
		const second = await document.pull();
		expect(second.error).toBeNull();
		expect(pulls).toEqual([
			{ sinceVersion: undefined },
			{ sinceVersion: 'v1' },
		]);

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('overlapping pulls share one in-flight request', async () => {
	let resolveTransport: ((response: DocumentPullResponse) => void) | undefined;
	let calls = 0;
	const context = setup({
		pull: () => {
			calls += 1;
			return new Promise<DocumentPullResponse>((resolve) => {
				resolveTransport = resolve;
			});
		},
	});
	try {
		const target = address('pulloverlap');
		context.createRow(target);
		const document = await context.documents.open(target);

		const first = document.pull();
		const second = document.pull();
		expect(calls).toBe(1);
		resolveTransport?.({
			kind: 'state',
			version: 'v1',
			update: encodeText('merged'),
		});
		expect((await first).error).toBeNull();
		expect((await second).error).toBeNull();
		expect(document.get('content').toString()).toBe('merged');

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('a pull that resolves after disposal cannot mutate the document', async () => {
	let resolveTransport: ((response: DocumentPullResponse) => void) | undefined;
	const context = setup({
		pull: () =>
			new Promise<DocumentPullResponse>((resolve) => {
				resolveTransport = resolve;
			}),
	});
	try {
		const target = address('pulllate');
		context.createRow(target);
		const document = await context.documents.open(target);
		const pending = document.pull();
		await document[Symbol.asyncDispose]();

		resolveTransport?.({
			kind: 'state',
			version: 'v9',
			update: encodeText('too late'),
		});
		// The late result is dropped; nothing was applied or persisted.
		expect((await pending).error).toBeNull();
		expect(context.chainLength(target)).toBe(0);
	} finally {
		context.rawDatabase.close();
	}
});

test('pull reports failures without closing the local document', async () => {
	let mode: 'offline' | 'not-live' = 'offline';
	const context = setup({
		pull: async () => {
			if (mode === 'offline') throw new Error('network unreachable');
			return { kind: 'not-live' };
		},
	});
	try {
		const target = address('pullfails');
		context.createRow(target);
		const document = await context.documents.open(target);

		const offline = await document.pull();
		expect(offline.error?.name).toBe('TransportFailed');

		mode = 'not-live';
		const dead = await document.pull();
		expect(dead.error?.name).toBe('RowNotLive');

		// Failures leave the locally durable document open and editable.
		document.transact(() => document.get('content').insert(0, 'still mine'));
		expect(document.get('content').toString()).toBe('still mine');

		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});

test('pull without an attached session reports NotAttached', async () => {
	const context = setup();
	try {
		const target = address('pullunattached');
		context.createRow(target);
		const document = await context.documents.open(target);
		const result = await document.pull();
		expect(result.error?.name).toBe('NotAttached');
		await document[Symbol.asyncDispose]();
	} finally {
		context.rawDatabase.close();
	}
});
