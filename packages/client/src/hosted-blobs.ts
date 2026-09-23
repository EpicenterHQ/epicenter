import type { Account } from '@epicenter/auth';
import {
	MAX_HOSTED_BLOB_BYTES,
	parsePersonalBlobUrl,
	personalBlobCollectionUrl,
} from '@epicenter/blobs';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';

export const HostedBlobError = defineErrors({
	TooLarge: ({ size }: { size: number }) => ({
		message: `Blob size ${size} exceeds the ${MAX_HOSTED_BLOB_BYTES}-byte upload limit.`,
		size,
		maxBytes: MAX_HOSTED_BLOB_BYTES,
	}),
	PublicationUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: 'Hosted blob publication could not be confirmed.',
		cause,
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `Hosted blob operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/** One captured Account publishes to its Personal owner and reads known URLs. */
export function createPersonalHostedBlobs(account: Account) {
	const { baseURL, principalId, fetch: accountFetch } = account;
	async function publish(
		visibility: 'private' | 'public',
		blob: Blob,
		options?: { signal?: AbortSignal },
	) {
		if (blob.size > MAX_HOSTED_BLOB_BYTES)
			return HostedBlobError.TooLarge({ size: blob.size });
		const outcome = await tryAsync({
			try: async () => {
				const response = await accountFetch(
					personalBlobCollectionUrl(baseURL, principalId, visibility),
					{
						method: 'POST',
						headers: {
							'content-type': blob.type || 'application/octet-stream',
						},
						body: blob,
						redirect: 'error',
						signal: options?.signal,
					},
				);
				if (response.status !== 201) {
					await response.body?.cancel();
					throw new Error(`Publication returned HTTP ${response.status}`);
				}
				const body: unknown = await response.json();
				const url =
					body && typeof body === 'object' && 'url' in body
						? body.url
						: undefined;
				if (typeof url !== 'string')
					throw new Error('Publication returned no URL');
				const address = parsePersonalBlobUrl(url, baseURL);
				if (
					!address ||
					address.principalId !== principalId ||
					address.visibility !== visibility
				)
					throw new Error('Publication returned an invalid URL');
				return url;
			},
			catch: (cause) => HostedBlobError.PublicationUnconfirmed({ cause }),
		});
		return outcome;
	}

	function addressFor(url: string) {
		const address = parsePersonalBlobUrl(url, baseURL);
		if (!address) throw new TypeError('Invalid Personal blob URL');
		return address;
	}

	return Object.freeze({
		publishPrivate(blob: Blob, options?: { signal?: AbortSignal }) {
			return publish('private', blob, options);
		},
		publishPublic(blob: Blob, options?: { signal?: AbortSignal }) {
			return publish('public', blob, options);
		},
		async download(url: string, options?: { signal?: AbortSignal }) {
			addressFor(url);
			return tryAsync({
				try: async () => {
					const response = await accountFetch(url, {
						redirect: 'error',
						signal: options?.signal,
					});
					if (!response.ok) {
						await response.body?.cancel();
						throw new Error(`Download returned HTTP ${response.status}`);
					}
					return response.blob();
				},
				catch: (cause) => HostedBlobError.Failed({ cause }),
			});
		},
		async delete(url: string, options?: { signal?: AbortSignal }) {
			const address = addressFor(url);
			if (address.principalId !== principalId)
				throw new TypeError('Personal blob belongs to another principal');
			const outcome = await tryAsync({
				try: async () => {
					const response = await accountFetch(url, {
						method: 'DELETE',
						redirect: 'error',
						signal: options?.signal,
					});
					await response.body?.cancel();
					if (response.status !== 204)
						throw new Error(`Deletion returned HTTP ${response.status}`);
				},
				catch: (cause) => HostedBlobError.Failed({ cause }),
			});
			return outcome;
		},
	});
}
