<!--
	"Synced": the todos in the person's repository, through the repository
	the signed-in boundary set (decision 76). Edits here write to the
	repository; this device's own todos are on the "On this device" page.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import type { Todos } from '$lib/contract.js';
</script>

<TodosApp view="synced" todos={fromClient(getRepo<Todos>()).todos} />
