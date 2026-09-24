import { CONNECTION_PRESETS } from '@epicenter/client';

/** Identify the endpoint without displaying URL credentials or query secrets. */
export function connectionLabel(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, '');
	const preset = CONNECTION_PRESETS.find(
		(entry) => entry.baseUrl.replace(/\/+$/, '') === normalized,
	);
	if (preset) return preset.label;
	try {
		const url = new URL(baseUrl);
		return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
	} catch {
		return 'Invalid endpoint';
	}
}
