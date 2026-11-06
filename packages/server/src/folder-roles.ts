/**
 * What each member's role may do to a folder (ADR-0811). Any member may be
 * an owner; a role is one row of `folder_member`, given when the folder is
 * shared and changed by an owner.
 *
 * | Role     | read | push | rewrite | manage |
 * | -------- | ---- | ---- | ------- | ------ |
 * | `owner`  | yes  | yes  | yes     | yes    |
 * | `writer` | yes  | yes  | no      | no     |
 * | `reader` | yes  | no   | no      | no     |
 *
 * `read` is sync's reads, fetch, LFS download, and listing the folder; `push`
 * is a commit, a push that moves `main` forward, an upload, and attaching the
 * folder to an app; `rewrite` is a push that replaces `main` (the receiver
 * keeps the old one under `refs/epicenter/replaced/<time>`); `manage` shares
 * and unshares the folder and changes its members' roles. Every member may
 * leave.
 */
import type { FolderRole } from '@epicenter/definition/site';

const ROLES = {
	owner: ['read', 'push', 'rewrite', 'manage'],
	writer: ['read', 'push'],
	reader: ['read'],
} as const satisfies Record<FolderRole, readonly FolderOperation[]>;

export type FolderOperation = 'read' | 'push' | 'rewrite' | 'manage';

export function roleAllows(
	role: FolderRole,
	operation: FolderOperation,
): boolean {
	return (ROLES[role] as readonly FolderOperation[]).includes(operation);
}
