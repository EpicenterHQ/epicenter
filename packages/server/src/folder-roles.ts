/**
 * What each role may do to a folder (ADR-0820). Members are equal: no member
 * owns a folder. A role is one row of `folder_member`, given when the folder
 * is shared and changed by any member.
 *
 * | Role     | read | push | manage |
 * | -------- | ---- | ---- | ------ |
 * | `member` | yes  | yes  | yes    |
 * | `reader` | yes  | no   | no     |
 *
 * `read` is reading the folder's log, files, and bytes, and listing it;
 * `push` is a change, an upload, a mark, an import, and attaching the
 * folder to an app; `manage` shares and unshares the folder and changes
 * its members' roles. Every member may leave.
 */
import type { FolderRole } from '@epicenter/definition/site';

const ROLES = {
	member: ['read', 'push', 'manage'],
	reader: ['read'],
} as const satisfies Record<FolderRole, readonly FolderOperation[]>;

export type FolderOperation = 'read' | 'push' | 'manage';

export function roleAllows(
	role: FolderRole,
	operation: FolderOperation,
): boolean {
	return (ROLES[role] as readonly FolderOperation[]).includes(operation);
}
