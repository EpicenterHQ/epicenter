<!-- Todos as the shell mounts it, under the repository gate and the app's providers, over a repository the test opens, at the test's path. -->
<script lang="ts">
	import { reactive } from '@epicenter/svelte/repository';
	import RepositoryGate from '@epicenter/svelte/repository/gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { at, navigate } from '../app-path.test-support.svelte.js';
	import type { TodosRepository } from '../repository.js';
	import TodosApp from '../TodosApp.svelte';

	let { repository, onLeave = () => {} }: { repository: TodosRepository; onLeave?: () => void } = $props();
	// svelte-ignore state_referenced_locally
	const repo = reactive(repository);
</script>

<Tooltip.Provider>
	<RepositoryGate {repo} name="Todos" {onLeave}>
		<TodosApp {repo} path={at.path} {navigate} />
	</RepositoryGate>
</Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
