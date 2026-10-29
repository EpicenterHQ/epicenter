/**
 * A blob's bytes for display: `attachment(repo, () => path)` opens the file
 * at the path (from this device, or fetched and verified first) and, while
 * its bytes are here, holds one object URL for it. The page owns display
 * URLs: each `attachment` makes its own and revokes it when the path or the
 * bytes at it change, and when the component that made it is destroyed.
 * Call it during a component's initialization, as `$effect` requires.
 *
 *     const audio = attachment(repo, () => note.fields.audio);
 *     {#if audio.current.status === 'here'}<audio src={audio.current.url} controls></audio>{/if}
 *
 * `unavailable` (offline, the server failing, the repository not open) is
 * tried again by `retry()` and whenever the repository's status changes;
 * `missing` is no blob at the path, or no such bytes on the server.
 */
import type { Files, RepositoryChange } from '@epicenter/repository';

export type AttachmentState =
	| { status: 'here'; url: string; file: File }
	| { status: 'fetching' }
	| { status: 'unavailable'; reason: string; retry(): void }
	| { status: 'missing' };

/** What `attachment` reads of a repository: its file API and its changes. */
export type AttachmentSource = {
	files: Pick<Files, 'open' | 'read'>;
	subscribe(listener: (change: RepositoryChange) => void): () => void;
};

export function attachment(repo: AttachmentSource, getPath: () => string | null | undefined) {
	let state = $state<AttachmentState>({ status: 'fetching' });
	/** Bumped to open the path again: a retry, a status change, other bytes at the path. */
	let attempt = $state(0);

	$effect(() => {
		const path = getPath();
		void attempt;
		if (path === null || path === undefined || path === '') {
			state = { status: 'missing' };
			return;
		}
		let gone = false;
		let url: string | null = null;
		/** The pointer this open read, so a change to the file at the path opens it again. */
		let opened: string | null = null;
		state = { status: 'fetching' };
		void (async () => {
			const read = await repo.files.read(path);
			opened = read.data?.text ?? null;
			const { data: file, error } = await repo.files.open(path);
			if (gone) return;
			if (error === null) {
				url = URL.createObjectURL(file);
				state = { status: 'here', url, file };
			} else if (error.name === 'NotFound') state = { status: 'missing' };
			else state = { status: 'unavailable', reason: error.message, retry: () => void attempt++ };
		})();
		const stop = repo.subscribe((change) => {
			if (change.status && state.status === 'unavailable') return void attempt++;
			if (!change.files) return;
			void repo.files.read(path).then(({ data }) => {
				if (!gone && (data?.text ?? null) !== opened) attempt++;
			});
		});
		return () => {
			gone = true;
			stop();
			if (url !== null) URL.revokeObjectURL(url);
		};
	});

	return {
		get current() {
			return state;
		},
	};
}
