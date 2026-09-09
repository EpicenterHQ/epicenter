import type { AiConfiguration } from './ai-configuration.js';
import type { AiTransport } from './ai.js';
import { openApp } from './open.js';
import type { Account } from '@epicenter/auth';
import type { LibraryReplicaIdentity } from '@epicenter/principal';
import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import type { DataDefinition } from '@epicenter/data/definition';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { createBrowserRecording } from '@epicenter/recorder/browser';
import type { RecordingFactory } from '@epicenter/recorder/recording';
import { resources } from '#platform/resources';
import { createBrowserAppAi, createBrowserAppBlobs } from './browser.js';

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

export function createEpicenter<const TDefinition extends DataDefinition>({
	appId,
	definition,
	sqlite,
	blobs,
	recording = createBrowserRecording,
	ai,
	secrets = resources.secrets,
}: {
	appId: string;
	definition: TDefinition;
	/** Runtime owner for this app's named SQLite files. */
	sqlite: DeviceSqliteOwner;
	/** Platform-owned blob capabilities for this app's storage root. */
	blobs: AppBlobFactory;
	/** Capture binding. Constructing it acquires no microphone or model. */
	recording?: RecordingFactory;
	ai?: AppAiBinding;
	secrets?: typeof resources.secrets;
}): Application<TDefinition> {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	function open(
		choice:
			| { library: 'local' }
			| { library: 'personal' | 'shared'; account: Account },
	): App<TDefinition> {
		return openApp(definition, {
			appId,
			choice,
			sqlite,
			blobs,
			recording,
			ai,
			secrets,
		});
	}
	return Object.freeze({
		appId,
		openLocal: () => open({ library: 'local' }),
		openPersonal: (account: Account) => open({ library: 'personal', account }),
		openShared: (account: Account) => open({ library: 'shared', account }),
	});
}

/** Declare data; the build selects standard SQLite and secret resources. */
export function defineApplication<const TDefinition extends DataDefinition>({
	settingsKey,
	...options
}: {
	appId: string;
	definition: TDefinition;
	/** Existing local AI settings may have an application-specific storage key. */
	settingsKey?: string;
}): Application<TDefinition> {
	return createEpicenter({
		...options,
		...resources,
		blobs: createBrowserAppBlobs(),
		ai: createBrowserAppAi(settingsKey ?? options.appId),
	});
}

/** Bind platform resources once; application declarations contain only identity and data. */
export type AppAiBinding = {
	runtime: AiTransport | null;
	account: ((account: Account) => AiTransport) | null;
	configuration?: (appId: string) => AiConfiguration;
	configuredFetch?: AiTransport['fetch'];
};

export function bindApplication({
	sqlite,
	blobs,
	recording,
	ai,
}: {
	sqlite: DeviceSqliteOwner;
	blobs: AppBlobFactory;
	recording?: RecordingFactory;
	ai?: AppAiBinding;
}) {
	return function defineApplication<
		const TDefinition extends DataDefinition,
	>(options: {
		appId: string;
		definition: TDefinition;
	}): Application<TDefinition> {
		return createEpicenter({ sqlite, blobs, recording, ai, ...options });
	};
}
