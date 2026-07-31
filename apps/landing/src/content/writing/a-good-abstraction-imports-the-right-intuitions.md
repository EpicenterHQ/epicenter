---
title: "A Good Abstraction Imports the Right Intuitions"
subtitle: "The name should teach you how to think before you hear the definition."
writtenOn: "2026-07-19"
approvedOn: "2026-07-28"
editionId: "019faa69-203f-7000-a527-4439c8b98749"
canonicalUrl: "https://bradenwong.com/a-good-abstraction-imports-the-right-intuitions/"
editionUrl: "https://bradenwong.com/editions/019faa69-203f-7000-a527-4439c8b98749/"
tags:
  - "abstraction"
  - "naming"
  - "product-design"
  - "the-ark"
narrationUrl: "https://bradenwong.com/editions/019faa69-203f-7000-a527-4439c8b98749/narration.mp3"
---

It does not just give a long definition a short name. The name itself is an intuition pump: it naturally imports the additional meaning and connotations the word already carries in everyday life.

Consider a "promise" in software engineering.
```js
// the commitment exists now
const promise = fetch("/api/user");

// the result arrives later
const response = await promise;
```
The word "promise" already carries the most important intuitions: something has been committed to now and will be settled later. We can reason about this because we use the word "promise" in everyday life. You hear "promise" and intuitively get a sense of the model before you even hear the definition.

So much of software engineering is choosing tasteful abstractions and deciding which concepts a codebase gets to have. Each concept name teaches the next programmer how to think. So, does it pump the right intuitions? That's the question we should ask ourselves.
