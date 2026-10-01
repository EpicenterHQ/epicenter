/** Origin-wide exclusion for one application's account or local storage. */
import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const AppClaimError = defineErrors({
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
export type AppClaimError = InferErrors<typeof AppClaimError>;

// Keep this boundary usable from both DOM and Bun typecheck programs.
type LockManager = {
	request(
		name: string,
		options: { mode: 'exclusive'; ifAvailable: true },
		callback: (lock: unknown) => Promise<void> | undefined,
	): Promise<unknown>;
};

/** Reserve the established App namespace for callers that still own it as a unit. */
export function claimApp(appId: string, account?: AccountIdentity) {
	// Keep the established exclusion key; changing it permits overlapping owners.
	return claim(appClaimAddress(appId, account));
}

/** Established exclusion identity for local and personal store destinations. */
export function appClaimAddress(appId: string, account?: AccountIdentity) {
	return `library:${JSON.stringify([appId, 'device', deviceOwnerPath(account)])}`;
}

/** Reserve an explicit resource address without waiting or takeover. */
export async function claim(
	address: string,
): Promise<Result<{ release(): void }, AppClaimError>> {
	const locks = (globalThis as { navigator?: { locks?: LockManager } })
		.navigator?.locks;
	if (!locks) return AppClaimError.LocksUnsupported({ address });
	return new Promise((settle) => {
		void Promise.resolve()
			.then(() =>
				locks.request(
					`epicenter.store:${address}`,
					{ mode: 'exclusive', ifAvailable: true },
					(lock) => {
						if (lock === null) {
							settle(AppClaimError.AlreadyOpen({ address }));
							return;
						}
						return new Promise<void>((release) => settle(Ok({ release })));
					},
				),
			)
			.catch((cause: unknown) =>
				settle(AppClaimError.ClaimFailed({ address, cause })),
			);
	});
}
