/**
 * `#platform/connections` in the web build: this browser's connected
 * endpoints, kept in its storage for this site, keys included. The desktop
 * window's is `connections.tauri.ts`.
 */
import { openLocalConnectionCatalog } from '@epicenter/ai/connections';
import type { OpenConnections } from './platform.js';

export const openConnections: OpenConnections = openLocalConnectionCatalog;
