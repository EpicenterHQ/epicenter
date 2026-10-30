/**
 * Where a repository stands in a page, and the one error an app meets when
 * it is not open: a write, a read, a query or an editor asked while it is
 * opening, elsewhere or closed. Both the repository and its editors use it,
 * so the name means one thing wherever it appears.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/** Where the repository stands in this page. `open`: its notes are here and it saves. */
export type RepositoryStatus =
	| { status: 'opening' }
	/** This page owns the replica, but another page's worker has not let go of it yet. */
	| { status: 'waiting'; reason: string }
	| { status: 'open' }
	/** Another tab owns the replica; `useHere` takes it. */
	| { status: 'elsewhere'; useHere(): void }
	/** Another tab took the replica from this one. */
	| { status: 'moved'; useHere(): void }
	| { status: 'unavailable'; reason: string; retry(): void }
	| { status: 'closed' };

export const RepositoryError = defineErrors({
	/** The repository is not open in this page (it is opening, elsewhere, or closed): nothing was saved, read or opened. */
	Unavailable: ({ status }: { status: RepositoryStatus['status'] }) => ({
		message: `The repository is ${status}, not open, so this cannot be done now`,
		status,
	}),
});
export type RepositoryError = InferErrors<typeof RepositoryError>;
