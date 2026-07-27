import type { SyncAuthClient } from '@epicenter/auth';
import {
	createHttpScalarTransport,
	type SyncCredentialProvider,
} from '@epicenter/data';
import { openBrowserEpicenter } from '@epicenter/data/browser';
import { createHttpDocumentTransports } from '@epicenter/document-sync';

type WorkspaceAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'onStateChange'
>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

/** Open this browser origin's replica and attach sync for signed-in auth. */
export async function openHoneycrispBrowserEpicenter({
	auth,
	reportBackgroundError,
}: {
	auth: WorkspaceAuth;
	reportBackgroundError(cause: unknown): void;
}) {
	const epicenter = await openBrowserEpicenter();
	const credentials: SyncCredentialProvider = {
		get: () => (auth.state.status === 'signed-in' ? 'available' : undefined),
		subscribe: (listener) => auth.onStateChange(listener),
	};
	// The shared carrier owns URL shape, status mapping, and the refusal versus
	// transport-failure split. Hand-rolling that here is how an app ends up
	// retrying a terminal lifetime mismatch as if it were a dropped connection.
	const transport = createHttpScalarTransport({
		baseUrl: deploymentUrl(auth.deployment.baseURL).href,
		fetch: (url, init) => auth.fetch(new URL(url), init),
	});

	async function attachSignedIn(): Promise<void> {
		const state = auth.state;
		if (state.status !== 'signed-in') return;
		const attached = await epicenter.attachSync({
			deploymentId: deploymentUrl(auth.deployment.baseURL).href,
			principalId: state.principalId,
			transport,
			...createHttpDocumentTransports({
				baseUrl: auth.deployment.baseURL,
				fetch: (url, init) => auth.fetch(url, init),
			}),
			credentials,
		});
		if (attached.error !== null) throw attached.error;
	}

	try {
		await attachSignedIn();
	} catch (cause) {
		await epicenter[Symbol.asyncDispose]();
		throw cause;
	}
	const stopAuth = auth.onStateChange(() => {
		void attachSignedIn().catch(reportBackgroundError);
	});

	return Object.freeze({
		epicenter,
		async [Symbol.asyncDispose]() {
			stopAuth();
			await epicenter[Symbol.asyncDispose]();
		},
	});
}

export type HoneycrispBrowserEpicenter = Awaited<
	ReturnType<typeof openHoneycrispBrowserEpicenter>
>;
