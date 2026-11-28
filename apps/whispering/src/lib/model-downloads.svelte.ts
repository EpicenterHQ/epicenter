/**
 * The model downloads under way, by model id: how far each is, from 0 to 1.
 * It is apart from any screen so Home's first run and Settings show the
 * same download, and leaving a screen does not lose sight of it. The
 * download itself runs in Rust and carries on whatever the page does.
 */
import { SvelteMap } from 'svelte/reactivity';
import { runMutation } from 'wellcrafted/query';
import { modelsMutations, queryClient } from './queries';

const shares = new SvelteMap<string, number>();

export const modelDownloads = {
	/** How far the download of the model `id` is, or undefined when none is under way. */
	share: (id: string) => shares.get(id),

	/** Download the model `id`. Answers when its file is there, or why it is not. */
	async start(id: string) {
		shares.set(id, 0);
		const downloaded = await runMutation(
			queryClient,
			modelsMutations.download,
			{
				id,
				onProgress: (share) => shares.set(id, share),
			},
		);
		shares.delete(id);
		return downloaded;
	},
};
