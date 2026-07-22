<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import type { Snippet } from 'svelte';

	let {
		value = $bindable(''),
		canSend,
		isGenerating,
		onSend,
		onStop,
		placeholder = 'Type a message…',
		accessory,
	}: {
		/** The draft being typed. Bindable so the parent can own where it lives. */
		value?: string;
		/** The whole send gate, computed by the parent (model served on this
		 * device, no turn in flight, something to send). The button is just
		 * `disabled={!canSend}`. */
		canSend: boolean;
		/** A turn is in flight: show Stop instead of Send and lock the textarea. */
		isGenerating: boolean;
		onSend: (content: string) => void;
		onStop: () => void;
		placeholder?: string;
		/** Optional control rendered at the left of the input row, before the
		 * textarea. Omit it and the row is text plus send. */
		accessory?: Snippet;
	} = $props();

	function submit() {
		if (!canSend) return;
		onSend(value.trim());
		value = '';
	}
</script>

<form
	class="flex items-end gap-1.5 border-t bg-background px-2 py-1.5"
	aria-label="Chat message"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	{@render accessory?.()}
	<Textarea
		class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
		rows={1}
		{placeholder}
		aria-label="Message input"
		bind:value
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				submit();
			}
		}}
	/>
	{#if isGenerating}
		<Button
			variant="outline"
			size="icon-lg"
			type="button"
			onclick={onStop}
			aria-label="Stop generating"
		>
			<SquareIcon />
		</Button>
	{:else}
		<Button
			variant="default"
			size="icon-lg"
			type="submit"
			disabled={!canSend}
			aria-label="Send message"
		>
			<SendIcon />
		</Button>
	{/if}
</form>
