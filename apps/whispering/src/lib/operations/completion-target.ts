import { connectionLabel } from '@epicenter/app-shell/inference-picker';
import { INFERENCE, type InferenceProviderId } from '../constants/inference';

export type CompletionTarget = {
	baseUrl: string;
	apiKey: string | undefined;
};

/** The resolved endpoint and whether its required configuration is present. */
export type CompletionState = {
	target: CompletionTarget | null;
	canRun: boolean;
};

export type InferenceConfigKey =
	| (typeof INFERENCE)[InferenceProviderId]['apiKeyConfigKey']
	| NonNullable<(typeof INFERENCE)[InferenceProviderId]['endpointConfigKey']>;

/** Name the previous provider configuration for an explicit import. */
export function resolveTextDestination(
	provider: InferenceProviderId,
	target: CompletionTarget,
): string {
	return target.baseUrl === INFERENCE[provider].defaultBaseUrl
		? INFERENCE[provider].label
		: connectionLabel(target.baseUrl);
}

type DeviceConfigReader = (key: InferenceConfigKey) => string;

export function resolveCompletionStateFromConfig({
	provider,
	getDeviceConfig,
}: {
	provider: InferenceProviderId;
	getDeviceConfig: DeviceConfigReader;
}): CompletionState {
	const { apiKeyConfigKey, endpointConfigKey, defaultBaseUrl } =
		INFERENCE[provider];
	const override = endpointConfigKey
		? getDeviceConfig(endpointConfigKey).trim()
		: '';
	const baseUrl = override || defaultBaseUrl;
	if (!baseUrl) return { target: null, canRun: false };
	const apiKey = getDeviceConfig(apiKeyConfigKey).trim() || undefined;
	return {
		target: { baseUrl, apiKey },
		canRun: apiKey !== undefined || override.length > 0,
	};
}
