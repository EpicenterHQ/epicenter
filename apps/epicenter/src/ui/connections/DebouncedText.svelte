<script lang="ts">
	import { Input } from '@epicenter/ui/input';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';

	/**
	 * A text field that saves what is typed a second after the last keystroke,
	 * when it loses focus, and when it goes away (ADR-0554). Until the person
	 * types, and once the save of what was typed lands, it shows the stored
	 * value. Escape puts the stored value back.
	 */
	let {
		label,
		value,
		save,
		placeholder,
	}: {
		label: string;
		/** The stored value. */
		value: string;
		/** Save `text`; resolves once it landed, or rejects with why it did not. */
		save: (text: string) => Promise<void>;
		placeholder?: string;
	} = $props();

	let typed = $state<string>();
	let problem = $state<string>();

	async function sendTyped() {
		if (typed === undefined) return;
		const sent = typed;
		if (sent === value) {
			typed = undefined;
			return;
		}
		try {
			await save(sent);
			problem = undefined;
			if (typed === sent) typed = undefined;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		}
	}
	const sendLater = useDebounce(sendTyped, 1000);
	// runed's timer outlives the field; send now instead.
	onDestroy(() => void sendLater.runScheduledNow());
</script>

<label class="grid gap-1">
	<span class="text-muted-foreground">{label}</span>
	<Input
		value={typed ?? value}
		{placeholder}
		aria-invalid={problem !== undefined}
		oninput={(event) => {
			typed = event.currentTarget.value;
			void sendLater();
		}}
		onblur={() => void sendLater.runScheduledNow()}
		onkeydown={(event) => {
			if (event.key === 'Escape') {
				typed = undefined;
				problem = undefined;
				event.currentTarget.blur();
			}
			if (event.key === 'Enter') event.currentTarget.blur();
		}}
	/>
	{#if problem}<span role="alert" class="text-destructive">{problem}</span>{/if}
</label>
