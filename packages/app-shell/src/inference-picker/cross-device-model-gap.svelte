<script lang="ts">
	/** An unavailable local selection requires an explicit replacement. */
	import { Button } from '@epicenter/ui/button';
	import type { InferenceConnections } from './connections.svelte.js';

	type Props = {
		scope: string;
		/** The conversation's current model id (synced, ADR-0055). */
		model: string;
		/** The device's inference connection registry. */
		connections: InferenceConnections;
		/** Switch this conversation to the app's hosted default. */
		onUseDefault: () => void;
	};

	let { scope, model, connections, onUseDefault }: Props = $props();
</script>

{#if !connections.canServe(scope, model)}
	<div
		class="flex items-center justify-between gap-2 border-t bg-muted/50 px-3 py-2 text-xs"
	>
		<span class="min-w-0 flex-1">
			Choose a connection on this device for
			<span class="font-mono">{model}</span>.
		</span>
		<Button
			variant="outline"
			size="sm"
			class="h-6 px-2 text-xs"
			onclick={onUseDefault}
		>
			Use Epicenter
		</Button>
	</div>
{/if}
