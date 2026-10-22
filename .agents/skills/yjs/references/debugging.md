# Yjs Debugging

This reference covers documents that converge to unexpected state or grow
faster than their content.

## Common Mistakes

### 1. Assuming Raw "Last Write Wins" Means Timestamps

It doesn't. Raw Yjs conflict ordering can use clientID, not wall-clock time.
Design document state around this or use single-writer keys. A value field and
a KV attribute both resolve by Yjs map LWW inside the one application document;
there is no second plane that decides it.

### 2. Using List Position for User-Controlled Order

Array position is for append-only data (logs, chat). User-reorderable lists need fractional indexing.

### 3. Forgetting Document Integration

Y types must be added to a document before use:

```typescript
// Detached: not part of a document, so no document update is emitted.
const orphan = new Y.Type<{ attrs: Record<string, string> }>();
orphan.setAttr('key', 'value');

// A standalone diagnostic document. App code uses its declared roots.
const doc = new Y.Doc();
const attached = doc.get('debug');
attached.setAttr('key', 'value'); // Emits the document update used by sync.
```

### 4. Storing Non-Serializable Values

Y types store JSON-serializable data. No functions, no class instances, no circular references.

### 5. Expecting Moves to Preserve Identity

Deleting a nested type and inserting a replacement changes its identity. It
does not move the existing type or transfer references held by editors and
providers. Keep the row's identity stable and update its ordering field for
user-controlled reordering.

## Debugging Tips

### Inspect Document State

```typescript
console.log(doc.toJSON()); // Full document as plain JSON
```

### Check Client IDs

```typescript
// See who would win a conflict
console.log('My ID:', doc.clientID);
```

### Watch for Tombstone Bloat

If documents grow unexpectedly, check for:

- Frequent `Y.Type.setAttr` overwrites
- "Move" operations on arrays
- Missing epoch compaction or a runtime doc accidentally created with `gc: false`
