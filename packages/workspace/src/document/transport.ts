import { ROOM_ROUTE } from '@epicenter/sync';

/**
 * Options for {@link roomWsUrl}: the API origin and document guid.
 */
export type RoomWsUrlOptions = {
	baseURL: string;
	guid: string;
};

/**
 * Build the WebSocket URL for a hosted room.
 *
 * Single URL form: `wss://<baseURL>/api/rooms/<guid>`.
 *
 * The path itself comes from `ROOM_ROUTE.url(...)` so server route
 * declarations and client URL construction can never drift. This wrapper
 * rewrites the `http(s)` scheme to `ws(s)`.
 */
export function roomWsUrl(options: RoomWsUrlOptions): string {
	const httpUrl = ROOM_ROUTE.url(options.baseURL, options.guid);
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}
