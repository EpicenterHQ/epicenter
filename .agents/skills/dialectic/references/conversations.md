# Example conversations

These are illustrations, not measured skill runs or records of the user's
preferences. They show three common settings for making something worth
reacting to. Writing starts with an attempt that a correction reshapes. API
design develops a recommendation and then reaches a fork. Skill design compares
experiences before deriving instructions. Their value is in the judgment and
response to the human, not their number of turns or alternatives.

Ordinary conversation stays in plain prose. Here the whole exchange is quoted
because it is a sample; drafts and exchanges presented inside it sit one quote
level deeper. Labels stay outside the inner artifact. Code stays in fences.
Short openings and simple labels help the reader enter the work without an
abstract explanation of each direction. These choices serve readability, not
a mandatory format.

## Writing: a correction reveals the opening

This example adapts the writing exchange the user supplied. Its wording and
continuation illustrate the behavior; they are not a verbatim transcript.

> **Human:** Humans rewrite a lot. We talk naturally, and people are intuitively
> familiar with conversation. But writing good dialogue is difficult. Help me
> find the piece in that.
>
> **Agent:** I'd stay close to the way you're discovering this while speaking.
> The contrast between recognizing dialogue and inventing it gives the piece
> somewhere to go. Here's an opening:
>
>> Humans rewrite a lot. We feel when something sounds off, say it again, and
>> choose a different word. We may not be able to explain exactly what changed,
>> but we hear the difference.
>>
>> That makes ordinary people experienced judges of language. We spend our
>> lives hearing conversations, misunderstanding each other, and trying again.
>>
>> Writing dialogue asks us to produce deliberately what we recognize almost
>> without thinking. The audience already knows what conversation feels like.
>> The writer has to invent it.
>
> **Human:** I meant write, not rewrite. And the opening should get to the
> surprising part faster: ordinary people are experienced judges of language.
>
> **Agent:** I'd lead with that. The correction moves the piece toward what
> people already recognize, rather than how they revise.
>
> **1. You already know more than you can explain**
>
>> You don't have to be a writer to be an experienced judge of writing.
>>
>> Ordinary people spend their lives around language. We write messages, read
>> emails, hear conversations, tell stories, misunderstand one another, and
>> notice when something sounds right or wrong. We may not be able to explain
>> the judgment, but we often recognize it instantly.
>>
>> Most people are probably better at recognizing good dialogue than producing
>> it. That is what makes writing dialogue so difficult: the writer has to
>> deliberately invent something the audience already knows intuitively.
>
> **2. Give ordinary people more credit**
>
>> Most people are better writers than they think, and better critics than
>> they realize.
>>
>> They may not be able to write convincing dialogue on demand. But they can
>> usually tell when dialogue feels forced, when a character is speaking
>> unnaturally, or when a sentence sounds like something nobody would say.
>>
>> A lifetime around language gives us expectations we rarely put into words.
>> Writing makes us work out how to meet them.
>
> **Agent:** I prefer the first. It gets to the difference between recognizing
> and producing good writing without claiming they're the same ability. The
> second has more swagger, but its opening promises a case we haven't made.

The agent makes the next attempt and judges it. The human need not request a
comparison, choose a winner, or invent the next question. A different reaction
could lead to one revised sentence instead of two openings.

## API design: make the caller's choices visible

This hypothetical example draws on Epicenter's independent-resource API design.
The snippets illustrate acquisition and ownership, not a runnable application
or a claim about current package exports. Unrelated setup is omitted.

