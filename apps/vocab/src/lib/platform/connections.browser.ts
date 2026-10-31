/**
 * This browser's connected endpoints (`#platform/connections`'s web leaf),
 * kept in its storage for this site, keys included.
 */
import { openLocalConnectionCatalog } from '@epicenter/ai/connections';
import type { OpenConnections } from './types.js';

export const openConnections: OpenConnections = openLocalConnectionCatalog;
