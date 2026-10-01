---
title: "Karpathy's second brain is a folder. Here's what's missing."
description: "The idea is great. Three folders and a schema file. But it breaks the moment you use two devices:and I think we can fix that without losing the simplicity."
pubDate: 2025-04-06
---

Karpathy posted his "second brain" setup recently. Three folders: `raw/` for dumping everything, `wiki/` where AI organizes it, `outputs/` where AI answers your questions. One schema file:CLAUDE.md:that tells the AI how to think about your knowledge. No apps. No databases. Just markdown files and a good prompt.

41,000 people bookmarked it. I was one of them.

I get the appeal. I'm the kind of person who has tried every note-taking app and always ends up back in a folder of markdown files. There's something about plain text that feels right:you own it, you can grep it, it'll outlive whatever app you're using today. Karpathy nailed the insight: stop organizing by hand. Let the AI do it. Your job is to capture; the AI's job is to file.

The thing is, I've been building something that looks a lot like this for the past year. Epicenter stores all your data:notes, transcripts, chat histories:in one folder of plain text and SQLite. Every app we build reads and writes to the same place. When I saw Karpathy's post, my first thought was "oh cool, he's doing the same thing." My second thought was "he's going to hit the same walls I did."

## The walls

It's one laptop. That's the first one. You edit a wiki article on your desktop, then open your laptop on the couch, and you're looking at stale files. You can hack around this with iCloud or Dropbox, but file-level sync doesn't understand content:if you edit the same file from two places, you get a conflict, and now you're manually merging markdown at 11pm.

There's no structured querying. Ripgrep is great, and I use it constantly, but try asking "all notes tagged #project that I haven't looked at in 30 days." That's a SQL query, not a text search. Karpathy's system doesn't have a way to express that without writing a custom script every time.

There's no encryption. Your `raw/` folder sits as plaintext on disk. If you're dumping medical notes, financial records, or anything genuinely private in there, you're trusting your disk encryption and nothing else. If you ever sync it anywhere, it's exposed.

And the schema file is a gentleman's agreement. CLAUDE.md tells the AI what to do, but nothing enforces it. The AI can write `inbox` instead of `raw` and your system silently drifts. Over months, the wiki accumulates contradictions and nobody notices until the monthly health check:which, let's be honest, you'll forget to run.

## What we're building differently

Epicenter uses Yjs, a CRDT library, as the single source of truth. CRDTs are data structures designed for exactly this problem:multiple devices editing the same data, merging automatically, no conflicts. Two people (or two of your devices) editing the same note at the same time always produces a valid merge. No "which version wins?" conversations.

The trick that makes this feel like Karpathy's system: Yjs materializes _down_ to plain files. The markdown files are still there. Still greppable. Still openable in Obsidian. But underneath, the CRDT handles sync and conflict resolution. Edit from your phone, edit from your laptop:the Yjs layer merges it.

It also materializes down to SQLite, which is where structured queries come in:

```bash
epicenter query "SELECT * FROM notes WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = 'project') AND updated_at < date('now', '-30 days')"
```

That's the `epicenter` CLI. Karpathy's monthly health check becomes a script you can cron instead of a prompt you remember to type.

Schemas are typed and enforced at runtime, not just documented:

```typescript
import { defineTable, field, plainText } from "@epicenter/app/definition";

const notes = defineTable({
  title: field.string(),
  tags: field.tags(),
  folder: field.select(["raw", "wiki", "outputs"]),
  content: plainText(),
});
```

That `folder` field can only be `raw`, `wiki`, or `outputs`. If the AI tries to write `inbox`, it fails at the schema level. Drift doesn't happen silently.

The sync server:which you can self-host:is a relay that passes updates between your devices. Run it on Epicenter Cloud and we hold your data; self-host it and the only machines holding your notes are yours.

## The honest trade-off

Karpathy's system is simpler. Three folders and a text file. Anyone can set it up in five minutes. Epicenter adds a library, a sync server, a CLI, a schema definition. That's real complexity. If you're one person on one laptop who never needs structured queries and never puts anything sensitive in your notes, Karpathy's system is probably the right call.

But I have a phone and a laptop. I want to search my notes by date and tag, not just by keyword. I have notes I'd rather keep on infrastructure I control. And I definitely want to automate things:a weekly digest, a health check, a script that surfaces stuff I've forgotten about. For me, the infrastructure overhead is worth it because the alternative is doing all of that by hand, badly, forever.

The markdown files are still there. You can still grep them. You can still open them in Obsidian. The CRDT layer is invisible until you need it:and then it's exactly what you needed.

If you want to look at the code: [github.com/EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter). The data package is at [packages/data](https://github.com/EpicenterHQ/epicenter/tree/main/packages/data). Everything in this repository is AGPL-3.0-or-later; versions published under the former MIT tier remain MIT. Fork it, break it, build your own second brain on top of it.
