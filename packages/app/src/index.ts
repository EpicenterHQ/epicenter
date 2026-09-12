import type { Account } from '@epicenter/auth';
import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import type { DataDefinition } from '@epicenter/data/definition';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { LibraryReplicaIdentity } from '@epicenter/principal';
import { createDefaultAppAi } from '#platform/ai';
import { resources } from '#platform/resources';
import type { AiTransport } from './ai.js';
import type { AiConnections } from './ai-connections.js';
import { browser } from './browser.js';
import { type AccountApp, type App, type LocalApp, openApp } from './open.js';
import type { RecordingFactory } from './recorder.js';

export type { AccountApp, App, LocalApp };
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

/** One per app; each open owns one library and the open call decides the handle's type. */
export type Application<TDefinition extends DataDefinition> = {
	readonly appId: string;
	openLocal(): LocalApp<TDefinition>;
	openPersonal(account: Account): AccountApp<TDefinition>;
	openShared(account: Account): AccountApp<TDefinition>;
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
	const options = { appId, sqlite, secrets, blobs, recording, ai };
	return Object.freeze({
		appId,
		openLocal: () =>
			openApp(definition, { ...options, choice: { library: 'local' } }),
		openPersonal: (account: Account) =>
			openApp(definition, {
				...options,
				choice: { library: 'personal', account },
			}),
		openShared: (account: Account) =>
			openApp(definition, {
				...options,
				choice: { library: 'shared', account },
			}),
	});
}

/** Independent inference transport and connections selection. */
export type AppAiBinding = {
	runtime: AiTransport | null;
	account: ((account: Account) => AiTransport) | null;
	connections?: (appId: string) => AiConnections;
	configuredFetch?: AiTransport['fetch'];
};
