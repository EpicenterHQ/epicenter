import type { SyncAuthClient } from '@epicenter/auth';
import {
	createHttpScalarTransport,
	type Epicenter,
	type SyncCredentialProvider,
} from '@epicenter/data';
import { openBrowserEpicenter } from '@epicenter/data/browser';

type WhisperingAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'onStateChange'
>;

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

/** Open this browser origin's replica and attach it on signed-in auth states. */
export async function openWhisperingBrowserEpicenter({
	auth,
	reportBackgroundError,
}: {
	auth: WhisperingAuth;
	reportBackgroundError(cause: unknown): void;
}): Promise<Epicenter> {
	const browser = await openBrowserEpicenter();
	const credentials: SyncCredentialProvider = {
		get: () => (auth.state.status === 'signed-in' ? 'available' : undefined),
		subscribe: (listener) => auth.onStateChange(listener),
	};
	// One shared carrier owns the URL shape and the refusal versus
	// transport-failure split, so every app reads an authority answer the same way.
	const transport = createHttpScalarTransport({
		baseUrl: deploymentUrl(auth.deployment.baseURL).href,
		fetch: (url, init) => auth.fetch(new URL(url), init),
	});

	const attachSignedIn = async () => {
		const state = auth.state;
		if (state.status !== 'signed-in') return;
		const attachment = Object.freeze({
			deploymentId: deploymentUrl(auth.deployment.baseURL).href,
			principalId: state.principalId,
		});
		const result = await browser.attachSync({
			...attachment,
			transport,
			credentials,
		});
		if (result.error !== null) throw result.error;
	};

	try {
		await attachSignedIn();
	} catch (cause) {
		await browser[Symbol.asyncDispose]();
		throw cause;
	}
	const stopAuth = auth.onStateChange(() => {
		void attachSignedIn().catch(reportBackgroundError);
	});

	return Object.freeze({
		bind: browser.bind,
		attachSync: browser.attachSync,
		get syncStatus() {
			return browser.syncStatus;
		},
		subscribeSyncStatus: browser.subscribeSyncStatus,
		async [Symbol.asyncDispose]() {
			stopAuth();
			await browser[Symbol.asyncDispose]();
		},
	});
}
