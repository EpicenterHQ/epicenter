<script lang="ts">
	import { getFolder } from './folder.js';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { sendDraft } from './drafts.js';
	let { backend, id, chatId, onAccepted }: { backend: Backend; id: string; chatId: string; onAccepted: () => void } = $props();
	const { folder, queries, refresh } = getFolder();
	// The parent keys this composer by its durable draft ID.
	// svelte-ignore state_referenced_locally
	const draftId = id;
	const query = createQuery(() => queries.file(`drafts/${draftId}.md`, {
		name: 'draft',
		async read() {
			const result = await folder.tables.drafts.get(draftId);
			if (result.error !== null) throw result.error;
			return result.data ?? null;
		},
	}));
	const fileEdit = createFileEdit(folder.tables.drafts.edit(draftId));
	let message = $state('');
	// This draft's own input, so another file's failure is never shown as this one's.
	const buffer = $derived(fileEdit.buffer);
	const unsaved = $derived(buffer.status === 'ready' ? buffer.unsaved : undefined);
	const failed = $derived(unsaved?.status === 'failed' || unsaved?.status === 'conflict');
	const send = createMutation(() => ({
		mutationFn: async () => {
			const result = await sendDraft(folder, draftId, chatId, backend);
			await refresh([`drafts/${draftId}.md`]);
			if (result.error !== null) { message = result.error.message; return; }
			message = backend.mode === 'demo' ? 'Demo message sent.' : 'Accepted by Beeper. Delivery status appears in the conversation.';
			onAccepted();
		},
		onError: () => { message = 'The send outcome is unknown. Check Beeper before sending again.'; },
	}));
	function recover(clear: boolean) {
		fileEdit.change({ fields: { state: 'draft', pendingId: '' }, ...(clear ? { body: '' } : {}) });
		message = '';
	}
</script>

<div class="space-y-2 border-t p-4">
	{#if query.isPending}
		<p class="text-sm text-muted-foreground">Opening draft…</p>
	{:else if query.error || !fileEdit.markdown || fileEdit.markdown.issues !== null}
		<p role="alert" class="text-sm text-destructive">Could not open this draft. Its file has been kept. Reopen the conversation to try again.</p>
	{:else}
		{#if fileEdit.markdown.fields.state === 'sending'}
			<p role="alert" class="text-sm">This send has no saved confirmation. Check the conversation in Beeper before continuing.</p>
			<p class="whitespace-pre-wrap break-words text-sm">{fileEdit.markdown.body}</p>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" disabled={send.isPending || fileEdit.locked} onclick={() => recover(false)}>I checked: keep as draft</Button>
				<Button variant="outline" size="sm" disabled={send.isPending || fileEdit.locked} onclick={() => recover(true)}>Already sent: clear draft</Button>
			</div>
		{:else}
			<label for="reply" class="sr-only">Message</label>
			<Textarea id="reply" placeholder={backend.mode === 'demo' ? 'Write a demo reply…' : 'Write a reply…'} rows={3} maxlength={20000} disabled={send.isPending || fileEdit.locked} value={fileEdit.markdown.body} oninput={(event) => { fileEdit.change({ body: event.currentTarget.value, fields: { state: 'draft', pendingId: '' } }); message = ''; }} />
			<div class="flex items-center justify-between gap-3">
				<span class="text-xs text-muted-foreground">{failed ? 'Draft could not be saved' : unsaved !== undefined ? 'Saving draft…' : 'Draft saved on this device'}</span>
				<Button disabled={send.isPending || fileEdit.locked || !fileEdit.markdown.body.trim()} onclick={() => send.mutate()}>{send.isPending ? 'Sending…' : backend.mode === 'demo' ? 'Send demo reply' : 'Send reply'}</Button>
			</div>
		{/if}
	{/if}
	{#if buffer.error}
		<p role="alert" class="text-sm text-destructive">{buffer.error.message}</p>
	{/if}
	{#if message}<p role="status" class="text-sm">{message}</p>{/if}
	{#if failed}
		<p role="alert" class="text-sm text-destructive">Your draft has not saved. Keep this window open.</p>
		<Button variant="outline" size="sm" onclick={() => void fileEdit.save()}>Save draft again</Button>
	{/if}
</div>
