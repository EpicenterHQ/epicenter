/**
 * CORS middleware.
 *
 * Skips WebSocket upgrades because the 101 response headers are
 * immutable. Trusted origins are the deployment-supplied `c.var.trustedOrigins`
 * (set in `createServerApp`), shared with Better Auth and the cookie-CSRF guard
 * so all three agree on one allow-list.
 *
 * The document plane needs an explicit header allow-list and expose-list: a
 * browser replica is cross-origin with its authority, and every document
 * request and response carries its addressing in non-safelisted headers.
 */

import {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
} from '@epicenter/data/document-v1';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import type { Env } from '../types.js';

export const corsMiddleware = createMiddleware<Env>(async (c, next) => {
	if (isWebSocketUpgrade(c)) return next();
	const { trustedOrigins } = c.var;
	return cors({
		origin: (origin) =>
			origin && trustedOrigins.includes(origin) ? origin : undefined,
		credentials: true,
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'Upgrade',
			// The document plane addresses one publication or pull entirely in
			// headers, and a conditional pull validates with `If-None-Match`. None
			// of these are CORS-safelisted, so a browser replica on its own origin
			// cannot reach the authority without them.
			DOCUMENT_LIFETIME_HEADER,
			DOCUMENT_PROTOCOL_HEADER,
			DOCUMENT_DIGEST_HEADER,
			'If-None-Match',
		],
		// `ETag` is not a safelisted response header either, so without this a
		// cross-origin pull reads `null` for the version it must send back and
		// for the lifetime it must fence installation against.
		exposeHeaders: ['ETag', DOCUMENT_LIFETIME_HEADER],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
});
