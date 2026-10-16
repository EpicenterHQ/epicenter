<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { describeError } from '$lib/entries.svelte.js';
	import { openVocabFolder } from '$lib/folder.js';
	import type { WriteFailure } from '$lib/query.js';
	import { createVocab } from '$lib/vocab.svelte.js';
	import VocabShell from './components/VocabShell.svelte';

	const queryClient = useQueryClient();

	/**
	 * A write failed; say so. An edit still on screen can be saved again; a
	 * message that is not, offers the text it held.
	 */
	function writeFailed({ path, error, lost, retry }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: describeError(error),
			action:
				retry !== undefined
					? { label: 'Save again', onClick: retry }
					: lost === ''
						? undefined
						: {
								label: 'Copy your text',
								onClick: () => void navigator.clipboard.writeText(lost).catch(() => {}),
							},
		});
	}

	// The mounted page opens the folder; importing modules opens nothing. There
	// is no sign-in on this path: words and chats are in this browser's folder
	// whether or not an account is signed in.
	const opening = openVocabFolder().then((folder) =>
		createVocab(folder, queryClient, { onWriteFailed: writeFailed }),
	);

	// Every write and action under way lands before the folder closes.
	onDestroy(() => {
		void opening.then((vocab) => vocab.close()).catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your words…" />
{:then vocab}
	<VocabShell {vocab} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Could not open Vocab's folder</Empty.Title>
			<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Header>
		<Empty.Content><Button variant="outline" size="sm" onclick={() => location.reload()}>Try again</Button></Empty.Content>
	</Empty.Root>
{/await}
