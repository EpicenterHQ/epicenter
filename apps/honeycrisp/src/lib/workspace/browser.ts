import type { SyncAuthClient } from '@epicenter/auth';
import { openBrowserRecordEpicenter } from '@epicenter/data/browser-record';
import {
	createHttpRecordSyncSession,
	type FirstAttachmentChoice,
	type RowDocument,
	type SyncCredentialProvider,
} from '@epicenter/data/record';
import {
	connectRecordDocument,
	type RecordAuthorityLifetimeProvider,
} from '@epicenter/document-sync';

type WorkspaceAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'openWebSocket' | 'onStateChange'
>;

export type HoneycrispReplicaIdentityState =
	| { kind: 'ready' }
	| {
			kind: 'principal-mismatch';
			attachedPrincipalId: string;
			signedInPrincipalId: string;
	  };

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

/** Open this browser origin's record owner and attach sync when it is safe. */
export async function openHoneycrispBrowserEpicenter({
	auth,
	reportBackgroundError,
	openEpicenter = openBrowserRecordEpicenter,
}: {
	auth: WorkspaceAuth;
	reportBackgroundError(cause: unknown): void;
	openEpicenter?: typeof openBrowserRecordEpicenter;
}) {
	const epicenter = await openEpicenter();
	const deploymentId = deploymentUrl(auth.deployment.baseURL).href;
	const credentials: SyncCredentialProvider = {
		get: () => {
			const state = auth.state;
			const attachment = epicenter.attachment;
			if (state.status !== 'signed-in') return undefined;
			if (
				attachment.kind === 'attached' &&
				(attachment.attachment.deploymentId !== deploymentId ||
					attachment.attachment.principalId !== state.principalId)
			) {
				return undefined;
			}
			return 'available';
		},
		subscribe: (listener) => auth.onStateChange(listener),
	};
	const authorityLifetime: RecordAuthorityLifetimeProvider = {
		get: () => epicenter.syncStatus.authorityLifetime,
		subscribe(listener) {
			let observed = epicenter.syncStatus.authorityLifetime;
			return epicenter.subscribeSyncStatus((status) => {
				if (status.authorityLifetime === observed) return;
				observed = status.authorityLifetime;
				listener();
			});
		},
	};
	let isDisposed = false;
	let attachTail = Promise.resolve();
	let identityGeneration = 0;
	let identity: HoneycrispReplicaIdentityState = { kind: 'ready' };
	const identityListeners = new Set<
		(state: HoneycrispReplicaIdentityState) => void
	>();

	function deriveIdentity(): HoneycrispReplicaIdentityState {
		const state = auth.state;
		const attachment = epicenter.attachment;
		if (
			state.status === 'signed-in' &&
			attachment.kind === 'attached' &&
			(attachment.attachment.deploymentId !== deploymentId ||
				attachment.attachment.principalId !== state.principalId)
		) {
			return {
				kind: 'principal-mismatch',
				attachedPrincipalId: attachment.attachment.principalId,
				signedInPrincipalId: state.principalId,
			};
		}
		return { kind: 'ready' };
	}

	function updateIdentity(): void {
		const next = deriveIdentity();
		if (
			next.kind === identity.kind &&
			(next.kind === 'ready' ||
				(identity.kind === 'principal-mismatch' &&
					next.attachedPrincipalId === identity.attachedPrincipalId &&
					next.signedInPrincipalId === identity.signedInPrincipalId))
		) {
			return;
		}
		identity = next;
		for (const listener of identityListeners) listener(next);
	}

	function requirePrincipalGeneration(
		generation: number,
		principalId: string,
	): void {
		const state = auth.state;
		if (
			generation !== identityGeneration ||
			state.status !== 'signed-in' ||
			state.principalId !== principalId
		) {
			throw new Error('Authentication changed while attaching local notes');
		}
	}

	function requireReadyPrincipal(
		generation: number,
		principalId: string,
	): void {
		requirePrincipalGeneration(generation, principalId);
		updateIdentity();
		if (identity.kind === 'principal-mismatch') {
			throw new Error('Signed-in principal does not own this local replica');
		}
	}

	async function attachSignedIn(
		choice?: FirstAttachmentChoice,
		requireSignedIn = false,
	): Promise<void> {
		if (isDisposed) throw new Error('Honeycrisp browser runtime is disposed');
		const state = auth.state;
		if (state.status !== 'signed-in') {
			if (requireSignedIn)
				throw new Error('Sign in before attaching local notes');
			return;
		}
		updateIdentity();
		if (identity.kind === 'principal-mismatch') {
			throw new Error(
				`Local notes are attached to principal '${identity.attachedPrincipalId}', not signed-in principal '${identity.signedInPrincipalId}'`,
			);
		}
		if (
			choice === undefined &&
			epicenter.attachment.kind === 'unattached' &&
			epicenter.attachment.requiresChoice
		) {
			return;
		}
		const generation = identityGeneration;
		const principalId = state.principalId;
		requirePrincipalGeneration(generation, principalId);
		await epicenter.attachSync(
			createHttpRecordSyncSession<Blob>({
				deploymentId,
				principalId,
				credentials,
				...(choice === undefined ? {} : { firstAttachmentChoice: choice }),
				fetch: async (request) => {
					requirePrincipalGeneration(generation, principalId);
					const response = await auth.fetch(request);
					requirePrincipalGeneration(generation, principalId);
					return response;
				},
			}),
		);
		requirePrincipalGeneration(generation, principalId);
		updateIdentity();
	}

	function enqueueAttachment(
		choice?: FirstAttachmentChoice,
		requireSignedIn = false,
	): Promise<void> {
		const operation = attachTail.then(() =>
			attachSignedIn(choice, requireSignedIn),
		);
		attachTail = operation.catch(() => undefined);
		return operation;
	}

	const stopAuth = auth.onStateChange(() => {
		identityGeneration += 1;
		updateIdentity();
		void enqueueAttachment().catch(reportBackgroundError);
	});
	const stopIdentityAttachment = epicenter.subscribeAttachment(updateIdentity);
	updateIdentity();
	await enqueueAttachment().catch(reportBackgroundError);

	return Object.freeze({
		epicenter,
		get identity(): HoneycrispReplicaIdentityState {
			return identity;
		},
		subscribeIdentity(
			listener: (state: HoneycrispReplicaIdentityState) => void,
		) {
			identityListeners.add(listener);
			return () => identityListeners.delete(listener);
		},
		chooseFirstAttachment(choice: FirstAttachmentChoice) {
			return enqueueAttachment(choice, true);
		},
		connectDocument(document: RowDocument) {
			return connectRecordDocument({
				document,
				baseUrl: auth.deployment.baseURL,
				authorityLifetime,
				credentials,
				openSocket: async (url, protocols) => {
					const state = auth.state;
					if (state.status !== 'signed-in') {
						throw new Error('Authentication is required for document sync');
					}
					const generation = identityGeneration;
					const principalId = state.principalId;
					requireReadyPrincipal(generation, principalId);
					const socket = await auth.openWebSocket(url, protocols);
					try {
						requireReadyPrincipal(generation, principalId);
					} catch (cause) {
						socket.close();
						throw cause;
					}
					return socket;
				},
			});
		},
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			isDisposed = true;
			stopAuth();
			stopIdentityAttachment();
			identityListeners.clear();
			await attachTail;
			await epicenter[Symbol.asyncDispose]();
		},
	});
}

export type HoneycrispBrowserEpicenter = Awaited<
	ReturnType<typeof openHoneycrispBrowserEpicenter>
>;
