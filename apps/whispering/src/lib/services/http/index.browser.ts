import { createHttpService, type HttpFetch } from './service.js';

export type {
	ConnectionError,
	HttpService,
	ParseError,
	ResponseError,
} from './types.js';
export { HttpError } from './types.js';

export const customFetch: HttpFetch = globalThis.fetch.bind(globalThis);
export const HttpServiceLive = createHttpService(customFetch);
