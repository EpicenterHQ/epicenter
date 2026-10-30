/**
 * What each namespace role may do (ADR-0547). Access is membership, one rule
 * for personal namespaces and groups alike; a role added later is one row.
 *
 * | Role     | read | push | rewrite | manage |
 * | -------- | ---- | ---- | ------- | ------ |
 * | `owner`  | yes  | yes  | yes     | yes    |
 * | `member` | yes  | yes  | no      | no     |
 *
 * `read` is fetch, LFS download, and reading files; `push` is a push that
 * moves `main` forward, LFS upload, and web writes; `rewrite` is a push that
 * replaces `main` (decision 33: the receiver keeps the old one under
 * `refs/epicenter/replaced/<time>`); `manage` deletes, renames, or moves a
 * repository and changes members.
 */
const NAMESPACE_ROLES = {
	owner: ['read', 'push', 'rewrite', 'manage'],
	member: ['read', 'push'],
} as const satisfies Record<string, readonly NamespaceOperation[]>;

export type NamespaceOperation = 'read' | 'push' | 'rewrite' | 'manage';
export type NamespaceRole = keyof typeof NAMESPACE_ROLES;

export function roleAllows(
	role: NamespaceRole,
	operation: NamespaceOperation,
): boolean {
	return (NAMESPACE_ROLES[role] as readonly NamespaceOperation[]).includes(
		operation,
	);
}
