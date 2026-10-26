<script lang="ts">
	import { edit } from '@epicenter/svelte/folder';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { recoverDraft, sendDraft } from './drafts.js';
	import { getFolder } from './folder.js';

	let { backend, id, chatId, onAccepted }: { backend: Backend; id: string; chatId: string; onAccepted: () => void } = $props();
	const folder = getFolder();
	// The parent keys this composer by its durable draft ID.
	// svelte-ignore state_referenced_locally
	const draftId = id;
	const row = $derived(folder.tables.drafts.row(draftId));
	const attempt = $derived(folder.tables.attempts.row(draftId));
	async function saveReply(body: string) {
		if (!folder.tables.drafts.row(draftId)) {
			const saved = await folder.tables.drafts.create(draftId, {
				fields: { chatId, profile: backend.profile, mode: backend.mode },
				body,
			});
			if (saved.error?.name !== 'Exists') return saved;
		}
		return folder.tables.drafts.update(draftId, { body });
	}
	const reply = edit(() => row?.issues === null ? row.body : '', saveReply);
	const pending = $derived(attempt?.issues === null && attempt.fields.state === 'sending');
	let message = $state('');
	const send = createMutation(() => ({
		mutationFn: async ({ text, previousAttemptId }: { text: string; previousAttemptId: string | undefined }) => {
			const landed = await reply.landed();
			if (landed.error !== null) { message = 'Nothing was sent: the draft could not be saved.'; return; }
			const result = await sendDraft(folder, {
				id: draftId, chatId, backend, text, previousAttemptId,
				unchanged: () => reply.value === text,
			});
			if (result.error !== null) { message = result.error.message; return; }
			message = backend.mode === 'demo' ? 'Demo message sent.' : 'Accepted by Beeper. Delivery status appears in the conversation.';
			onAccepted();
		},
		onError: () => { message = 'The send outcome is unknown. Check Beeper before sending again.'; },
	}));
	const recover = createMutation(() => ({
		mutationFn: async ({ checkedAttemptId, keep }: { checkedAttemptId: string; keep: boolean }) => {
			const result = await recoverDraft(folder, {
				id: draftId, chatId, backend, checkedAttemptId, keep,
				composerEmpty: () => reply.value === '',
			});
			message = result.error?.message ?? '';
		},
		onError: () => { message = 'The checked outcome could not be saved. Check Beeper before sending again.'; },
	}));
</script>

<div class="space-y-2 border-t p-4">
	{#if attempt?.issues === null}
		{#if pending}
			<p role="alert" class="text-sm">This send has no saved confirmation. Check the conversation in Beeper before continuing.</p>
			<p class="whitespace-pre-wrap break-words text-sm">{attempt.body}</p>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" disabled={send.isPending || recover.isPending} onclick={() => recover.mutate({ checkedAttemptId: attempt.fields.attemptId, keep: true })}>I checked: keep as draft</Button>
				<Button variant="outline" size="sm" disabled={send.isPending || recover.isPending} onclick={() => recover.mutate({ checkedAttemptId: attempt.fields.attemptId, keep: false })}>Already sent: clear draft</Button>
			</div>
		{:else}
			<details class="text-xs text-muted-foreground"><summary>Last send attempt</summary><pre class="whitespace-pre-wrap break-words">{attempt.body}</pre><CopyButton text={attempt.body} size="sm" variant="ghost">Copy</CopyButton></details>
		{/if}
	{:else if attempt?.issues}
		<p role="alert" class="text-sm text-destructive">The latest send attempt needs Markdown repair.</p>
		{#if attempt.issues.some((issue) => issue.kind === 'unreadable')}<Button variant="outline" size="sm" onclick={() => void folder.refresh()}>Read again</Button>{/if}
	{/if}
	{#if row?.issues}
		<p role="alert" class="text-sm text-destructive">This draft needs Markdown repair before composing.</p>
		{#if row.issues.some((issue) => issue.kind === 'unreadable')}<Button variant="outline" size="sm" onclick={() => void folder.refresh()}>Read again</Button>{/if}
	{:else}
		<label for="reply" class="sr-only">Message</label>
		<Textarea id="reply" placeholder={backend.mode === 'demo' ? 'Write a demo reply…' : 'Write a reply…'} rows={3} maxlength={20000} bind:value={reply.value} />
		<div class="flex items-center justify-end gap-3">
			<Button disabled={send.isPending || recover.isPending || pending || !!attempt?.issues || !reply.value.trim()} onclick={() => send.mutate({ text: reply.value, previousAttemptId: attempt?.issues === null ? attempt.fields.attemptId : undefined })}>{send.isPending ? 'Sending…' : backend.mode === 'demo' ? 'Send demo reply' : 'Send reply'}</Button>
		</div>
	{/if}
	<UnsavedEdit edit={reply} />
	{#if message}<p role="status" class="text-sm">{message}</p>{/if}
</div>
