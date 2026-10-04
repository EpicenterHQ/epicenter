import type { QueryClient } from '@tanstack/svelte-query';
import { pushToTalk } from '../operations/push-to-talk';
import { createWhisperingQueries, type WhisperingQueries } from '../queries';
import { createWhisperingQueryRuntime } from '../queries/client';
import { createRecipes } from '../state/recipes.svelte';
import { createRecordings } from '../state/recordings.svelte';
import { createSettingsView } from '../state/settings.svelte';
import {
	openWhisperingApplication,
	type WhisperingApplication,
	type WhisperingDependencies,
} from './application';

export type WhisperingUiSession = {
	application: WhisperingApplication;
	queries: WhisperingQueries;
	queryClient: QueryClient;
	[Symbol.asyncDispose](): Promise<void>;
};

function createWhisperingUiSession(
	core: WhisperingApplication,
): WhisperingUiSession {
	const application: WhisperingApplication = {
		...core,
		settings: createSettingsView(core.settings),
		recordings: createRecordings(core),
		recipes: createRecipes(core),
	};
	const queryRuntime = createWhisperingQueryRuntime();
	const queries = createWhisperingQueries(application, queryRuntime);
	let disposal: Promise<void> | undefined;

	return {
		application,
		queries,
		queryClient: queryRuntime.queryClient,
		[Symbol.asyncDispose]() {
			disposal ??= (async () => {
				try {
					await pushToTalk.dispose(application);
				} finally {
					queryRuntime.queryClient.clear();
					await core[Symbol.asyncDispose]();
				}
			})();
			return disposal;
		},
	};
}

export async function openWhisperingUiSession(
	dependencies: WhisperingDependencies,
	signal: AbortSignal,
): Promise<WhisperingUiSession> {
	const core = await openWhisperingApplication(dependencies, { signal });
	try {
		return createWhisperingUiSession(core);
	} catch (cause) {
		await core[Symbol.asyncDispose]();
		throw cause;
	}
}
