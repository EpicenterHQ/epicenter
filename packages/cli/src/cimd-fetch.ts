/**
 * How `serve` fetches a connector's Client ID Metadata Document (ADR-0871).
 *
 * It keeps `@better-auth/cimd/node`'s guarantees: the name is resolved once,
 * every answer must be a public address, the connection is pinned to a checked
 * answer while the name stays the HTTP Host, the TLS server name, and the
 * certificate's identity, and a redirect is returned, never followed. It
 * differs in one way: it tries each checked address in turn, IPv4 first.
 * Bun lists IPv6 answers first, and upstream connects to the first answer
 * only, so on a network without IPv6 every fetch from a dual-stack host
 * (claude.ai) fails. This goes when upstream tries each address.
 */
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicRoutableHost } from '@better-auth/core/utils/host';

/** Statuses whose response has no body. */
const NO_BODY = new Set([204, 205, 304]);

function toHeaders(raw: Record<string, string | string[] | undefined>) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw))
		for (const item of Array.isArray(value)
			? value
			: value === undefined
				? []
				: [value])
			headers.append(name, item);
	return headers;
}

/** One HTTPS request to `url` over a connection to `address` only. */
function requestPinned(
	url: URL,
	webRequest: Request,
	address: LookupAddress,
	signal: AbortSignal | undefined,
) {
	const headers = {
		...Object.fromEntries(webRequest.headers.entries()),
		host: url.host,
	};
	return new Promise<Response>((resolve, reject) => {
		const outgoing = request(
			url,
			{
				agent: false,
				headers,
				method: webRequest.method,
				servername:
					isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0
						? url.hostname
						: undefined,
				signal,
				// Node asks for every address when it selects a family itself; either
				// way it gets only the one already checked.
				lookup: (_hostname, options, callback) => {
					const done = callback as (...args: unknown[]) => void;
					if ((options as { all?: boolean }).all) done(null, [address]);
					else done(null, address.address, address.family);
				},
			},
			(response) => {
				const status = response.statusCode ?? 500;
				const body =
					webRequest.method === 'HEAD' || NO_BODY.has(status)
						? null
						: (Readable.toWeb(response) as unknown as ReadableStream);
				try {
					resolve(
						new Response(body, {
							headers: toHeaders(response.headers),
							status,
							statusText: response.statusMessage,
						}),
					);
				} catch (error) {
					response.destroy();
					reject(error);
				}
			},
		);
		outgoing.once('error', reject);
		outgoing.end();
	});
}

/** `fetchClientMetadataResource` for `cimd()`: GET or HEAD over HTTPS to public addresses only. */
export async function fetchClientMetadataResource(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const webRequest = new Request(input, init);
	const url = new URL(webRequest.url);
	if (url.protocol !== 'https:')
		throw new TypeError('A client metadata document must be fetched over HTTPS');
	if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD')
		throw new TypeError('A client metadata document is fetched with GET or HEAD');
	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (addresses.length === 0)
		throw new TypeError('The metadata hostname has no addresses');
	for (const { address } of addresses)
		if (!isPublicRoutableHost(address))
			throw new TypeError(
				'The metadata hostname must resolve only to public addresses',
			);
	const ordered = [...addresses].sort((a, b) => a.family - b.family);
	const signal = init?.signal ?? webRequest.signal;
	let lastError: unknown;
	for (const address of ordered) {
		try {
			return await requestPinned(url, webRequest, address, signal ?? undefined);
		} catch (error) {
			// Only a failure before a response moves on to the next address.
			lastError = error;
			if (signal?.aborted) throw error;
		}
	}
	throw lastError;
}
