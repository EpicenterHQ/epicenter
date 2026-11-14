---
title: 'The vault pattern: Why folders beat databases for personal tools'
description: 'How we use CRDTs and plain folders to build a personal database that actually works offline'
pubDate: 2025-01-29
---

I've been building personal tools for years. Every time, I start with SQLite. Every time, I regret it.

Not because SQLite is bad. It's fantastic. But because personal tools have different constraints than web apps, and databases optimize for the wrong things.

## The problem with traditional databases

I built a journaling app in 2020. Used SQLite, like everyone said I should. Then I wanted to sync between devices. My options:

1. Build a sync server (now I'm running infrastructure)
2. Use a sync service (now I'm vendor-locked)
3. Try to sync the SQLite file (corruption city)

I went with option 1. Six months later, I shut down the server. My journal died with it.

## Why CRDTs change everything

Last year I discovered Yjs. It's a CRDT library that makes distributed data structures feel like magic. Here's the key insight that took me too long to realize:

With CRDTs, sync isn't a feature you build. It's a property of the data structure.

```javascript
// This is all the sync logic you need
doc1.on('update', update => {
  Y.applyUpdate(doc2, update)
})
```

That's it. No conflict resolution. No sync servers. No three-way merges.

## The vault pattern

Once you have CRDTs, you don't need a database. You need a place to put files. Here's the pattern:

```
~/YourApp/
├── service1/
│   ├── data.yjs      # The CRDT document
│   ├── assets/       # Binary files (images, etc)
│   └── config.json   # Service-specific settings
├── service2/
│   └── data.yjs
└── README.md         # Explain the structure
```

Each service owns a folder. Each folder contains:
- One or more Yjs documents (the magic)
- Regular files for assets
- Human-readable configs

## One document per logical unit

The first time I used Yjs, I made one giant document for everything. Bad idea. Here's why:

- Large documents = slow initial sync
- Every change updates every peer
- Merge conflicts become tangled

Instead, use one document per logical unit:
- One doc per note
- One doc per email thread
- One doc per project

Now syncs are fast, conflicts are isolated, and you can garbage collect old data.

## The implementation

Here's actual code from Epicenter's note service:

```javascript
class NoteService {
  constructor(vaultPath) {
    this.notesDir = path.join(vaultPath, 'notes')
    this.docs = new Map()
  }

  async createNote(title) {
    const doc = new Y.Doc()
    const noteId = generateId()

    // Define the structure
    const note = doc.getMap('note')
    note.set('title', title)
    note.set('content', new Y.Text())
    note.set('created', Date.now())

    // Save to disk
    const filePath = path.join(this.notesDir, `${noteId}.yjs`)
    await fs.writeFile(filePath, Y.encodeStateAsUpdate(doc))

    this.docs.set(noteId, doc)
    return noteId
  }

  async loadNote(noteId) {
    const filePath = path.join(this.notesDir, `${noteId}.yjs`)
    const data = await fs.readFile(filePath)

    const doc = new Y.Doc()
    Y.applyUpdate(doc, data)

    this.docs.set(noteId, doc)
    return doc
  }
}
```

Simple, right? No SQL schemas. No migrations. Just data structures and files.

## Handling binary data

CRDTs are great for text and structured data. They're terrible for binary blobs. So don't put binaries in CRDTs. Put them in the filesystem:

```javascript
async addAttachment(noteId, file) {
  // Hash the content for deduplication
  const hash = await hashFile(file)
  const ext = path.extname(file.name)

  // Store in assets folder
  const assetPath = path.join(this.notesDir, 'assets', `${hash}${ext}`)
  await fs.copyFile(file.path, assetPath)

  // Reference in the CRDT
  const doc = this.docs.get(noteId)
  const attachments = doc.getArray('attachments')
  attachments.push([{
    hash,
    name: file.name,
    size: file.size,
    type: file.type
  }])
}
```

Now your attachments are just files. You can browse them with Finder. You can back them up with rsync. They're not trapped in a database blob column.

## Making it fast

CRDTs can get slow if you're not careful. Here's what works:

1. **Enable garbage collection**: `doc.gc = true`
2. **Snapshot periodically**: Save the full state every 1000 updates
3. **Load incrementally**: Start with the snapshot, then apply recent updates
4. **Index separately**: Keep a lightweight index for search

Here's our snapshotting logic:

```javascript
class DocManager {
  constructor(filePath) {
    this.filePath = filePath
    this.snapshotPath = filePath + '.snapshot'
    this.updatesPath = filePath + '.updates'
    this.updateCount = 0
  }

  async save(doc, update) {
    // Always append the update
    await fs.appendFile(this.updatesPath, update)
    this.updateCount++

    // Snapshot every 1000 updates
    if (this.updateCount >= 1000) {
      const state = Y.encodeStateAsUpdate(doc)
      await fs.writeFile(this.snapshotPath, state)
      await fs.unlink(this.updatesPath)
      this.updateCount = 0
    }
  }

  async load() {
    const doc = new Y.Doc()

    // Load snapshot if it exists
    if (await exists(this.snapshotPath)) {
      const snapshot = await fs.readFile(this.snapshotPath)
      Y.applyUpdate(doc, snapshot)
    }

    // Apply recent updates
    if (await exists(this.updatesPath)) {
      const updates = await fs.readFile(this.updatesPath)
      // Updates are concatenated, need to parse them
      let offset = 0
      while (offset < updates.length) {
        const updateSize = readVarInt(updates, offset)
        offset += getVarIntSize(updateSize)
        const update = updates.slice(offset, offset + updateSize)
        Y.applyUpdate(doc, update)
        offset += updateSize
      }
    }

    return doc
  }
}
```

## The payoff

Here's what you get with the vault pattern:

1. **True offline-first**: No sync server to be offline from
2. **Debuggable**: It's just files. Use standard Unix tools
3. **Portable**: Copy the folder to move your data
4. **Extensible**: Third-party tools can read/write the format
5. **Future-proof**: Even if Yjs dies, your data is in documented formats

## When not to use this

The vault pattern isn't always right. Skip it if:

- You need complex queries (use SQLite)
- You have millions of items (use a real database)
- You need ACID transactions (CRDTs are eventually consistent)
- You're building a web service (this is for personal tools)

## Try it yourself

I extracted the core vault pattern into a library: [vault-crdt](https://github.com/EpicenterHQ/epicenter/vault-crdt). It handles the boring parts (snapshotting, corruption recovery) so you can focus on your app.

Or just steal the ideas. That's why I'm writing this.

Personal tools should be personal. Your data should be yours. And folders of files is the most personal, portable data format we've invented.

Time to stop renting databases for our own thoughts.