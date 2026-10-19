<!--
	Todos over its declared folder: the desktop build's granted directory, or
	the OPFS folder `so.epicenter.todos` an earlier browser build kept its
	todos in. Temporary in a browser: it is removed once a verified migration
	brings those todos to this browser's local folder.

	The page loads this module only when it chooses this storage, so the
	local folder's path never loads the account (`#platform/auth`) it
	imports.
-->
<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import manifest from '../../../epicenter.app.json';
	import { todosDefinition } from '$lib/definition.js';
	import { httpFetch } from '$lib/remote.js';
	import TodosView from './TodosView.svelte';

	// Inside Epicenter the folder is the one the shell handed this window; in a
	// browser, the folder an earlier build kept. A browser folder's pushes and
	// fetches go through `httpFetch`, which signs in to Epicenter's Git origin
	// with this build's own account. The commits a browser records keep
	// Todos's own author.
</script>

<FolderApp
	app={manifest}
	definition={todosDefinition}
	browser={{ author: { name: 'Todos', email: 'todos@epicenter.so' }, httpFetch }}
>
	<TodosView />
</FolderApp>
