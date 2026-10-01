# 0442. Epicenter sells hosted services while Whispering remains free

- **Status:** Proposed
- **Date:** 2026-09-24
- **Relates:** [ADR-0441](0441-whispering-keeps-speech-evidence-local-and-syncs-only-its-speech-profile.md) (recording and transcript ownership), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (hosted and custom inference connections), [ADR-0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) (current hosted billing)
- **Unbuilt:** The subscriber-facing offer and launch presentation. A change from the current per-minute credit wallet to an unlimited standard transcription entitlement is not decided by this record.

## Context

Whispering is a free, open-source application. A person can transcribe on the
device, use a provider connection they configure, or use a self-hosted
endpoint. Epicenter also operates a hosted inference gateway, currently billed
through a shared credit wallet. Selling access to the application would put a
paywall around software people may run and modify themselves. Selling a bundle
of applications would ask a person to value apps they may never use.

The immediate launch test is whether someone will pay for Whispering's hosted
transcription even if they use no other Epicenter application. Epicenter can
still have one account and one billing relationship for hosted services that
other applications use later.

## Decision

**Applications remain free to use; an Epicenter Cloud subscription pays for
Epicenter-operated services.** Whispering is the first application through
which a person may buy that subscription. Its paid benefit is hosted
transcription without setting up an on-device model, provider key, or
self-hosted endpoint. The same Epicenter account and subscription can authorize
eligible hosted services in other Epicenter applications. No person must use a
second application to get the value they paid for in Whispering, and there is
no separate Whispering license or application subscription.

Whispering continues to offer on-device inference, a person's configured
provider connection, and a self-hosted endpoint without an Epicenter Cloud
subscription. A chosen external provider may charge the person independently.
When the person chooses hosted Epicenter transcription, the audio is sent for
that inference request; the resulting recording and transcription history
remain in Whispering Local under ADR-0441. The hosted call does not publish a
Whispering cloud audio archive. The synchronized speech profile and text the
person explicitly adds to Capture have their own separate data boundaries.

The first purchase explanation is the Whispering outcome: transcription that
works without model or key setup. The account-level explanation is that one
Epicenter Cloud subscription can cover hosted services across applications.
Potential Local Mail, Vocab, or blob-storage benefits do not have to exist or
be used to justify a Whispering subscription at launch.

This record decides what is free and what the subscription buys, not the
price, included models, usage allowance, or abuse controls. In particular,
"unlimited standard hosted transcription" is a candidate offer rather than a
shipped entitlement. The accepted per-minute credit decision in ADR-0100 and
the current billing catalog govern until a separate decision explicitly
amends them.

## Consequences

Whispering can have paying subscribers while the application and all of its
local workflows stay open source. The hosted experience must earn payment on
convenience and results rather than on withheld application features. A
Whispering-only subscriber is a successful initial customer; cross-application
use is optional expansion, not a launch dependency.

Marketing must not say all transcription is fully local: a selected hosted or
direct provider receives audio for inference. It may say recordings and
transcription history stay local. Cloud blob storage is not a Whispering launch
benefit under this decision.

## Considered alternatives

- Charge for the Whispering application: conflicts with its open-source use and
  makes the payment boundary a license rather than an operated service.
- Sell the three applications as a bundle: makes a person judge products they
  do not need before paying for the one they do.
- Lead with an Epicenter developer API: makes infrastructure the first
  purchase decision when the immediate customer wants transcription to work.
- Include a cloud audio archive to enlarge the paid offer: adds remote
  recording ownership and storage work without evidence that Whispering's
  launch customer wants it.
