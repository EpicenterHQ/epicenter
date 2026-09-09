/** The host (with port) of a base URL, or an unavailable label for invalid addresses. */
export function hostFromBaseUrl(baseUrl: string): string {
	try {
		return new URL(baseUrl).host || 'an invalid server address';
	} catch {
		return 'an invalid server address';
	}
}
