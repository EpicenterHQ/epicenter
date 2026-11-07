/**
 * The wire between a page and the program on this computer that serves it
 * and owns its directory (ADR-0784): the store's four verbs, each a `POST`
 * of JSON to `<base>/<verb>`, answered by `serveDirectory` (`handler.ts`)
 * and spoken by `servedStore` (`store.ts`).
 *
 * | Request | Answer |
 * | --- | --- |
 * | `list` `{ under }` | `{ files: Listed[] }` |
 * | `read` `{ paths }` | `{ files: ({ path, bytes, version } \| { path, gone: true })[] }` |
 * | `put` `{ path, bytes \| null, expect: version \| null }` | `{ landed: version \| null }`, or `{ moved: version \| null }` |
 * | `watch` `{}` | a stream of JSON lines: `{ listening: true }` once the directory is watched, then `{ changed: paths \| 'all' }`; an empty line keeps it open |
 *
 * Bytes travel as base64. A version is the SHA-256 of the bytes (ADR-0824), the
 * directory store's own, passed through unread. A store that
 * cannot be reached answers `503` with `{ unavailable }`, the reason; a
 * request the program cannot read answers `400`. A directory has no
 * commits, so a watch carries hints only while it is connected: the page's
 * store hears a dropped watch as `'all'`, and again once it is back.
 */

/** The verbs, each the last segment of its URL. */
export const VERBS = ['list', 'read', 'put', 'watch'] as const;
export type Verb = (typeof VERBS)[number];

/** How often an idle watch sends an empty line, so no idle timeout closes it. */
export const KEEP_ALIVE_MS = 5000;

/** The bytes as base64, which JSON can carry. */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

/** The bytes `text` (base64) names; throws when it is not base64. */
export function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');
