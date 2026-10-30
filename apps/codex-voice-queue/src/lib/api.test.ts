/** API errors distinguish gateway-coded rejection from uncertain transport responses. */
import { expect, spyOn, test } from 'bun:test';
import { ApiError, createApi } from './api.js';

test('only JSON gateway errors with codes are definite', async () => {
	const fetchMock = spyOn(globalThis, 'fetch');
	const api = createApi({ baseUrl: '', token: 'secret', onUnauthorized() {} });
	try {
		for (const [response, code] of [
			[Response.json({ error: 'Busy', code: 'busy' }, { status: 409 }), 'busy'],
			[Response.json({ error: 'Tunnel failed' }, { status: 502 }), null],
			[new Response('<html>Timeout</html>', { status: 504 }), null],
		] as const) {
			fetchMock.mockResolvedValueOnce(response);
			try {
				await api.request('/api/state');
				throw new Error('Expected rejection');
			} catch (error) {
				expect(error).toBeInstanceOf(ApiError);
				if (!(error instanceof ApiError)) throw error;
				expect(error.code).toBe(code);
				expect(error.definite).toBe(code !== null);
			}
		}
		fetchMock.mockRejectedValueOnce(new Error('offline'));
		await expect(api.request('/api/state')).rejects.toMatchObject({
			status: 0,
			code: null,
			definite: false,
		});
	} finally {
		fetchMock.mockRestore();
	}
});
