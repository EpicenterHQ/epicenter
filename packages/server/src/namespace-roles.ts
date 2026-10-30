/**
 * What each role may do to a repository (ADR-0547). A role comes from
 * membership in the repository's namespace, one rule for personal namespaces
 * and groups alike, or, for a person outside it, from a grant on that one
 * repository (`repository_grant`). A role added later is one row.
 *
 * | Role     | from             | read | push | rewrite | manage |
 * | -------- | ---------------- | ---- | ---- | ------- | ------ |
 * | `owner`  | membership       | yes  | yes  | yes     | yes    |
 * | `member` | membership       | yes  | yes  | no      | no     |
 * | `writer` | a `write` grant  | yes  | yes  | no      | no     |
 * | `reader` | a `read` grant   | yes  | no   | no      | no     |
 *
 * `read` is fetch, LFS download, and reading files; `push` is a push that
 * moves `main` forward, LFS upload, and web writes; `rewrite` is a push that
 * replaces `main` (decision 33: only the owner; the receiver keeps the old
 * one under `refs/epicenter/replaced/<time>`); `manage` deletes, renames, or
 * moves a repository, changes members, and grants, lists, and revokes
 * access to it.
 */
const ROLES = {
	owner: ['read', 'push', 'rewrite', 'manage'],
	member: ['read', 'push'],
	writer: ['read', 'push'],
	reader: ['read'],
} as const satisfies Record<string, readonly RepositoryOperation[]>;

export type RepositoryOperation = 'read' | 'push' | 'rewrite' | 'manage';
/** A role on one repository, from membership or a grant. */
export type RepositoryRole = keyof typeof ROLES;
/** A role from membership in a namespace. */
export type NamespaceRole = Extract<RepositoryRole, 'owner' | 'member'>;

export function roleAllows(
	role: RepositoryRole,
	operation: RepositoryOperation,
): boolean {
	return (ROLES[role] as readonly RepositoryOperation[]).includes(operation);
}
