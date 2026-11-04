<!-- A component reading the module-scope folder directly, with no adapter of its own. -->
<script lang="ts">
	import { folder } from './app.test-support.js';
</script>

<p data-testid="count">{folder.todos.loading() ? 'listing' : `${folder.todos.items().length} todos`}</p>
