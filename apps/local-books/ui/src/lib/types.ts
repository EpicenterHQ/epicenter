// The `/api` wire shapes, derived from the typed `hc` client (which infers them
// from the Hono routes in `apps/local-books/src/http/api.ts`). Deriving them means
// a server response-shape change surfaces here, and then in the components, as a
// type error rather than a silent drift.

import type { api } from './api';

export type BooksStatus = Awaited<ReturnType<typeof api.status>>;

export type TableList = Awaited<ReturnType<typeof api.tables>>;

export type TableSummary = TableList['tables'][number];

export type TableColumn = TableSummary['columns'][number];

export type TableRowsPage = Awaited<ReturnType<typeof api.rows>>;

export type TableRowDetail = Awaited<ReturnType<typeof api.row>>;

export type QueryResult = Awaited<ReturnType<typeof api.query>>;

export type SyncOutcome = Awaited<ReturnType<typeof api.sync>>;

export type EntitySyncResult = SyncOutcome['entities'][number];
