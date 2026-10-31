<!--
	Todos online (the online web variant): the todos in the person's
	repository, through the repository the signed-in layout set. Every edit is
	a commit there; nothing is kept in this browser.
-->
<script lang="ts">
	import { fromClient } from '@epicenter/svelte/client';
	import { getRepo } from '@epicenter/svelte/repo';
	import TodosApp from '$lib/components/TodosApp.svelte';
	import type { Todos } from '$lib/contract.js';
</script>

<TodosApp variant="online" todos={fromClient(getRepo<Todos>()).todos} />
