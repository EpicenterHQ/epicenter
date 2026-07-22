import { pushToTalk } from '../operations/push-to-talk';
import { createWhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { createRecipes } from '../state/recipes.svelte';
import { createRecordings } from '../state/recordings.svelte';
import { createSettingsView } from '../state/settings.svelte';
import {
	openWhisperingApp,
	type WhisperingApp,
	type WhisperingAppDependencies,
} from './app';

function createWhisperingUiSession(core: WhisperingApp) {
	const app: WhisperingApp = {
		...core,
		settings: createSettingsView(core.settings),
		recordings: createRecordings(core),
		recipes: createRecipes(core),
		get identity() {
			return core.identity;
		},
		get attachment() {
			return core.attachment;
		},
		get syncStatus() {
			return core.syncStatus;
		},
		subscribeIdentity: core.subscribeIdentity,
		subscribeAttachment: core.subscribeAttachment,
		subscribeSyncStatus: core.subscribeSyncStatus,
		chooseFirstAttachment: core.chooseFirstAttachment,
		...(core.beginAuthenticatedRequest === undefined
			? {}
			: { beginAuthenticatedRequest: core.beginAuthenticatedRequest }),
	};
	const queryRuntime = createWhisperingQueryRuntime();
	const queries = createWhisperingQueries(app, queryRuntime);
	let disposal: Promise<void> | undefined;

	return {
		app,
		queries,
		queryClient: queryRuntime.queryClient,
		[Symbol.asyncDispose]() {
			disposal ??= (async () => {
				try {
					await pushToTalk.dispose(app);
				} finally {
					queryRuntime.queryClient.clear();
					await core[Symbol.asyncDispose]();
				}
			})();
			return disposal;
		},
	};
}

export type WhisperingUiSession = ReturnType<typeof createWhisperingUiSession>;

export async function openWhisperingUiSession<TSource, TRead, TCreateSource>(
	dependencies: WhisperingAppDependencies<TSource, TRead, TCreateSource>,
	signal: AbortSignal,
): Promise<WhisperingUiSession> {
	const core = await openWhisperingApp(dependencies, { signal });
	try {
		return createWhisperingUiSession(core);
	} catch (cause) {
		await core[Symbol.asyncDispose]();
		throw cause;
	}
}
