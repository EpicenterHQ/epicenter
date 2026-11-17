# A save can finish after the person has moved on

In the November 2026 review of Vocab and Zhongwen, saving a phrase could
succeed and still lose work. While the save was pending, the person could
select the next phrase. The first save's completion closed the new phrase's
bar and cleared the browser selection.

The old success callback had already used the submitted word to report which
word it saved. Its last two lines acted on whatever was open when it finished.

```ts
phrase = '';
document.getSelection()?.removeAllRanges();
```

Selecting “milk,” then “tea,” then “milk” again exposed the limit of comparing
strings. By the time the first save finished, the word matched and the person
had started another selection. The browser checks also exercised the interval
before the bar's debounced selection update. In that interval the browser
could already be showing “tea” while the component still held “milk.”

Three interactions in the review called for different behavior:

| Interaction | What happened during the save | What the person expected when it finished |
|---|---|---|
| Add a vocabulary word | The Add form represented one entry and held its fields read-only during the request. | Clear that entry on success. Keep it available for retry on failure. |
| Save a selected phrase | The person could select another phrase while the first saved. | Report the saved word. Dismiss the bar only if the original control and selection still owned it. |
| Capture a quick entry | The person could submit a second entry before learning that the first had failed. | Surface the first failure even after the second submission, and preserve the newer input. |

The phrase bar needed the identity of its control and the live selection.
Capture needed the outcome of each call. Moving recovery onto that call's
`mutateAsync` promise let it survive a newer submission taking over the
mutation observer. [Mutation callback lifetimes](../../.agents/skills/query-layer/references/mutation-lifecycle.md#callback-lifetime-and-timing)

The retired folder-sync product had a smaller case in its note-repair
component. [Folder-sync history](../adr/0899-the-folder-sync-product-is-retired.md)

Its test submits a note titled “Milk,” adds `done: true` while the save is
held, then releases the
save. The repair callback fires once and the extra line stays in the textarea.
Inside this editor, a comparison with the text submitted is enough to decide
whether to clear the local edit. The phrase bar needed more because the person
could leave and return to the same phrase. [Note repair](../../packages/svelte/src/note-repair.svelte) · [Regression test](../../packages/svelte/src/note-repair.test.ts)

## A save could wait for later typing

The retired folder editor exposed `landed()`, a promise that resolved when the
editor had no outstanding save or typing left to write. Consider a Send action
that required the note to be saved first. This illustrative handler captures
the reviewed text before waiting. `FolderClosed` came from `@epicenter/folder/core`. [Editor implementation](../../packages/folder/src/note-edit.ts)

```svelte
<button onclick={async () => {
  const submitted = { id, text: edit.text };
  try {
    await edit.landed();
  } catch (error) {
    if (!(error instanceof FolderClosed)) throw error;
    reportError(error, 'Could not save the note before sending.');
    return;
  }
  send.mutate(submitted);
}}>Send</button>
```

In the two-save check, the person clicked Send on A and typed B while A's
write was held. Releasing A started B's write. Only after B landed did the
wait finish, and the captured payload still held A. A Send action that needed
only the reviewed text could skip the wait. An action that required a save
could hold editing read-only if later typing must not extend that wait.

If the folder failed or closed first, `landed()` rejected with `FolderClosed`.
The handler reported the failure and returned before sending. The editor kept
the typing. [Decision on waiting writes](../adr/0782-a-waiting-write-the-folder-will-not-make-rejects.md)

An export of the saved note used the opposite read order. After `landed()`
resolved, it could read the saved entry for the captured ID, handle a missing
entry, and export the content the store actually held. [Current submission guidance](../../.agents/skills/svelte/references/input-ownership.md#submitting-from-an-editor)
