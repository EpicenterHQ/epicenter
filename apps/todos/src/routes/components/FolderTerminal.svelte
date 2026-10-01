<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';
	import type { TerminalSession } from '$lib/terminal.svelte.js';

	let { session, onClose }: { session: TerminalSession; onClose: () => void } = $props();

	let output = $state<HTMLDivElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	async function scrollToEnd() {
		await tick();
		output?.scrollTo({ top: output.scrollHeight });
	}

	async function run(event: SubmitEvent) {
		event.preventDefault();
		const running = session.run();
		void scrollToEnd();
		await running;
		await scrollToEnd();
		input?.focus();
	}
</script>

<section class="flex h-full min-h-0 flex-col bg-muted/30 font-mono text-xs" aria-label="Terminal">
	<div class="flex h-9 shrink-0 items-center gap-3 border-b ps-3 pe-1 font-sans text-xs text-muted-foreground">
		<span class="font-medium text-foreground">Terminal</span>
		<span class="truncate max-md:hidden">Same files as the app · git status, add, commit -m, diff, log, push, fetch, pull --ff-only</span>
		<Button class="ml-auto" variant="ghost" size="icon-sm" tooltip="Hide terminal" aria-label="Hide terminal" onclick={onClose}>
			<XIcon />
		</Button>
	</div>
	<!-- Output kept while the terminal was hidden reappears scrolled to its end. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		bind:this={output}
		class="min-h-0 flex-1 overflow-y-auto px-3 py-2"
		onclick={() => input?.focus()}
		{@attach (node) => node.scrollTo({ top: node.scrollHeight })}
	>
		{#each session.runs as item (item.id)}
			<div class="mb-1">
				<div><span class="text-muted-foreground">{item.cwd} $</span> {item.command}</div>
				{#if item.result}
					{#if item.result.stdout}<pre class="whitespace-pre-wrap">{item.result.stdout}</pre>{/if}
					{#if item.result.stderr}<pre class="whitespace-pre-wrap text-destructive">{item.result.stderr}</pre>{/if}
				{/if}
			</div>
		{/each}
		<form class="flex items-center gap-2" onsubmit={run}>
			<span class="shrink-0 text-muted-foreground" aria-hidden="true">{session.cwd} $</span>
			<!-- The shared Input supplies the visible focus ring; only size and font are set here. -->
			<Input
				bind:ref={input}
				bind:value={session.command}
				class="h-8 flex-1 font-mono md:text-xs"
				aria-label="Terminal command"
				aria-describedby="terminal-cwd"
				autocomplete="off"
				autocapitalize="off"
				spellcheck={false}
				disabled={session.running}
				{@attach (node: HTMLInputElement) => node.focus()}
				onkeydown={(event) => {
					if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
					if (session.recall(event.key === 'ArrowUp' ? 'previous' : 'next')) event.preventDefault();
				}}
			/>
			<span id="terminal-cwd" class="sr-only">Working directory {session.cwd}</span>
		</form>
	</div>
</section>
