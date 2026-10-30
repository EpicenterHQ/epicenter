<!-- Test helper: Honeycrisp as the shell mounts it, under the repository gate and the app's providers, over a repository the test opens. Its path is `app-path.test-support`'s. -->
<script lang="ts">
	import { reactive } from '@epicenter/svelte/repository';
	import RepositoryGate from '@epicenter/svelte/repository/gate';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { at, navigate } from './app-path.test-support.svelte.js';
	import HoneycrispApp from './components/HoneycrispApp.svelte';
	import type { HoneycrispRepository } from './repository.js';

	let { repository }: { repository: HoneycrispRepository } = $props();
	// svelte-ignore state_referenced_locally
	const repo = reactive(repository);
</script>

<Tooltip.Provider>
	<RepositoryGate {repo} name="Honeycrisp">
		<HoneycrispApp {repo} path={at.path} {navigate} />
	</RepositoryGate>
</Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
