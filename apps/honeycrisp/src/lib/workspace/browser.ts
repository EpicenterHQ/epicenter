import type { SyncAuthClient } from '@epicenter/auth';
import {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
	type DocumentAcceptance,
	type DocumentPull,
	documentVersionTag,
	readDocumentAcceptance,
	readDocumentPull,
} from '@epicenter/data/document-v1';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type {
	AuthorityCarrier,
	DocumentPullCarrier,
	EpicenterRuntime,
} from '@epicenter/data/runtime';
import { openBrowserEpicenter } from '@epicenter/data/runtime/browser';

type HoneycrispAuth = Pick<SyncAuthClient, 'state' | 'deployment' | 'fetch'>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

function syncUrl(auth: HoneycrispAuth, path: string): URL {
	return new URL(`api/sync/v1/${path}`, deploymentUrl(auth.deployment.baseURL));
}

function recordPath(address: {
	namespace: string;
	collection: string;
	recordKey: string;
}): string {
	return `records/${address.namespace}/${address.collection}/${address.recordKey}`;
}

/** The signed-in account's immutable replica identity on this deployment. */
export function honeycrispReplicaOwner(
	auth: HoneycrispAuth,
): { deploymentId: string; principalId: string } | null {
	const state = auth.state;
	if (state.status !== 'signed-in') return null;
	return {
		deploymentId: deploymentUrl(auth.deployment.baseURL).href,
		principalId: state.principalId,
	};
}

/**
 * The authority carrier over the signed-in deployment. Honeycrisp notes own
 * record documents, so the document planes are real: complete-state
 * publication settles obligations over HTTP automatically, and the
 * application decides when an open note pulls accepted authority state. The
 * Lens captures no record blobs, so that plane honestly refuses.
 *
 * The carrier is bound to the identity it was opened for: if the signed-in
 * account changes while the old runtime is still draining or disposing, every
 * request refuses instead of borrowing the next account's credentials.
 */
function createCarrier(
	auth: HoneycrispAuth,
	opened: { deploymentId: string; principalId: string },
): AuthorityCarrier<Blob> & DocumentPullCarrier {
	function requireOpenedOwner(): void {
		const current = honeycrispReplicaOwner(auth);
		if (
			current === null ||
			current.deploymentId !== opened.deploymentId ||
			current.principalId !== opened.principalId
		) {
			throw new Error('authority carrier outlived its sign-in');
		}
	}
	return {
		async fetchFacts(request) {
			requireOpenedOwner();
			const url = syncUrl(auth, 'facts');
			url.searchParams.set('afterSequence', String(request.afterSequence));
			if (request.authorityLifetime !== undefined) {
				url.searchParams.set('authorityLifetime', request.authorityLifetime);
			}
			const response = await auth.fetch(url);
			if (!response.ok) {
				throw new Error(`Epicenter facts read failed (${response.status})`);
			}
			const { data, error } = parseFactsResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (error !== null) throw error;
			return data;
		},
		async submit(sealedRequestBytes) {
			requireOpenedOwner();
			const response = await auth.fetch(syncUrl(auth, 'submissions'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: sealedRequestBytes,
			});
			if (!response.ok) {
				throw new Error(`Epicenter submission failed (${response.status})`);
			}
			const { data, error } = parseSubmissionResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (error !== null) throw error;
			return data;
		},
		async publishDocument(address, publication): Promise<DocumentAcceptance> {
			requireOpenedOwner();
			const response = await auth.fetch(
				syncUrl(auth, `${recordPath(address)}/document-publications`),
				{
					method: 'POST',
					headers: {
						'content-type': 'application/octet-stream',
						[DOCUMENT_LIFETIME_HEADER]: publication.authorityLifetime,
						[DOCUMENT_PROTOCOL_HEADER]: publication.protocolVersion,
						[DOCUMENT_DIGEST_HEADER]: publication.digest,
					},
					body: publication.payload.slice().buffer as ArrayBuffer,
				},
			);
			return await readDocumentAcceptance(response, SCALAR_SYNC_V1_LIMITS);
		},
		async pullDocument(address, request): Promise<DocumentPull> {
			requireOpenedOwner();
			const response = await auth.fetch(
				syncUrl(auth, `${recordPath(address)}/document`),
				{
					headers: {
						[DOCUMENT_LIFETIME_HEADER]: request.authorityLifetime,
						...(request.knownDocumentVersion === null
							? {}
							: {
									'if-none-match': documentVersionTag(
										request.knownDocumentVersion,
									),
								}),
					},
				},
			);
			return await readDocumentPull(response, SCALAR_SYNC_V1_LIMITS);
		},
		async publishBlob() {
			throw new Error('Honeycrisp captures no record blobs');
		},
	};
}

/**
 * Open the replica the current authentication state selects (ADR-0178):
 * the signed-in account's replica with synchronization authority, or this
 * origin's unclaimed local-only replica when signed out. Authentication
 * changes are session boundaries; the caller reopens instead of mutating a
 * live runtime.
 */
export async function openHoneycrispBrowserEpicenter({
	auth,
}: {
	auth: HoneycrispAuth;
}): Promise<EpicenterRuntime<Blob, Blob>> {
	const owner = honeycrispReplicaOwner(auth);
	if (owner === null) return await openBrowserEpicenter({ owner: null });
	return await openBrowserEpicenter({
		owner,
		carrier: createCarrier(auth, owner),
	});
}
