import type { ApiErrorCode } from './api-types.js';

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
		public code: ApiErrorCode | null = null,
	) {
		super(message);
		this.name = 'ApiError';
	}
	get definite() {
		return this.code !== null;
	}
}
export function createApi({
	baseUrl,
	token,
	onUnauthorized,
}: {
	baseUrl: string;
	token: string;
	onUnauthorized: () => void;
}) {
	return {
		async request<T>(path: string, options: RequestInit = {}): Promise<T> {
			const headers = new Headers(options.headers);
			headers.set('Authorization', `Bearer ${token}`);
			let response: Response;
			try {
				response = await fetch(`${baseUrl}${path}`, {
					...options,
					headers,
					credentials: 'omit',
					cache: 'no-store',
				});
			} catch (error) {
				throw new ApiError(
					0,
					error instanceof Error ? error.message : 'Cannot reach the gateway',
				);
			}
			if (response.status === 401) onUnauthorized();
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				const message =
					body &&
					typeof body === 'object' &&
					'error' in body &&
					typeof body.error === 'string'
						? body.error
						: `Gateway returned ${response.status}`;
				const code =
					body &&
					typeof body === 'object' &&
					'code' in body &&
					typeof body.code === 'string'
						? (body.code as ApiErrorCode)
						: null;
				throw new ApiError(response.status, message, code);
			}
			return body as T;
		},
	};
}
export type Api = ReturnType<typeof createApi>;
