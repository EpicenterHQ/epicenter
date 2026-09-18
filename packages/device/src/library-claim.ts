/** Origin-wide exclusion for one application's account or local library. */
import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const LibraryClaimError = defineErrors({
	AlreadyOpen: ({ address }: { address: string }) => ({
		message: `Another context already has ${address} open`,
		address,
	}),
	LocksUnsupported: ({ address }: { address: string }) => ({
		message: `This runtime cannot claim ${address}: it has no Web Locks`,
		address,
	}),
	ClaimFailed: ({ address, cause }: { address: string; cause: unknown }) => ({
		message: `The claim on ${address} could not be requested`,
		address,
		cause,
	}),
});
export type LibraryClaimError = InferErrors<typeof LibraryClaimError>;

// Keep this boundary usable from both DOM and Bun typecheck programs.
type LockManager = {
	request(
		name: string,
		options: { mode: 'exclusive'; ifAvailable: true },
		callback: (lock: unknown) => Promise<void> | undefined,
	): Promise<unknown>;
};

/** One App owns every library and SQL connection in this device namespace. */
export function claimApp(appId: string, account?: AccountIdentity) {
	// Preserve the original local-library key for exclusion with older windows.
	return claim(
		`library:${JSON.stringify([appId, 'device', deviceOwnerPath(account)])}`,
	);
}

async function claim(
	address: string,
): Promise<Result<{ release(): void }, LibraryClaimError>> {
	const locks = (globalThis as { navigator?: { locks?: LockManager } })
		.navigator?.locks;
	if (!locks) return LibraryClaimError.LocksUnsupported({ address });
	return new Promise((settle) => {
		void Promise.resolve()
			.then(() =>
				locks.request(
					`epicenter.store:${address}`,
					{ mode: 'exclusive', ifAvailable: true },
					(lock) => {
						if (lock === null) {
							settle(LibraryClaimError.AlreadyOpen({ address }));
							return;
						}
						return new Promise<void>((release) => settle(Ok({ release })));
					},
				),
			)
			.catch((cause: unknown) =>
				settle(LibraryClaimError.ClaimFailed({ address, cause })),
			);
	});
}
