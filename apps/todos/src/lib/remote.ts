/**
 * The todos folder's one `GitAccess`, over this build's account. Both folder
 * leaves hand its `credentials` to the folder, and Connect asks it for
 * Epicenter's remote.
 */
import { auth } from '#platform/auth';
import { createGitAccess } from './git-access.js';

export const gitAccess = createGitAccess({ auth });
