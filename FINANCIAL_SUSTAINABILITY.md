# How Epicenter Stays Open and Financially Sustainable

I've been thinking a lot about the right way to make Epicenter sustainable while staying true to our roots in transparency, openness, and open source.

Epicenter is where one person's software lives: small apps you and your agents make and change, each a folder of plain files in `~/Epicenter`. The `epicenter` program runs their actions, and `epicenter serve` offers them to your devices and your agents ([vision](docs/vision.md)). You supply the computer it runs on, the home: a Mac you leave on, a box in a closet, or a server you rent. Epicenter supplies the program ([ADR-0903](docs/adr/0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md)).

## What pays for it

Epicenter is paid for by services we host.

A hosted service is something we run on our own servers for many people, the way Google runs Gmail. Today that is the hosted API at `api.epicenter.so`: sign-in, AI inference paid for with credits, and the ledger of the earlier folder sync product, which is retired ([ADR-0899](docs/adr/0899-the-folder-sync-product-is-retired.md)). Hosted Notes may come next, if a month of real use shows the need ([ADR-0897](docs/adr/0897-hosted-notes-is-a-product-beside-epicenter-and-waits-for-a-month-of-evidence.md)). To your Epicenter, a service like this is an outside app, the same as Gmail: an app pulls a copy of what is there, or moves an item out of it into a folder you keep ([ADR-0898](docs/adr/0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md)).

Your Epicenter needs none of them. It runs on your home, and if you don't have a computer you can leave on, a small rented Linux server can be one.

For organizations that want to self-host our AGPL services, we'll offer support contracts.

## Why AGPL

We originally considered dual licensing: offer the whole project under AGPL, and sell a commercial license for companies that want to avoid copyleft obligations. But the projects we were modeling after don't actually do this. [Cal.com](https://github.com/calcom/cal.com) and [dub.sh](https://github.com/dubinc/dub) are just AGPL with hosted SaaS, no commercial license option. [Bitwarden](https://github.com/bitwarden/server) is closer: an AGPL server with proprietary enterprise modules under a separate "Bitwarden License." None of them dual-license, and none of them require a CLA.

So everything Epicenter ships is AGPL-3.0-or-later. You're free to run it, change it, and self-host it. If you distribute a changed version, or let other people use a changed version over a network, you share your changes with the community.

That one license covers both halves. A company that copies one of our hosted services and runs it as a competitor has to publish what it changed, so it can't keep its improvements to itself. A company that rents out homes is free to, and publishes what it changes. The more places a home can run, the more people get an Epicenter, and the license keeps every version open.

To me, this feels like the right trade. The repository is AGPL because to me AGPL is the ultimate manifestation of local-first open source: you're free to experiment and tinker, and if you ever want to distribute what you've built with other people, all we ask is that you share it with the rest of the community.

We have other options if hosted services don't sustain it, of course. We could pursue a traditional SaaS business around our apps, or go deeper into B2B enterprise memory. But this model is my favorite. It keeps the project as open as possible while building something financially sustainable.

## The license

There is one license: AGPL-3.0-or-later, for everything. An MIT toolkit tier existed until 2026-08 and was dissolved because no external embedder ever arrived. [docs/licensing/licensing-strategy.md](docs/licensing/licensing-strategy.md) has the reasoning and the threat model.

The root [LICENSE](LICENSE) lists every package and app it covers. That list is generated from each `package.json`, so it stays current.
