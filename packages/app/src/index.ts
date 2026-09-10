import type { AiConnections } from './ai-connections.js';
import type { AiTransport } from './ai.js';
import { openApp } from './open.js';
import type { Account } from '@epicenter/auth';
import type { LibraryReplicaIdentity } from '@epicenter/principal';
import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import type { DataDefinition } from '@epicenter/data/definition';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { RecordingFactory } from './recorder.js';
import { resources } from '#platform/resources';
import { browser } from './browser.js';
import { createDefaultAppAi } from '#platform/ai';

export type App<TDefinition extends DataDefinition> = ReturnType<
	typeof openApp<TDefinition>
>;
export type AppSqlite = App<DataDefinition>['sqlite'];
export type AppBlobs = App<DataDefinition>['blobs'];

export type AppBlobComposition = {
	local: BlobStore;
	sources: BlobSources;
	remote: BlobRemote | null;
};

export type AppBlobFactory = (input: {
	appId: string;
	replica: LibraryReplicaIdentity;
	remote: Pick<Account, 'baseURL' | 'fetch'> | null;
}) => AppBlobComposition;

export type Application<TDefinition extends DataDefinition> = {
	readonly appId: string;
	openLocal(): App<TDefinition>;
	openPersonal(account: Account): App<TDefinition>;
	openShared(account: Account): App<TDefinition>;
};

/** Complete implementation selection; App owns the opened resources.
 * Recording must publish IDs readable through this runtime's blobs.
 * Structural types cannot establish that publication/read guarantee.
 */
export type ApplicationRuntime = {
	sqlite: DeviceSqliteOwner;
	secrets: typeof resources.secrets;
	blobs: AppBlobFactory;
	recording: RecordingFactory;
};

/** Declare one application, replacing runtime and AI independently when supplied. */
export function defineApplication<const TDefinition extends DataDefinition>({
	appId,
	definition,
	settingsKey,
	runtime = { ...browser, ...resources },
	ai = createDefaultAppAi(settingsKey ?? appId),
}: {
	appId: string;
	definition: TDefinition;
	settingsKey?: string;
	runtime?: ApplicationRuntime;
	ai?: AppAiBinding;
}): Application<TDefinition> {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const { sqlite, secrets, blobs, recording } = runtime;
	function open(
		choice:
			| { library: 'local' }
			| { library: 'personal' | 'shared'; account: Account },
	): App<TDefinition> {
		return openApp(definition, {
			appId,
			choice,
			sqlite,
			secrets,
			blobs,
			recording,
			ai,
		});
	}
	return Object.freeze({
		appId,
		openLocal: () => open({ library: 'local' }),
		openPersonal: (account: Account) => open({ library: 'personal', account }),
		openShared: (account: Account) => open({ library: 'shared', account }),
	});
}

/** Independent inference transport and connections selection. */
export type AppAiBinding = {
	runtime: AiTransport | null;
	account: ((account: Account) => AiTransport) | null;
	connections?: (appId: string) => AiConnections;
	configuredFetch?: AiTransport['fetch'];
};
