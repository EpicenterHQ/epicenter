<script lang="ts">
	import LabelControls from './LabelControls.svelte';
	import { mailbox } from '$lib/mail.svelte.js';

	const message = $derived(mailbox.message());
</script>

<div class="space-y-6 p-4 sm:p-6">
	<a href="#/" class="text-sm underline underline-offset-4">Back to mail</a>
	{#if message}
		<header class="space-y-2">
			<h2 class="text-2xl font-semibold tracking-tight">{message.subject}</h2>
			<p class="text-sm">From: {message.from.name} &lt;{message.from.address}&gt;</p>
			<p class="text-sm text-muted-foreground">To: {message.to}</p>
			<time class="text-sm text-muted-foreground" datetime={message.date}>
				{new Date(message.date).toLocaleString()}
			</time>
		</header>
		<LabelControls {message} />
		<pre
			class="whitespace-pre-wrap break-words border-t pt-6 font-sans text-base leading-relaxed"
		>{message.body}</pre>
	{/if}
</div>
