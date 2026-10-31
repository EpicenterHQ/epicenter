/**
 * Git LFS objects in R2 for the Worker (decision 17): the bucket bound as
 * `LFS_BUCKET`, presigned with an R2 S3 key pair (`R2_ACCESS_KEY_ID`,
 * `R2_SECRET_ACCESS_KEY`) on the account `ARTIFACTS_ACCOUNT_ID` names. A
 * deployment that binds none of these has no LFS store, and the LFS routes
 * answer 503.
 */
import {
	createR2LfsStore,
	type LfsStore,
	type R2LfsBucket,
} from '@epicenter/server';

/**
 * The secrets the receiver's LFS path requires beside the bucket binding:
 * the R2 S3 key pair that presigns transfers. They are optional Worker
 * secrets (not in `wrangler.jsonc`'s `secrets.required`), so a deploy
 * without them succeeds with LFS, and so hosted Git, off.
 */
export const LFS_SECRETS = [
	'R2_ACCESS_KEY_ID',
	'R2_SECRET_ACCESS_KEY',
] as const;

/**
 * The bindings LFS reads. `wrangler.jsonc` binds `LFS_BUCKET` and sets
 * `LFS_BUCKET_NAME`; `LFS_SECRETS` arrive as secrets after deployment.
 */
export type LfsBindings = {
	LFS_BUCKET?: R2LfsBucket;
	LFS_BUCKET_NAME?: string;
	ARTIFACTS_ACCOUNT_ID?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
};

export function resolveR2Lfs(env: LfsBindings): LfsStore | null {
	const {
		LFS_BUCKET,
		LFS_BUCKET_NAME,
		ARTIFACTS_ACCOUNT_ID,
		R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY,
	} = env;
	if (
		!LFS_BUCKET ||
		!LFS_BUCKET_NAME ||
		!ARTIFACTS_ACCOUNT_ID ||
		!R2_ACCESS_KEY_ID ||
		!R2_SECRET_ACCESS_KEY
	)
		return null;
	return createR2LfsStore({
		bucket: LFS_BUCKET,
		presigner: {
			accountId: ARTIFACTS_ACCOUNT_ID,
			bucketName: LFS_BUCKET_NAME,
			accessKeyId: R2_ACCESS_KEY_ID,
			secretAccessKey: R2_SECRET_ACCESS_KEY,
		},
	});
}
