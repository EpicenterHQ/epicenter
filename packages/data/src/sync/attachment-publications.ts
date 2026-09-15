import type { AttachmentContent } from '@epicenter/blobs';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

type Publication = SqliteRow & {
	id: string;
	sha256: string;
	size: number;
	content_type: string;
};

/** Private publication index sharing the current authority's transaction owner. */
export function openAttachmentPublications({
	sqlite,
	current,
}: {
	sqlite: SqliteDatabase;
	current(): number | undefined;
}) {
	sqlite.run(`CREATE TABLE IF NOT EXISTS _attachment_publications (
		id TEXT PRIMARY KEY,
		sha256 TEXT NOT NULL,
		size INTEGER NOT NULL,
		content_type TEXT NOT NULL
	)`);
	function row(id: string) {
		return sqlite.all<Publication>(
			'SELECT * FROM _attachment_publications WHERE id = ?',
			[id],
		)[0];
	}
	function matches(found: Publication, content: AttachmentContent) {
		return (
			found.sha256 === content.sha256 &&
			found.size === content.size &&
			found.content_type === content.contentType
		);
	}
	return {
		/** The transport calls this only after verifying the immutable object's bytes. */
		publish(generation: number, id: string, verified: AttachmentContent) {
			return sqlite.transaction(() => {
				if (current() !== generation) return 'retired' as const;
				const found = row(id);
				if (found)
					return matches(found, verified)
						? ('accepted' as const)
						: ('conflict' as const);
				sqlite.run('INSERT INTO _attachment_publications VALUES (?, ?, ?, ?)', [
					id,
					verified.sha256,
					verified.size,
					verified.contentType,
				]);
				return 'accepted' as const;
			});
		},
		read(generation: number, id: string) {
			return sqlite.transaction(() => {
				if (current() !== generation) return { status: 'retired' } as const;
				const found = row(id);
				if (!found) return { status: 'missing' } as const;
				return {
					status: 'published',
					content: {
						sha256: found.sha256,
						size: found.size,
						contentType: found.content_type,
					},
				} as const;
			});
		},
	};
}
