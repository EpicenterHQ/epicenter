/** What every platform's `openFolder` takes and answers. */
import type { Result } from 'wellcrafted/result';
import type { OpenFolderError } from '../errors.js';
import type { OpenError } from './errors.js';
import type { Folder, Tables } from './folder.js';

export type OpenOptions<T extends Tables> = {
	/** Each key is a top-level directory of `<id>.md` rows read through its schema. */
	readonly tables: T;
	/** The least time between two saves of one path; typing saves about this often. */
	readonly throttleMs?: number;
};

export type Opened<T extends Tables> = Promise<
	Result<Folder<T>, OpenFolderError | OpenError>
>;
