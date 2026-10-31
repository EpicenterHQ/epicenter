<!--
	The reply to one conversation: its draft note's body as an immediate
	editor, created by the first keystroke (selecting a conversation makes no
	file), and the latest send attempt with its recovery. A draft or attempt
	that does not read is shown as text to repair.
-->
<script lang="ts">
	import { fieldEdit } from '@epicenter/svelte/client';
	import NoteRepair from '@epicenter/svelte/note-repair';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { getDevice } from './context.js';
	import { messages as contract } from './contract.js';
	import { recoverDraft, sendDraft } from './drafts.js';

	let { backend, id, chatId, onAccepted }: { backend: Backend; id: string; chatId: string; onAccepted: () => void } = $props();
	const device = getDevice();
	const { drafts, attempts } = device.files;
	// The parent keys this composer by its durable draft ID.
	// svelte-ignore state_referenced_locally
	const draftId = id;
	const named = (note: { id: string }) => note.id === draftId;
	const brokenDraft = $derived(drafts.invalid.find(named));
	const attempt = $derived(attempts.get({ id: draftId }));
	const brokenAttempt = $derived(attempts.invalid.find(named));
	// svelte-ignore state_referenced_locally
	const reply = fieldEdit(drafts, { id: draftId }, 'body', {
		create: () => ({ chatId, profile: backend.profile, mode: backend.mode }),
	});
	const typed = () => reply.value ?? '';
	const pending = $derived(attempt?.state === 'sending');
	let message = $state('');
	const send = createMutation(() => ({
		mutationFn: async ({ text, previousAttemptId }: { text: string; previousAttemptId: string | undefined }) => {
			const landed = await reply.landed();
			if (landed.error !== null) { message = 'Nothing was sent: the draft could not be saved.'; return; }
			const result = await sendDraft(device, {
				id: draftId, chatId, backend, text, previousAttemptId,
				unchanged: () => typed() === text,
			});
			if (result.error !== null) { message = result.error.message; return; }
			message = backend.mode === 'demo' ? 'Demo message sent.' : 'Accepted by Beeper. Delivery status appears in the conversation.';
			onAccepted();
		},
		onError: () => { message = 'The send outcome is unknown. Check Beeper before sending again.'; },
	}));
	const recover = createMutation(() => ({
		mutationFn: async ({ checkedAttemptId, keep }: { checkedAttemptId: string; keep: boolean }) => {
			const result = await recoverDraft(device, {
				id: draftId, chatId, backend, checkedAttemptId, keep,
				composerEmpty: () => typed() === '',
			});
			message = result.error?.message ?? '';
		},
		onError: () => { message = 'The checked outcome could not be saved. Check Beeper before sending again.'; },
	}));
</script>

<div class="space-y-2 border-t p-4">
	{#if attempt}
		{#if pending}
			<p role="alert" class="text-sm">This send has no saved confirmation. Check the conversation in Beeper before continuing.</p>
			<p class="whitespace-pre-wrap break-words text-sm">{attempt.body}</p>
			<div class="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" disabled={send.isPending || recover.isPending} onclick={() => recover.mutate({ checkedAttemptId: attempt.attemptId, keep: true })}>I checked: keep as draft</Button>
				<Button variant="outline" size="sm" disabled={send.isPending || recover.isPending} onclick={() => recover.mutate({ checkedAttemptId: attempt.attemptId, keep: false })}>Already sent: clear draft</Button>
			</div>
		{:else}
			<details class="text-xs text-muted-foreground"><summary>Last send attempt</summary><pre class="whitespace-pre-wrap break-words">{attempt.body}</pre><CopyButton text={attempt.body} size="sm" variant="ghost">Copy</CopyButton></details>
		{/if}
	{:else if brokenAttempt}
		<section class="space-y-2" aria-label="Send attempt to repair">
			<p role="alert" class="text-sm text-destructive">The latest send attempt needs Markdown repair before sending again.</p>
			<NoteRepair {contract} note={brokenAttempt} replace={(text) => attempts.replace({ id: draftId }, text)} />
		</section>
	{/if}
	{#if brokenDraft}
		<section class="space-y-2" aria-label="Draft to repair">
			<p role="alert" class="text-sm text-destructive">This draft needs Markdown repair before composing.</p>
			<NoteRepair {contract} note={brokenDraft} replace={(text) => drafts.replace({ id: draftId }, text)} />
		</section>
	{:else}
		<label for="reply" class="sr-only">Message</label>
		<Textarea id="reply" placeholder={backend.mode === 'demo' ? 'Write a demo reply…' : 'Write a reply…'} rows={3} maxlength={20000} bind:value={typed, (value) => (reply.value = value)} />
		<div class="flex items-center justify-end gap-3">
			<Button disabled={send.isPending || recover.isPending || pending || !!brokenAttempt || !typed().trim()} onclick={() => send.mutate({ text: typed(), previousAttemptId: attempt?.attemptId })}>{send.isPending ? 'Sending…' : backend.mode === 'demo' ? 'Send demo reply' : 'Send reply'}</Button>
		</div>
	{/if}
	<UnsavedEdit edit={reply} />
	{#if message}<p role="status" class="text-sm">{message}</p>{/if}
</div>
