import type { SyncAuthClient } from '@epicenter/auth';
import { openBrowserRecordEpicenter } from '@epicenter/data/browser-record';
import {
	createHttpRecordSyncSession,
	type FirstAttachmentChoice,
	type RecordEpicenter,
	type SyncCredentialProvider,
} from '@epicenter/data/record';
import type {
	WhisperingAuthenticatedRequest,
	WhisperingReplicaIdentityState,
} from './app';

type WhisperingAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'onStateChange'
>;

export type WhisperingBrowserEpicenter = RecordEpicenter<Blob, Blob> & {
	readonly identity: WhisperingReplicaIdentityState;
	subscribeIdentity(
		listener: (state: WhisperingReplicaIdentityState) => void,
	): () => void;
	chooseFirstAttachment(choice: FirstAttachmentChoice): Promise<void>;
	beginAuthenticatedRequest(): WhisperingAuthenticatedRequest;
};

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

/** Open this browser origin's record owner and attach sync when identity permits. */
export async function openWhisperingBrowserEpicenter({
	auth,
	reportBackgroundError,
	openEpicenter = openBrowserRecordEpicenter,
}: {
	auth: WhisperingAuth;
	reportBackgroundError(cause: unknown): void;
	openEpicenter?: typeof openBrowserRecordEpicenter;
}): Promise<WhisperingBrowserEpicenter> {
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
	let isDisposed = false;
	let attachTail = Promise.resolve();
	let identityGeneration = 0;
	let identity: WhisperingReplicaIdentityState = { kind: 'ready' };
	const authenticatedOperations = new Set<AbortController>();
	const attachmentOperations = new Set<AbortController>();
	const identityListeners = new Set<
		(state: WhisperingReplicaIdentityState) => void
	>();

	function deriveIdentity(): WhisperingReplicaIdentityState {
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
		operation: 'attaching local recordings' | 'sending a transcription',
	): void {
		const state = auth.state;
		if (
			generation !== identityGeneration ||
			state.status !== 'signed-in' ||
			state.principalId !== principalId
		) {
			throw new Error(`Authentication changed while ${operation}`);
		}
	}

	function beginAuthenticatedRequest(): WhisperingAuthenticatedRequest {
		if (isDisposed) throw new Error('Whispering browser runtime is disposed');
		const state = auth.state;
		if (state.status !== 'signed-in') {
			throw new Error('Sign in before sending a transcription to Epicenter');
		}
		updateIdentity();
		if (identity.kind === 'principal-mismatch') {
			throw new Error(
				`Local recordings are attached to principal '${identity.attachedPrincipalId}', not signed-in principal '${identity.signedInPrincipalId}'`,
			);
		}
		const generation = identityGeneration;
		const principalId = state.principalId;
		const operation = 'sending a transcription' as const;
		requirePrincipalGeneration(generation, principalId, operation);
		return Object.freeze({
			baseURL: deploymentId,
			fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
				const controller = new AbortController();
				authenticatedOperations.add(controller);
				try {
					requirePrincipalGeneration(generation, principalId, operation);
					const signal = init?.signal
						? AbortSignal.any([controller.signal, init.signal])
						: controller.signal;
					const response = await auth.fetch(request, { ...init, signal });
					requirePrincipalGeneration(generation, principalId, operation);
					return response;
				} finally {
					authenticatedOperations.delete(controller);
				}
			},
		});
	}

	async function attachSignedIn(
		choice?: FirstAttachmentChoice,
		requireSignedIn = false,
	): Promise<void> {
		if (isDisposed) throw new Error('Whispering browser runtime is disposed');
		const state = auth.state;
		if (state.status !== 'signed-in') {
			if (requireSignedIn)
				throw new Error('Sign in before attaching local recordings');
			return;
		}
		updateIdentity();
		if (identity.kind === 'principal-mismatch') {
			throw new Error(
				`Local recordings are attached to principal '${identity.attachedPrincipalId}', not signed-in principal '${identity.signedInPrincipalId}'`,
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
		requirePrincipalGeneration(
			generation,
			principalId,
			'attaching local recordings',
		);
		const controller = new AbortController();
		attachmentOperations.add(controller);
		try {
			await epicenter.attachSync(
				createHttpRecordSyncSession<Blob>({
					deploymentId,
					principalId,
					credentials,
					...(choice === undefined ? {} : { firstAttachmentChoice: choice }),
					fetch: async (request) => {
						requirePrincipalGeneration(
							generation,
							principalId,
							'attaching local recordings',
						);
						const response = await auth.fetch(request, {
							signal: controller.signal,
						});
						requirePrincipalGeneration(
							generation,
							principalId,
							'attaching local recordings',
						);
						return response;
					},
				}),
			);
		} finally {
			attachmentOperations.delete(controller);
		}
		requirePrincipalGeneration(
			generation,
			principalId,
			'attaching local recordings',
		);
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
		for (const controller of authenticatedOperations) {
			controller.abort(
				new Error('Authentication changed while sending a transcription'),
			);
		}
		authenticatedOperations.clear();
		for (const controller of attachmentOperations) {
			controller.abort(
				new Error('Authentication changed while attaching local recordings'),
			);
		}
		attachmentOperations.clear();
		updateIdentity();
		void enqueueAttachment().catch(reportBackgroundError);
	});
	const stopIdentityAttachment = epicenter.subscribeAttachment(updateIdentity);
	updateIdentity();
	await enqueueAttachment().catch(reportBackgroundError);

	return Object.freeze({
		bind: epicenter.bind,
		attachSync: epicenter.attachSync,
		get attachment() {
			return epicenter.attachment;
		},
		subscribeAttachment: epicenter.subscribeAttachment,
		get syncStatus() {
			return epicenter.syncStatus;
		},
		subscribeSyncStatus: epicenter.subscribeSyncStatus,
		parkedWork: epicenter.parkedWork,
		inspectRecord: epicenter.inspectRecord,
		get identity() {
			return identity;
		},
		subscribeIdentity(
			listener: (state: WhisperingReplicaIdentityState) => void,
		) {
			identityListeners.add(listener);
			return () => identityListeners.delete(listener);
		},
		chooseFirstAttachment(choice: FirstAttachmentChoice) {
			return enqueueAttachment(choice, true);
		},
		beginAuthenticatedRequest,
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			isDisposed = true;
			for (const controller of authenticatedOperations) {
				controller.abort(new Error('Whispering browser runtime is disposed'));
			}
			authenticatedOperations.clear();
			for (const controller of attachmentOperations) {
				controller.abort(new Error('Whispering browser runtime is disposed'));
			}
			attachmentOperations.clear();
			stopAuth();
			stopIdentityAttachment();
			identityListeners.clear();
			await attachTail;
			await epicenter[Symbol.asyncDispose]();
		},
	});
}
