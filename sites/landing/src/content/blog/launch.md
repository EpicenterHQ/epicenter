---
title: 'Launching Epicenter: One folder for your entire digital life'
description: 'An ecosystem of open-source, local-first apps that share a single memory'
pubDate: 2025-01-28
---

I have 47 browser tabs open right now. My thoughts are scattered across Notion, Obsidian, Apple Notes, Linear, and a dozen markdown files. My transcriptions live in Otter. My code context is locked in Cursor. Every tool has my data, but none of them talk to each other.

Sound familiar?

So I built Epicenter. It's simple: all your work. Notes, transcripts, chat histories. Lives in one folder on your machine. Plain text and SQLite. Every tool we build reads and writes to this same folder. Your transcription from this morning becomes searchable in your text editor this afternoon. Your chat with AI about that bug fix is right there next to the code.

## What we've built so far

**Whispering** started because I was tired of paying $20/month for transcription services that held my audio hostage. Now I transcribe locally with Whisper or use OpenAI's API for 2¢/hour. My transcripts go straight to markdown in my Epicenter folder. I can grep them, edit them in Vim, or open them in Obsidian.

**epicenter.sh** lets me talk to my codebase from anywhere. It spins up OpenCode (an open-source Cursor alternative) on my machine and tunnels it through Cloudflare. My code never leaves my laptop, but I can access it from my phone. Zero setup, zero trust issues.

These aren't separate apps with separate databases. They're windows into the same folder. When Whispering saves a transcript, epicenter.sh can reference it. When I take notes in my editor, my AI assistant knows about them.

## The insight that changed everything

In the age of AI, your context is your superpower. But every app wants to own that context. They wrap it in proprietary formats, sync it to their clouds, and charge you to access your own thoughts.

What if we did the opposite? What if every tool you used shared the same memory? Not through some complex API or sync service. Just by reading and writing to the same local folder.

That's Epicenter. Your workspace, your data, your tools.

## Where we're headed

We're building an entire ecosystem. A text editor that knows your meeting transcripts. A todo app that understands your codebase. An email client that can reference your notes. All reading from and writing to the same folder on your machine.

No accounts. No syncing. No lock-in. Just files you own and tools that respect them.

The technical details are boring (and that's the point): everything is plain text or SQLite. You can version control it with Git, back it up however you like, and search it with ripgrep. If we disappear tomorrow, your data is still just... files.

## Try it today

Start with Whispering: [github.com/EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter/tree/main/programs/whispering)

Or spin up epicenter.sh: [github.com/EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter/tree/main/apps/sh)

We're early. Things will break. But if you're tired of your tools treating you like a product instead of a person, come build with us.

Join our Discord: [go.epicenter.so/discord](https://go.epicenter.so/discord)

---

*P.S. The apps are AGPLv3 and the developer toolkit is MIT. Fork it, extend it, build on it. That's the whole point.*

