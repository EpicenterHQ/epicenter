import type { SyncAuthClient } from '@epicenter/auth';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type {
	AuthorityCarrier,
	EpicenterRuntime,
} from '@epicenter/data/runtime';
import { openBrowserEpicenter } from '@epicenter/data/runtime/browser';

type WhisperingAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'onStateChange'
>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

function syncUrl(auth: WhisperingAuth, path: string): URL {
	return new URL(`api/sync/v1/${path}`, deploymentUrl(auth.deployment.baseURL));
}

/**
 * The HTTP authority carrier over the signed-in deployment. Whispering's Lens
 * uses no record documents or record blobs, so those planes honestly refuse:
 * the supervisor never owes work it cannot create.
 */
function createCarrier(auth: WhisperingAuth): AuthorityCarrier<Blob> {
	return {
		async fetchFacts(request) {
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
		async publishDocument() {
			throw new Error('Whispering publishes no record documents');
		},
		async publishBlob() {
			throw new Error('Whispering publishes no record blobs');
		},
	};
}

/** Open this browser origin's replica and follow the auth session's sign-in state. */
export async function openWhisperingBrowserEpicenter({
	auth,
	reportBackgroundError,
}: {
	auth: WhisperingAuth;
	reportBackgroundError(cause: unknown): void;
}): Promise<EpicenterRuntime<Blob, Blob>> {
	const browser = await openBrowserEpicenter({ carrier: createCarrier(auth) });

	const syncAuthState = async () => {
		const state = auth.state;
		if (state.status !== 'signed-in') {
			browser.signOut();
			return;
		}
		browser.signIn();
		const outcome = await browser.attach({
			deploymentId: deploymentUrl(auth.deployment.baseURL).href,
			principalId: state.principalId,
		});
		if (outcome.kind === 'first-attachment-choice') {
			// Match the pre-W4 attach semantics: records created before the first
			// sign-in join the account. Surfacing a bring/discard choice is a
			// product decision this composition root does not own.
			await outcome.proceed('bring');
		}
	};

	try {
		await syncAuthState();
	} catch (cause) {
		await browser[Symbol.asyncDispose]();
		throw cause;
	}
	const stopAuth = auth.onStateChange(() => {
		void syncAuthState().catch(reportBackgroundError);
	});

	return Object.freeze({
		...browser,
		async [Symbol.asyncDispose]() {
			stopAuth();
			await browser[Symbol.asyncDispose]();
		},
	});
}
