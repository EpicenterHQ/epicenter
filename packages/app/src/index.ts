import type { Account } from '@epicenter/auth';
import type { BlobSources, BlobStore, RemoteBlobs } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import type { DataDefinition } from '@epicenter/data/definition';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { AccountIdentity } from '@epicenter/principal';
import { createDefaultAppAi } from '#platform/ai';
import { resources } from '#platform/resources';
import type { AiTransport } from './ai.js';
import type { AiConnections } from './ai-connections.js';
import { type App, type AppStore, openApp } from './open.js';
import type { RecordingFactory } from './recorder.js';

export type { App, AppStore };
export type AppSqlite = App<DataDefinition>['device']['sqlite'];
export type AppBlobs = App<DataDefinition>['blobs'];

export type AppBlobComposition = {
	local: BlobStore;
	sources: BlobSources;
	remote: RemoteBlobs | null;
};

export type AppBlobFactory = (input: {
	appId: string;
	account?: Account;
}) => AppBlobComposition;

/** Declare once; each open owns one auth generation and its device and account stores. */
export type Application<TDefinition extends DataDefinition> = {
	readonly appId: string;
	/** Open device storage, plus account stores when an Account is supplied. */
	open(): App<TDefinition, undefined>;
	open<TAccount extends Account | undefined>(
		account: TAccount,
	): App<TDefinition, TAccount>;
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
	runtime = resources,
	ai = createDefaultAppAi(),
}: {
	appId: string;
	definition: TDefinition;
	runtime?: ApplicationRuntime;
	ai?: AppAiBinding;
}): Application<TDefinition> {
	if (!isAppId(appId))
		throw new Error(`The application id '${appId}' is not valid.`);
	const { sqlite, secrets, blobs, recording } = runtime;
	const options = { appId, sqlite, secrets, blobs, recording, ai };
	function open(): App<TDefinition, undefined>;
	function open<TAccount extends Account | undefined>(
		account: TAccount,
	): App<TDefinition, TAccount>;
	function open(account?: Account) {
		return openApp(definition, { ...options, account });
	}
	return Object.freeze({
		appId,
		open,
	});
}

/** Independent inference transport and connections selection. */
export type AppAiBinding = {
	runtime: AiTransport | null;
	account: ((account: Account) => AiTransport) | null;
	connections?: (appId: string, account?: AccountIdentity) => AiConnections;
	configuredFetch?: AiTransport['fetch'];
};
