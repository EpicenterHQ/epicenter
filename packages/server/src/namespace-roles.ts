/**
 * What each namespace role may do (ADR-0547). Access is membership, one rule
 * for personal namespaces and groups alike; a role added later is one row.
 *
 * | Role     | read | push | manage |
 * | -------- | ---- | ---- | ------ |
 * | `owner`  | yes  | yes  | yes    |
 * | `member` | yes  | yes  | no     |
 *
 * `read` is fetch and LFS download; `push` is push and LFS upload; `manage`
 * deletes, renames, or moves a repository and changes members.
 */
export const NAMESPACE_ROLES = {
	owner: ['read', 'push', 'manage'],
	member: ['read', 'push'],
} as const satisfies Record<string, readonly NamespaceOperation[]>;

export type NamespaceOperation = 'read' | 'push' | 'manage';
export type NamespaceRole = keyof typeof NAMESPACE_ROLES;

export function roleAllows(
	role: NamespaceRole,
	operation: NamespaceOperation,
): boolean {
	return (NAMESPACE_ROLES[role] as readonly NamespaceOperation[]).includes(
		operation,
	);
}
