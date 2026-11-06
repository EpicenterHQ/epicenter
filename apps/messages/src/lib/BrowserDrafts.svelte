<!--
	Drafts an earlier Messages kept in this browser (`browser-drafts.ts`),
	shown as they are, each with Copy and, when its conversation is known,
	Import, which saves a copy in the Messages folder as a draft. Nothing
	here changes or deletes what the browser keeps. A send that was never
	confirmed may have reached Beeper, so it says to check first.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { type BrowserDraft, readBrowserDrafts } from './browser-drafts.js';

	let { backend, filed }: { backend: Backend; filed: ReadonlySet<string> } = $props();
	const queryClient = useQueryClient();
	const kept = createQuery(() => ({
		queryKey: ['browser-drafts'],
		queryFn: readBrowserDrafts,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	}));
	let messages = $state<Record<string, string>>({});
	const importDraft = createMutation(() => ({
		mutationFn: async (draft: BrowserDraft) => {
			if (draft.chatId === undefined || draft.profile === undefined) return;
			const answer = await backend.request({ action: 'save', id: draft.importId, chatId: draft.chatId, profile: draft.profile, status: 'draft', body: draft.text });
			messages[draft.path] = answer.kind === 'saved' ? 'Imported as a draft in Replies.' : answer.kind === 'error' ? answer.message : 'Not imported.';
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
		},
		onError: (_error, draft) => { messages[draft.path] = 'Not imported.'; },
	}));
</script>

{#if kept.data && kept.data.length > 0}
	<section class="space-y-2" aria-label="Drafts kept in this browser">
		<h3 class="text-sm font-semibold">Drafts kept in this browser</h3>
		<p class="text-xs text-muted-foreground">An earlier Messages kept these in this browser. They stay here unchanged; import one to edit and send it from your Messages folder.</p>
		{#each kept.data as draft (draft.path)}
			<article class="space-y-1 rounded-lg border p-3 text-sm" aria-label={`Browser ${draft.kind}`}>
				<p class="text-xs text-muted-foreground">{draft.kind === 'draft' ? 'Draft' : draft.kind === 'unconfirmed send' ? 'A send Beeper never confirmed: check the conversation in Beeper before sending it again' : 'Could not be read; its text as it is'}</p>
				<p class="whitespace-pre-wrap break-words">{draft.text}</p>
				<div class="flex flex-wrap gap-2">
					<CopyButton text={draft.text} size="sm" variant="ghost">Copy</CopyButton>
					{#if draft.chatId !== undefined}
						{#if filed.has(draft.importId)}<span class="text-xs text-muted-foreground">Imported</span>
						{:else}<Button variant="outline" size="sm" disabled={importDraft.isPending} onclick={() => importDraft.mutate(draft)}>Import as draft</Button>{/if}
					{/if}
				</div>
				{#if messages[draft.path]}<p role="status" class="text-xs">{messages[draft.path]}</p>{/if}
			</article>
		{/each}
	</section>
{/if}
