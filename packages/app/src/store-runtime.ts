import type { claim } from '@epicenter/device/app-claim';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { Result } from 'wellcrafted/result';
import type { acquireLocalBlobs } from './blob-owner.js';
import type { ParsedDataDefinition } from './data/definition/index.js';
import type { DatabaseAccount } from './data/store/handles.js';
import type { StoreBacking, StoreError } from './data/store/store.js';

export type StoreOwner =
	| { readonly kind: 'local' }
	| { readonly kind: 'personal'; readonly account: Readonly<DatabaseAccount> };

/** Admission and persistence for one explicit owner; no application capabilities. */
export type StoreRuntime = {
	/** Disposable runtimes reserve before the returned promise yields. */
	claim: typeof claim;
	/** Acquire the physical namespace. A rejection conservatively retains store exclusion. */
	sqlite: DeviceSqliteOwner['acquire'];
	/** Acquire ready Local bytes. Thrown acquisition failure retains exclusion. */
	localBlobs(
		id: string,
		assertUsable: () => void,
	): ReturnType<typeof acquireLocalBlobs>;
	/** Success transfers cleanup to the store. Returned errors prove rollback;
	 * thrown failures leave ownership held until context teardown. */
	data(
		definition: ParsedDataDefinition,
		owner: StoreOwner,
	): Promise<Result<StoreBacking, StoreError>>;
};
