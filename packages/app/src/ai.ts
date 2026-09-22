import type { Account } from '@epicenter/auth';
import { isTauri } from '@tauri-apps/api/core';
import {
	createInference,
	validateInferenceDestination,
	type AiTransport,
} from './inference.js';
import { createNativeInferenceTransport } from './native-ai.js';
import { endpointFetch } from './endpoint-transport.js';
export type EndpointInferenceOptions = {
	baseURL: string;
	getAuthHeaders?: (options: {
		signal: AbortSignal;
	}) => HeadersInit | Promise<HeadersInit>;
};

export async function openEndpointInference({
	baseURL,
	getAuthHeaders,
}: EndpointInferenceOptions) {
	return createInference(
		{ baseURL: validateInferenceDestination(baseURL), fetch: endpointFetch() },
		getAuthHeaders,
	);
}
export async function openEpicenterInference({
	account,
}: {
	account: Account;
}) {
	const identity = Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
	});
	const transport = accountInference(account);
	return Object.freeze({ ...createInference(transport), identity });
}
export async function openRuntimeInference() {
	return isTauri() ? createInference(createNativeInferenceTransport()) : null;
}
function accountInference(account: Account): AiTransport {
	return {
		baseURL: `${account.baseURL.replace(/\/+$/, '')}/v1`,
		fetch: account.fetch,
	};
}
