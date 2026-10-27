# Example conversations

These illustrations make the progression and particular conversational
judgments available for examination. They are not measured runs or records of
the user's preferences. The complete reading-list example has been reviewed;
the existing examples that follow are being reviewed individually for retention.

## Reading list: intent, vision, and concrete form

Everything in this conversation is hypothetical, including the user's replies.
It shows corrections leading to revisions and recognition establishing a basis
for the next stage. The final stage develops one consequential piece of the
design; it does not settle the entire implementation.

**User:** I keep saving articles, but the list just gets longer. Can we rethink it?

**Agent:** My first reading of the intent is:

> Help me decide what to read next.

Does that capture what you're reaching for?

**User:** Partly. But I don't necessarily want to read more. Sometimes I just
want to remember what interested me.

**Agent:** Then I'd revise the intent to:

> Help me return to things that interested me, whenever that interest becomes
> relevant again.

Finishing the list wouldn't be the measure of success. Is that closer?

**User:** That's right.

**Agent:** Starting from that intent, I'd imagine arriving with a current
curiosity. You might say, “I've been thinking about cities,” and encounter a few
things you saved, with enough context to recognize what drew you to them.

The vision could be:

> A reading list you return to through curiosity, where saved things can become
> interesting again.

**User:** I like that, but I also want to stumble across things. I won't always
have a question.

**Agent:** Then the vision needs room for both searching and accidental
rediscovery:

> A place to rediscover your interests, whether you come looking for something
> or encounter something you'd forgotten.

You could arrive with a question, or simply open it and see a few things you
once cared about.

**User:** That's right.

**Agent:** Working backward, one consequential question is what we preserve
when you save something. The article tells us its subject; a passage you
highlighted or a few words from you could preserve what caught your attention.

For the capture interaction, I'd start with:

> **Saved.**
> Add what caught your attention: a passage, a thought, or a question.

That addition would be optional, so saving remains immediate.

**User:** That's right. But sometimes I won't remember why until I encounter
it again.

**Agent:** Then that context should be editable whenever you return. The saved
item could show:

> **Why this caught my attention**
> Add a passage, thought, or question.

Saving works immediately, and rediscovery can develop the context later. That
gives us one piece of the design to build on before we work out how resurfacing
should work.

**User:** That's right.

The move from rediscovery to preserving personal context is a design judgment
to examine. Another concrete approach might fulfill the vision better.

## Writing: recover the person in the expression

This hypothetical exchange shows how the same idea can lose its speaker, and
how developing the source language can make a new expression judgeable. All
material and reactions are invented for the example.

**Supplied words**

> I don't think a simple API is one where I never have to think. It's more
> like when I do have to think, the thing I'm thinking about is my problem.
> I don't want to be sitting there wondering which of three methods is the
> real one.

**Earlier attempt**

> A good API reduces cognitive overhead and lets developers focus on their goals.

**Sample conversation**

> **Human:** That's roughly the idea, but it sounds like somebody explaining
> me. It doesn't sound like me saying it.
>
> **Agent:** Your version keeps returning to “think,” then lands on the
> frustration of choosing between three methods. The summary loses that
> movement. I'd develop those words and give the frustration its own paragraph.
>
> **Earlier attempt**
>
>> **A good API reduces cognitive overhead and lets developers focus on their
>> goals.**
>
> **Proposed version**
>
>> **I don't think a simple API means I never have to think. I want
>> the thinking to be about my problem.**
>>
>> **If I'm sitting there wondering which of three methods is the real one,
>> the API has given me another problem to solve.**
>
> **Human:** The first paragraph sounds more like me. But “another problem
> to solve” wraps it up too neatly. I'm more exasperated about which one I'm
> supposed to use.
>
> **Agent:** Keep the first paragraph and let the ending sound more like
> that moment of frustration.
>
> **Previous version**
>
>> I don't think a simple API means I never have to think. I want the thinking
>> to be about my problem.
>>
>> **If I'm sitting there wondering which of three methods is the real one,
>> the API has given me another problem to solve.**
>
> **Proposed version**
>
>> I don't think a simple API means I never have to think. I want the thinking
>> to be about my problem.
>>
>> **I don't want to sit there looking at three methods and thinking, wait,
>> which one am I supposed to use?**

The source, failed attempt, and revisions expose what each change does. The
agent contributes arrangement and new language, then learns that its neat
ending loses the author's emotional register. The next attempt carries the
recognized paragraph forward and develops the unsettled ending. It remains a
proposal; the example leaves the author's next reaction open.

## API design: make the caller's choices visible

This hypothetical example draws on Epicenter's independent-resource API design.
The caller code makes acquisition and cleanup visible so the human can judge
using the design. These are sketches, not a runnable application or a claim
about current package exports. Unrelated setup is omitted.

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
> Storage is an independent resource. The recorder uses it without owning its
> lifetime, so recording can stop while storage stays available for preview.
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

## Agent skills: inspect instructions and behavior

This hypothetical exchange shows how different contributions advance different
questions within one skill-editing conversation. All replies are illustrative.

