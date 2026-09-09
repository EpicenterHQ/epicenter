import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { createHttpService, type HttpFetch } from './service.js';

export type {
	ConnectionError,
	HttpService,
	ParseError,
	ResponseError,
} from './types.js';
export { HttpError } from './types.js';

/** Native HTTP preserves configured endpoints and credentials across browser CORS restrictions. */
export const customFetch: HttpFetch = tauriFetch;
export const HttpServiceLive = createHttpService(customFetch);