> **Human:** Opening an entire app just to read an audio file feels wrong.
>
> **Agent:** I'd let the caller open file storage directly. Reading bytes
> doesn't require table definitions or an account:
>
> ```ts
> import { openLocalBlobs } from '@epicenter/app/blobs';
>
> const blobs = await openLocalBlobs({ id: 'audio-preview' });
> try {
>   const result = await blobs.get(blobId);
>   // Preview the audio from the result.
> } finally {
>   await blobs.close();
> }
> ```
>
> **Agent:** The cost is that callers opening several resources now own their
> cleanup. I'd keep that responsibility in the screen or product using them,
> rather than make every resource belong to an app again.
>
> **Human:** Yes. What if I add recording? Could the recorder take the same ID?
>
> **Agent:** It could. The difference is whether it opens its own storage or
> uses storage you've already opened. Here's what the caller would write.
>
> **1. The recorder opens its storage**
>
> ```ts
> // An alternative API sketch, not an existing constructor.
> const recorder = await openRecorder({ id: 'audio-preview' });
> try {
>   // Capture audio into the recorder's own storage.
> } finally {
>   await recorder.close();
> }
> ```
>
> **2. Pass the storage to the recorder**
>
> ```ts
> import { openLocalBlobs } from '@epicenter/app/blobs';
> import { createRecorder } from '@epicenter/app/recorder';
>
> const blobs = await openLocalBlobs({ id: 'audio-preview' });
> try {
>   const recorder = createRecorder({ blobs });
>   try {
>     // Capture audio into this storage; preview can use it too.
>   } finally {
>     await recorder.close();
>   }
> } finally {
>   await blobs.close();
> }
> ```
>
> **Agent:** I'd use 2 here. Recording and preview already need the same
> storage. Passing it makes that sharing explicit, and closing the recorder
> can leave preview usable. Version 1 is convenient for a recorder that owns
> the whole session, but sharing its storage would need another decision.
>
> **Human:** That's the part I care about. Recording can stop while preview
> stays open. The nested cleanup still looks heavy.
>
> **Agent:** Keep that lifetime distinction. The recording screen can manage
> these handles once, so its event handlers just use them. I'd check that
> actual caller before adding a shared helper; the smaller preview-only tool
> shouldn't inherit a recording session it doesn't need.

The agent surfaces the ownership cost before the human has to discover it,
recommends a direction, and uses the reaction to identify the behavior worth
preserving. The fork appears when a real alternative becomes relevant.

## Agent skills: experience the behavior before encoding it

The outer conversation concerns a skill. The inner samples show using it, not
editing its instructions. Facts about the fictional services are assumptions
of this illustration, not claims about a repository.

> **Human:** The architecture-review skill gives me a huge analysis. It doesn't
> feel like we're thinking together.
>
> **Agent:** I'd make it take a position earlier and leave room to develop it
> with you. These two conversations start with the same question, but give you
> something different to respond to.
>
> **1. Start with a recommendation**
>
>> **Human:** I'm thinking about combining these two services.
>>
>> **Agent:** I'd probably combine them. They share a database, deploy together,
>> and most changes touch both. Billing's write restrictions are worth keeping,
>> but they may not require a separate deployment. What's making you hesitate?
>>
>> **Human:** Mostly protecting billing from unrelated code.
>>
>> **Agent:** Then I'd combine the deployment and keep billing behind a narrow
>> internal API. That preserves the restriction while removing release coordination.
>
> **2. Start with what led you here**
>
>> **Human:** I'm thinking about combining these two services.
>>
>> **Agent:** What happened recently that made you want to combine them?
>>
>> **Human:** I had to coordinate two deployments for a tiny change.
>>
>> **Agent:** If deploying them together were easy, would you still want to
>> combine them? That would help distinguish a deployment problem from a boundary
>> that makes ordinary changes harder.
>>
>> **Human:** Almost every change crosses it. Deployment is only part of it.
>>
>> **Agent:** Then I'd examine combining them. Their billing write restriction
>> can remain an internal boundary; making it a separate service may be adding
>> work without providing the isolation you need.
>
> **Agent:** I'd lean toward 1 for your complaint: it gives you something to
> push against immediately. The useful part of 2 is finding out what prompted
> the question before getting attached to a solution.
>
> **Human:** I want both. Have an opinion, but stay interested in why I'm asking.
> I don't want an interview before you tell me anything.
>
> **Agent:** Then I'd try this opening:
>
>> Combining them looks reasonable because they deploy and change together.
>> I'd preserve billing's write restrictions inside the combined service.
>> What happened that made you consider it now? That could change whether
>> combining them is the right fix.
>
> **Human:** That's closer. Update the skill that way.
>
> **Agent:** I'll replace the push toward exhaustive analysis with that
> judgment: offer a grounded provisional view and investigate what could change
> it. The example's exact wording doesn't need to become a required opening.

## Check whether the judgment transfers

A useful attempt can be a sentence, a draft, code, a question, or an explanation.
These examples do not require artifacts or alternatives in every turn. Check
that the agent contributes judgment instead of making the human carry every
concern, and follows the actual response rather than completing a staged script.

A factual uncertainty may need inspection before another attempt. A request to
implement a settled change should proceed without restarting the discussion.
Recognition during exploration should not silently become authorization to edit.
These are review cases, not evidence that live routing or behavior was measured.
