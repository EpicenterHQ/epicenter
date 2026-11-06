<!--
	A new reply to one conversation, saved as a note in the Messages folder
	as a draft or ready. Neither sends: a ready reply waits in Replies until
	it is selected and Send selected is pressed. The typed text stays until
	its save lands, and leaving with text unsaved asks first.
-->
<script lang="ts">
	import type { Conversation } from '@epicenter/cli/messages-protocol';
	import { timeId } from '@epicenter/definition/ids';
	import { holdLeave } from '@epicenter/svelte/leave-guard';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';

	let { backend, chat, profile, onSaved, inputId = 'reply' }: { backend: Backend; chat: Pick<Conversation, 'id' | 'title'>; profile: string; onSaved?: () => void; inputId?: string } = $props();
	const queryClient = useQueryClient();
	let text = $state('');
	let message = $state('');
	const save = createMutation(() => ({
		mutationFn: async (status: 'draft' | 'ready') => {
			const body = text;
			const answer = await holdLeave(backend.request({ action: 'save', id: timeId(), chatId: chat.id, chatTitle: chat.title, profile, status, body }));
			if (answer.kind !== 'saved') { message = answer.kind === 'error' ? answer.message : 'Not saved.'; return; }
			if (text === body) text = '';
			message = status === 'ready' ? 'Saved as ready. Send it from Replies.' : 'Saved as a draft.';
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
			onSaved?.();
		},
		onError: () => { message = 'Not saved. The text is still here.'; },
	}));
</script>

<svelte:window onbeforeunload={(event) => { if (text.trim()) event.preventDefault(); }} />

<div class="space-y-2 border-t p-4">
	<label for={inputId} class="sr-only">Message</label>
	<Textarea id={inputId} placeholder={backend.kind === 'demo' ? 'Write a demo reply…' : 'Write a reply…'} rows={3} maxlength={20000} bind:value={text} />
	<div class="flex flex-wrap items-center justify-end gap-2">
		<Button variant="outline" disabled={save.isPending || !text.trim()} onclick={() => save.mutate('draft')}>Save draft</Button>
		<Button disabled={save.isPending || !text.trim()} onclick={() => save.mutate('ready')}>Save as ready</Button>
	</div>
	{#if message}<p role="status" class="text-sm">{message}</p>{/if}
</div>
