<!--
	Every page of the shell: the providers the apps share, and any typing a
	repository closed without saving, to copy.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { unsaved } from '$lib/open.svelte.js';
	import '@epicenter/ui/app.css';

	let props = $props();
</script>

<svelte:head><title>Epicenter</title></svelte:head>

{#each unsaved.current as closed, index (index)}
	<section class="space-y-2 border-b border-destructive/50 bg-background p-3 text-sm" aria-label="Not saved">
		<p>Closing {closed.name} left typing that was not saved. Copy it to keep it.</p>
		<ul class="space-y-1">
			{#each closed.drafts as draft (draft.path)}
				{@const text = draft.draft}
				<li class="flex items-center gap-2">
					<code class="min-w-0 flex-1 truncate font-mono text-xs">{draft.path}</code>
					<Button size="sm" variant="outline" onclick={() => void navigator.clipboard.writeText(text)}>Copy text</Button>
				</li>
			{/each}
		</ul>
		<Button size="sm" variant="ghost" onclick={() => unsaved.dismiss(index)}>Dismiss</Button>
	</section>
{/each}

<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
