<!-- The Todos page as the chooser mounts it, under the repository gate, with the tooltip provider, the confirmation dialog and the toaster, over a repository the test opens. -->
<script lang="ts">
	import { reactive } from '@epicenter/svelte/repository';
	import RepositoryGate from '@epicenter/svelte/repository/gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { TodosRepository } from '$lib/repository.js';
	import TodosApp from '../TodosApp.svelte';

	let { repository, syncsTo, onLeave = () => {} }: { repository: TodosRepository; syncsTo?: string; onLeave?: () => void } = $props();
	// svelte-ignore state_referenced_locally
	const repo = reactive(repository);
</script>

<Tooltip.Provider>
	<RepositoryGate {repo} name="Todos" {onLeave}>
		<TodosApp {repo} repository="Todos" {syncsTo} {onLeave} />
	</RepositoryGate>
</Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
