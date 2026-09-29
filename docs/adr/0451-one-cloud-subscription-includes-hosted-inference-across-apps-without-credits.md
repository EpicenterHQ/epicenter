# 0451. One Cloud subscription includes hosted inference across apps without credits

- **Status:** Proposed
- **Date:** 2026-09-24
- **Amends:** [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) for subscribed hosted inference by replacing subscriber-facing credits with included use.
- **Unbuilt:** A subscription entitlement for hosted inference across apps, its included model policy, internal cost measurement, and a subscriber experience without credit balances, top-ups, or per-call credit prices.

## Context

Epicenter Cloud currently sells Pro, Ultra, and Max plans with a shared AI credit wallet. `apps/api/worker/billing/catalog.ts` grants credits, prices overages, and offers a credit top-up. `packages/constants/src/ai-providers.ts` assigns credit prices to hosted chat models and names one hosted transcription model. The hosted dashboard and model picker show credit balances and model costs. A person using Whispering for transcription and Vocab for tutor chat must therefore reason about the same wallet in two different activities. The existing credit policy and catalog remain operative until the subscription entitlement is implemented.

Whispering can transcribe with an on-device model, a configured provider, or a self-hosted endpoint. Vocab can send tutor turns through a selected inference connection. The applications do not require a paid application license. The reason to subscribe is that Epicenter runs the hosted inference path, especially when configuring models and keys on a mobile device is inconvenient.

## Decision

**One Epicenter Cloud subscription includes the standard Epicenter-hosted inference path in every participating application without asking the subscriber to manage credits.** Whispering's standard path transcribes audio. Vocab's standard path answers tutor turns. An application that later offers hosted inference joins the same subscription instead of selling its own application plan. A person can subscribe from one app and use only that app.

The subscriber chooses Epicenter Cloud, a configured provider, or a self-hosted endpoint as the inference connection. On-device inference remains available where the application and device support it. A direct provider or self-hosted connection does not consume the Epicenter Cloud subscription. A provider used directly may bill the person separately.

An account pays one recurring plan fee for the included hosted paths, with no application-specific add-on, per-call credit price, credit balance, or top-up decision. Epicenter still measures provider spend, request volume, latency, and failures by account and capability so it can operate and price the service. The provider and model serving each standard path are operator choices; their names are not part of the subscription promise.

This decision does not set the monthly price, choose the standard models, promise unrestricted automated or bulk processing, or define a numerical fair-use threshold. A launch offer must state any actual usage restriction before purchase. It cannot call a hidden hard cap unlimited. Separate decisions must define the included-use boundary and provider policy before replacing the current credit gate.

Paying for hosted inference does not move Whispering's recording or transcript history or Vocab's chat history into the inference gateway. Vocab's saved entries continue to sync through Personal under [ADR-0445](0445-vocab-saves-local-chats-and-syncs-saved-entries.md). The selected hosted request still sends the input needed for inference to Epicenter's provider.

## Consequences

A subscriber can move between Whispering and Vocab without buying another plan or checking a shared wallet. Someone who uses only Whispering can still be a successful subscriber. Each app must offer enough value on its own; future apps cannot justify today's price before their hosted capabilities exist.

The current credit catalog, hosted model picker, billing gates, dashboard balance, top-up, and overage presentation need a coordinated replacement for subscribed hosted inference. Internal metering remains necessary because a fixed subscription price does not bound provider spend. The service cannot claim that every available provider model is included merely because one standard hosted path is included.

## Considered alternatives

- One paid license per application: asks the person to buy software that remains useful with local, direct-provider, or self-hosted inference.
- A shared credit wallet: gives one bill across apps but makes ordinary transcription and tutor practice a series of balance decisions.
- Include every hosted model at one price: exposes a fixed subscription to provider costs that vary by model and request size.