> **Human:** I want my comparison skill to recommend something, but I don't
> want it to act like the decision is already settled.
>
> **Agent:** You want a judgment you can examine: what the agent would choose,
> why, and what could make another choice better. I'd replace “List the
> advantages and disadvantages of each option” with:
>
>> Recommend a direction when you have grounds. Explain the reason that
>> decides it for you and what could change your recommendation. Leave room
>> for the user to challenge that judgment or introduce another possibility.
>
> **Human:** That last sentence sounds like it will add a disclaimer to every
> answer.
>
> **Agent:** Naming what could change the recommendation can already leave
> room for disagreement. For a choice between autosave and a Save button for
> private notes, it could read:
>
>> I'd use autosave here. Writing a private note shouldn't require a separate
>> decision to keep it. I'd show whether changes are still saving so the user
>> can tell when they're stored.
>>
>> I'd reconsider if saving also published the note or triggered another
>> action. Then a Save button could give the user a useful moment of control.

> **Agent:** I'd cut the last sentence from the instruction:
>
>> Recommend a direction when you have grounds. Explain the reason that
>> decides it for you and what could change your recommendation.

The first reply connects a reading of the intent with actual proposed wording.
The user's concern then makes behavior the question, so the agent shows a
sample and revises the instruction in light of it. The user can judge the
wording and its possible effect without asking for each contribution in turn.
The exchange does not establish a required order or require all three in every
turn. The sample proposes behavior rather than proving an agent will reliably
produce it.

## Product design: revise a visible model

This hypothetical exchange uses the Epicenter cloud discussion to show a model
the human can point to and change. The services are a proposal, not a claim
about shipped behavior.

> **Human:** One subscription could work even if someone only uses Whispering.
> What would be inside Epicenter's cloud?
>
> **Agent:** I think one account could give each app access to shared services:
>
> ```text
> apps ──> one account
>            ├── sync
>            ├── storage
>            └── hosted AI
> ```
>
> In Whispering, that could mean transcription without configuring a provider
> and access to work someone chooses to save on another device. That alone
> could make a subscription useful to a Whispering-only customer.
>
> **Human:** I meant coordination too. The apps might pass things to each other.
>
> **Agent:** Then the map is missing a relationship:
>
> ```text
> apps ──> one account
>            ├── sync
>            ├── storage
>            └── hosted AI
> Whispering ── chosen text ──> another app
> ```
>
> That second line is a user-chosen handoff. I would keep it separate from the
> launch subscription promise for now. A Whispering-only user could already
> pay for hosted transcription and saved work; the handoff needs a destination
> worth opening. I would prototype one destination and see whether people use
> it before selling “coordination” as a benefit.

The first map makes the omission easy to name. The agent changes that map when
the human corrects it, then recommends what to promise now and what to test
next. The diagram gives the human a place to correct the model; the agent's
judgment carries the conversation forward.


## Blog writing: compare the rendered openings

This illustrative exchange draws on the blog-opening comparison discussed in
conversation `01a0c8c6-13fa-7903-9877-946764e5e8d3`. The proposed follow-up
reaction is hypothetical. The italicized actions stand in for screenshots;
in live work, render and show the actual images.

> **Human:** We've revised the opening several times and I can't tell whether
> it's getting better. Can I see the versions side by side?
>
> **Agent:** The latest opening states the rule, shows the code, then explains
> what happened. The earlier opening gives readers a map of the call chain
> first. I'll show both alongside the original on your blog so you can compare
> how the openings actually read.
>
> *The agent reconstructs the original, ASCII-first, and code-first openings
> from available source history and the conversation. It renders local previews
> in the actual site, keeping the viewport and unrelated styling the same.
> Each capture includes the opening and its transition into the next section.
> The agent checks the captures and shows the three labeled versions together.*
>
> **Agent:** The code-first version gets to a concrete example sooner. The
> ASCII-first version shows the whole chain before asking readers to follow
> the code. I'd start with code-first for someone skimming, but its longer
> code block pushes the explanation farther down the page.
>
> **Human:** Code-first is clearer, but now I see why the quote underneath
> feels repetitive. Keep the opening sentence and code. Try a shorter quote.
>
> *The agent revises only the quote in the code-first preview and renders it
> again. It shows that result beside the previous code-first version, with
> enough surrounding content to judge the transition. The selected opening
> sentence and code remain unchanged.*
>
> **Agent:** Here's the shorter quote in place. It explains the change from
> returning a result to acting on it, without repeating the opening rule.

The explanation describes how the opening should teach the idea. The rendered
opening lets the user judge how the prose, code, quotation, and spacing work
together. Plain text could show the proposed wording but would leave the
reader's path through those elements to the user's imagination. A sentence-only
choice may need only prose in chat; this comparison needs the page.

Use the actual renderer or a local preview, and inspect the result before
showing it. Keep comparison conditions consistent without forcing versions to
have equal heights: changes in flow are part of the result. Previewing a
proposal does not require publishing it or replacing the authored source.
