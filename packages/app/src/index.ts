import type { Account } from '@epicenter/auth';
import type { BlobSources, BlobStore, RemoteBlobs } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { AccountIdentity } from '@epicenter/principal';
import { createDefaultAppAi } from '#platform/ai';
import { resources } from '#platform/resources';
import type { AiTransport } from './ai.js';
import type { AiConnections } from './ai-connections.js';
import type { DeclaredTable } from './data/definition/declaration.js';
import type { ValidateFields } from './data/definition/define.js';
import { compileData, type DataDefinition } from './data/definition/index.js';
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
export type Application<TDefinition extends DataDefinition> = TDefinition & {
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

/** Declare an inert, inspectable schema; each open owns one App lifetime. */
export function defineApp<const TDefinition extends DataDefinition>({
	runtime = resources,
	ai = createDefaultAppAi(),
	...schema
}: TDefinition & {
	kv: ValidateFields<TDefinition['kv']>;
	tables: {
		[Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends DeclaredTable
			? TDefinition['tables'][Name]
			: DeclaredTable;
	};
	runtime?: ApplicationRuntime;
	ai?: AppAiBinding;
}) {
	// Supply the optional title type without widening inferred table or KV keys.
	type Definition = Pick<
		TDefinition & Pick<DataDefinition, 'title'>,
		'id' | 'title' | 'kv' | 'tables'
	>;
	const { id, title, kv, tables } = schema;
	if (!isAppId(id)) throw new Error(`The application id '${id}' is not valid.`);
	const { sqlite, secrets, blobs, recording } = runtime;
	const options = { appId: id, sqlite, secrets, blobs, recording, ai };
	function open(): App<Definition, undefined>;
	function open<TAccount extends Account | undefined>(
		account: TAccount,
	): App<Definition, TAccount>;
	function open(account?: Account) {
		return openApp(declaration, { ...options, account });
	}
	const declaration: Application<Definition> = Object.freeze({
		id,
		...(title === undefined ? {} : { title }),
		kv,
		tables,
		open,
	});
	const compiled = compileData(declaration);
	if (compiled.error !== null)
		throw new Error(compiled.error.message, { cause: compiled.error });
	return declaration;
}

/** Independent inference transport and connections selection. */
export type AppAiBinding = {
	runtime: AiTransport | null;
	account: ((account: Account) => AiTransport) | null;
	connections?: (appId: string, account?: AccountIdentity) => AiConnections;
	configuredFetch?: AiTransport['fetch'];
};

export { plainText } from './data/definition/content.js';
export {
	type ContentCodec,
	ContentError,
	type CreateRowOf,
	type DataDefinition,
	field,
	type KvOf,
	type RowOf,
} from './data/definition/declaration.js';
export { defineTable } from './data/definition/define.js';
export type { JsonObject, JsonValue } from './data/definition/json.js';
export { jsonValue } from './data/field/index.js';
