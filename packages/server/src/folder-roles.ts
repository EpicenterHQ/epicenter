/**
 * What each role may do to a folder (ADR-0820). Members are equal: no member
 * owns a folder. A role is one row of `folder_member`, given when the folder
 * is shared and changed by any member.
 *
 * | Role     | read | push | rewrite | manage |
 * | -------- | ---- | ---- | ------- | ------ |
 * | `member` | yes  | yes  | yes     | yes    |
 * | `reader` | yes  | no   | no      | no     |
 *
 * `read` is sync's reads, fetch, LFS download, and listing the folder; `push`
 * is a commit, a push that moves `main` forward, an upload, and attaching the
 * folder to an app; `rewrite` is a push that replaces `main` (the receiver
 * keeps the old one under `refs/epicenter/replaced/<time>`, so a member's
 * rewrite loses nothing another member cannot restore); `manage` shares and
 * unshares the folder and changes its members' roles. Every member may
 * leave.
 */
import type { FolderRole } from '@epicenter/definition/site';

const ROLES = {
	member: ['read', 'push', 'rewrite', 'manage'],
	reader: ['read'],
} as const satisfies Record<FolderRole, readonly FolderOperation[]>;

export type FolderOperation = 'read' | 'push' | 'rewrite' | 'manage';

export function roleAllows(
	role: FolderRole,
	operation: FolderOperation,
): boolean {
	return (ROLES[role] as readonly FolderOperation[]).includes(operation);
}
