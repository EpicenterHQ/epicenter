<!--
	Where one send stands, and, for a send nobody can settle but a person,
	the two answers a person gives after checking Beeper. Neither answer
	sends anything: "not sent" keeps the reply (written back as a draft if
	its note is gone), and only a new Send selected asks Beeper again.
-->
<script lang="ts">
	import type { Send } from '@epicenter/cli/messages-protocol';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { needsCheck, sendBadge, sendNote, unsettled } from './replies.js';

	let { backend, send, showText = false }: { backend: Backend; send: Send; showText?: boolean } = $props();
	const queryClient = useQueryClient();
	let message = $state('');
	const badge = $derived(sendBadge(send));
	const note = $derived(sendNote(send));
	const answerable = $derived(needsCheck(send) || (send.state === 'accepted' && badge.variant === 'destructive'));
	const resolve = createMutation(() => ({
		mutationFn: async (outcome: 'sent' | 'not-sent') => {
			const answer = await backend.request({ action: 'resolve', attemptId: send.attemptId, outcome });
			message = answer.kind === 'error' ? answer.message : '';
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
		},
		onError: () => { message = 'What happened could not be recorded. Try again.'; },
	}));
</script>

<div class="space-y-1 text-sm">
	<Badge variant={badge.variant}>{backend.kind === 'demo' && badge.label === 'Sent to Beeper' ? 'Sent in the demo' : badge.label}</Badge>
	{#if note && (unsettled(send) || send.state === 'failed')}<p class="text-muted-foreground">{note}</p>{/if}
	{#if showText && send.text !== null}
		<p class="whitespace-pre-wrap break-words">{send.text}</p>
		<CopyButton text={send.text} size="sm" variant="ghost">Copy</CopyButton>
	{/if}
	{#if answerable}
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" disabled={resolve.isPending} onclick={() => resolve.mutate('sent')}>I checked Beeper: it was sent</Button>
			<Button variant="outline" size="sm" disabled={resolve.isPending} onclick={() => resolve.mutate('not-sent')}>I checked Beeper: not sent</Button>
		</div>
	{/if}
	{#if message}<p role="alert" class="text-destructive">{message}</p>{/if}
</div>
