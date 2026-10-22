<script lang="ts">
	import { getFolder } from './folder.js';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { type CheckedAttempt, changeDraft, recoverDraft, sendDraft } from './drafts.js';
	let { backend, id, chatId, onAccepted }: { backend: Backend; id: string; chatId: string; onAccepted: () => void } = $props();
	const { folder, refresh } = getFolder();
	// The parent keys this composer by its durable draft ID.
	// svelte-ignore state_referenced_locally
	const draftId = id;
	const fileEdit = createFileEdit(folder.tables.drafts.edit(draftId));
	const attemptEdit = createFileEdit(folder.tables.attempts.edit(draftId));
	const ready = $derived(fileEdit.content !== undefined || fileEdit.loadError?.name === 'Missing');
	const invalid = $derived(fileEdit.content !== undefined && fileEdit.content.issues !== null);
	const attempted = $derived(attemptEdit.loadError?.name !== 'Missing' && attemptEdit.content?.issues === null ? attemptEdit.content : undefined);
	const legacy = $derived(attemptEdit.loadError?.name === 'Missing' && fileEdit.content?.issues === null && fileEdit.content.fields.state === 'sending' ? fileEdit.content : undefined);
	const lastAttempt = $derived(attempted ? { content: attempted, checked: { attemptId: attempted.fields.attemptId } } : legacy ? { content: legacy, checked: { legacyText: legacy.text } } : undefined);
	const pending = $derived(attempted?.fields.state === 'sending' || legacy !== undefined);
	let message = $state('');
	const send = createMutation(() => ({
		mutationFn: async () => {
			const result = await sendDraft(folder, draftId, chatId, backend);
			await refresh([`drafts/${draftId}.md`, `attempts/${draftId}.md`]);
			if (result.error !== null) { message = result.error.message; return; }
			message = backend.mode === 'demo' ? 'Demo message sent.' : 'Accepted by Beeper. Delivery status appears in the conversation.';
			onAccepted();
		},
		onError: () => { message = 'The send outcome is unknown. Check Beeper before sending again.'; },
	}));
	const recover = createMutation(() => ({
		mutationFn: async ({ checked, keep }: { checked: CheckedAttempt; keep: boolean }) => {
			const result = await recoverDraft(folder, draftId, chatId, backend, checked, keep);
			await refresh([`drafts/${draftId}.md`, `attempts/${draftId}.md`]);
			message = result.error?.message ?? '';
		},
		onError: () => { message = 'The checked outcome could not be saved. Check Beeper before sending again.'; },
	}));
</script>

<div class="space-y-2 border-t p-4">
	{#if lastAttempt}
		{@const shown = lastAttempt}
		{@const attempt = shown.content}
		{#if pending}
			<p role="alert" class="text-sm">This send has no saved confirmation. Check the conversation in Beeper before continuing.</p>
			<p class="whitespace-pre-wrap break-words text-sm">{attempt.body}</p>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" disabled={send.isPending || recover.isPending} onclick={() => recover.mutate({ checked: shown.checked, keep: true })}>I checked: keep as draft</Button>
				<Button variant="outline" size="sm" disabled={send.isPending || recover.isPending} onclick={() => recover.mutate({ checked: shown.checked, keep: false })}>Already sent: clear draft</Button>
			</div>
		{:else}
			<details class="text-xs text-muted-foreground"><summary>Last send attempt</summary><pre class="whitespace-pre-wrap break-words">{attempt.body}</pre><CopyButton text={attempt.body} size="sm" variant="ghost">Copy</CopyButton></details>
		{/if}
	{/if}
	{#if !ready}
		{#if fileEdit.loadError}<p role="alert" class="text-sm text-destructive">Could not open this draft: {fileEdit.loadError.message}</p><Button variant="outline" size="sm" onclick={() => void fileEdit.refresh()}>Read again</Button>
		{:else}<p class="text-sm text-muted-foreground">Opening draft…</p>{/if}
	{:else if invalid}
		<p role="alert" class="text-sm text-destructive">This draft needs Markdown repair before composing.</p>
	{:else if legacy}
		<p class="text-sm">Check this existing send before composing another reply.</p>
	{:else}
		<label for="reply" class="sr-only">Message</label>
		<Textarea id="reply" placeholder={backend.mode === 'demo' ? 'Write a demo reply…' : 'Write a reply…'} rows={3} maxlength={20000}
			bind:value={() => fileEdit.content?.body ?? '', body => { message = changeDraft(folder, draftId, chatId, backend, body).error?.message ?? ''; }} />
		<div class="flex items-center justify-between gap-3">
			<span class="text-xs text-muted-foreground">{fileEdit.saveError ? 'Draft could not be saved' : fileEdit.isDirty || fileEdit.isSaving ? 'Saving draft…' : 'Draft saved on this device'}</span>
			<Button disabled={send.isPending || recover.isPending || pending || !fileEdit.content?.body?.trim()} onclick={() => send.mutate()}>{send.isPending ? 'Sending…' : backend.mode === 'demo' ? 'Send demo reply' : 'Send reply'}</Button>
		</div>
	{/if}
	{#if fileEdit.loadError && fileEdit.content}<p role="alert" class="text-sm text-destructive">{fileEdit.loadError.message}</p>{/if}
	{#if attemptEdit.loadError && attemptEdit.loadError.name !== 'Missing'}<p role="alert" class="text-sm text-destructive">Could not check the latest send: {attemptEdit.loadError.message}</p><Button variant="outline" size="sm" onclick={() => void attemptEdit.refresh()}>Check again</Button>{/if}
	{#if message}<p role="status" class="text-sm">{message}</p>{/if}
	{#if fileEdit.saveError}
		<p role="alert" class="text-sm text-destructive">Your draft has not saved. Keep this window open.</p>
		<Button variant="outline" size="sm" onclick={() => void fileEdit.save()}>Save draft again</Button>
	{/if}
</div>
