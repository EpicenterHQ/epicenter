<!-- Test helper: Honeycrisp as the shell mounts it, under the repository gate, with the tooltip provider, the confirmation dialog, and the toaster, over a repository the test opens. -->
<script lang="ts">
	import { reactive } from '@epicenter/svelte/repository';
	import RepositoryGate from '@epicenter/svelte/repository/gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import HoneycrispApp from './components/HoneycrispApp.svelte';
	import type { HoneycrispRepository } from './repository.js';

	let { repository, syncsTo }: { repository: HoneycrispRepository; syncsTo?: string } = $props();
	// svelte-ignore state_referenced_locally
	const repo = reactive(repository);
</script>

<Tooltip.Provider>
	<RepositoryGate {repo} name="Honeycrisp">
		<HoneycrispApp {repo} repository="Honeycrisp" {syncsTo} repositoryHref="/me/honeycrisp" />
	</RepositoryGate>
</Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
