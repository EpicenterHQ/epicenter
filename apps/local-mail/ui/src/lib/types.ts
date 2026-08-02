// The `/api` wire shapes, derived from the typed `hc` client (which infers them
// from the Hono routes in `apps/local-mail/src/http/api.ts`). This used to be a
// hand-copy kept in sync by hand; deriving it means a server response-shape
// change surfaces here, and then in the components, as a type error rather than
// a silent drift.

import type { api } from './api';

export type MailboxStatus = Awaited<ReturnType<typeof api.status>>;

export type MailLabel = Awaited<
	ReturnType<typeof api.labels>
>['labels'][number];

export type MessageSummary = Awaited<
	ReturnType<typeof api.messages>
>['messages'][number];

export type MessageDetail = Awaited<ReturnType<typeof api.message>>;
