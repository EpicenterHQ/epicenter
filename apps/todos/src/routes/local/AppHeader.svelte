<!--
	The header over this device's local folder: the app's name and whether
	everything is saved on this device. It offers no Save version, Sync, or
	Connect: this storage keeps no history and syncs nowhere yet.
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import { getFolder } from '@epicenter/svelte/folder';
	import type { todosTables } from '$lib/definition.js';
	import { saveLine } from '$lib/local-todos.js';

	const local = getFolder<typeof todosTables>();
	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();

	const saved = $derived.by(() => {
		const line = saveLine(local.saveState, local.edits.failures, local.status.storageFailure);
		return pendingNewTodo && line.tone === 'good'
			? { label: 'Todo not added', tone: 'warning' as const }
			: line;
	});
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	<StatusPopover summary={saved} details={[{ name: 'Saving', testid: 'status-files', line: saved }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-folder">This device</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				Saved locally on this device. Todos does not sync these todos to other devices yet.
			</span>
		</StatusRow>
	</StatusPopover>
</header>
