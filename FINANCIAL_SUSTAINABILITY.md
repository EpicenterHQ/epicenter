# How Epicenter Stays Open and Financially Sustainable

I've been thinking a lot about the right way to make Epicenter sustainable while staying true to our roots in transparency, openness, and open source.

Epicenter is a set of local-first apps that share your data through CRDTs (notes, transcripts, chat histories, all in one folder you control). The library that powers this is something other developers can build on too. To keep working on this seriously, we need a way to sustain it that doesn't compromise the openness.

We originally considered dual licensing: offer the whole project under AGPL, and sell a commercial license for companies that want to avoid copyleft obligations. But the projects we were modeling after don't actually do this. [Cal.com](https://github.com/calcom/cal.com) and [dub.sh](https://github.com/dubinc/dub) are just AGPL with hosted SaaS, no commercial license option. [Bitwarden](https://github.com/bitwarden/server) is closer: an AGPL server with proprietary enterprise modules under a separate "Bitwarden License." None of them dual-license, and none of them require a CLA.

We landed on split licensing with an open-core model for a while: the library packages were MIT and everything else AGPL-3.0. That second tier is gone (see "The split" below), and today it is AGPL-3.0-or-later throughout, which means you're free to self host, and you can also distribute a modified version as long as you share your changes with the community. [Yjs](https://github.com/yjs/yjs), the CRDT library Epicenter is built on, does the same thing: the core library (as well as the client-side providers like y-websocket, y-webrtc, and y-indexeddb) are all MIT, but [y-redis](https://github.com/yjs/y-redis), the server-side scaling backend, is AGPL. [Liveblocks](https://github.com/liveblocks/liveblocks) follows a similar pattern (Apache client libraries, AGPL server), and so does [Bitwarden](https://github.com/bitwarden/server) (GPL clients, AGPL server, proprietary enterprise modules).

Epicenter Cloud will be the primary way we sustain the project: hosted sync infrastructure so you don't have to run your own server. Think [Supabase](https://github.com/supabase/supabase) selling hosted Postgres, or Liveblocks selling hosted collaboration. For organizations that want to self-host the AGPL components, we'll offer support contracts.

To me, this feels like the right trade. The repository is AGPL because to me AGPL is the ultimate manifestation of local-first open source: you're free to experiment and tinker, and if you ever want to distribute what you've built with other people, all we ask is that you share it with the rest of the community.

We have other options if that doesn't work, of course. We could pursue a traditional SaaS business around our apps, or go deeper into B2B enterprise memory. But the open-core model is my favorite. It keeps the project as open as possible while building something financially sustainable.

## The split

There is one license: AGPL-3.0-or-later, for everything. An MIT toolkit tier existed until 2026-08 and was dissolved because no external embedder ever arrived; see `docs/licensing/licensing-strategy.md`.

AGPL-3.0-or-later: every app (`apps/api`, `apps/self-host`, `apps/whispering`, `apps/honeycrisp`, `apps/vocab`, `apps/reddit`, `apps/landing`, `apps/posthog-reverse-proxy`, `apps/matter`, `apps/local-books`), the shared server library (`packages/server`), and our internal packages (`packages/auth`, `packages/svelte`, `packages/constants`, `packages/client`, `packages/matter-core`, `packages/vite-config`).

Each package under packages/ and apps/ has its own LICENSE file. See the root [LICENSE](LICENSE) for the full breakdown.
