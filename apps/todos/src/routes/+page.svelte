<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import manifest from '../../epicenter.app.json';
	import { todosDefinition } from '$lib/definition.js';
	import { httpFetch } from '$lib/remote.js';
	import TodosView from './components/TodosView.svelte';

	// Inside Epicenter the folder is the one the shell handed this window; in a
	// browser, this browser's own folder for Todos, which its first todo
	// creates. A browser folder's pushes and fetches go through `httpFetch`,
	// which signs in to Epicenter's Git origin with this build's own account.
	// The commits a browser records keep Todos's own author.
</script>

<FolderApp
	app={manifest}
	definition={todosDefinition}
	browser={{ author: { name: 'Todos', email: 'todos@epicenter.so' }, httpFetch }}
>
	<TodosView />
</FolderApp>
