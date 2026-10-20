# Example conversations

These illustrations pair an articulation of the model with a concrete
expression: prose to read, caller code, a conversation a skill could produce,
or a rendered website. The articulation explains the proposed meaning or
arrangement; the expression lets the user judge the choices made in realizing
it. They are not measured runs or records of the user's preferences. Reactions
may change either or both. The examples teach judgment, not a fixed sequence,
number of versions, or response format.

## Writing: a correction can leave several directions open

This sample develops the unread-books alternatives discussed with Braden.
The exchange is an illustration, not a record of work on a saved page. Its
closing selection and synthesis are hypothetical.

> **Human:** I like having books around even when I haven't read them.
> Sometimes I see one and remember why I bought it. I don't need every book
> to become homework.
>
> **Agent:** The thought seems to be that an unread book can bring back your
> curiosity without becoming an obligation. One way to say it:
>
>> Sometimes I see a book on my shelf and remember what interested me. Before
>> I've even opened it, it's given me something: that little return of curiosity.
>>
>> I don't need every book to become homework.
>
> **Human:** The return of curiosity is right. But “it's given me something”
> makes it sound like I'm justifying owning the book.
>
> **Agent:** Keep the return of curiosity and leave out the defense of owning
> the book. There are a few different thoughts we could develop from there.
>
> **A — Seeing an unread book reminds me what made me curious about it**
>
>> Sometimes I see a book on my shelf and remember why I bought it.
>>
>> **Oh right, I wanted to know about that.**
>>
>> **I don't need every book to become homework.**
>
> **B — I enjoy having books around, even when noticing them doesn't lead to reading them**
>
>> Sometimes I see a book on my shelf and remember why I bought it.
>>
>> **I like having books around even when I haven't read them.**
>>
>> **Sometimes that's as far as it goes.**
>
> **C — I can remain interested in a book without making plans to read it**
>
>> Sometimes I see a book on my shelf and remember why I bought it.
>>
>> **I look at it and think, I'm still curious about that.**
>>
>> **I don't necessarily take it down.**
>
> **Agent:** I'd start with A because it keeps your original moment of
> remembering most directly. C leaves more room for the interest to stay open.
>
> **Human:** A's voice, but C's ending. Show me that together.
>
> **Agent:** Keep the remembered thought, then let it end without taking action:
>
>> Sometimes I see a book on my shelf and remember why I bought it. Oh right,
>> I wanted to know about that.
>>
>> I don't necessarily take it down.

The correction settles something about the model without selecting one
expression. Each heading articulates a distinct direction in terms the user
can understand on its own; the passage beneath it shows how that direction
could read. The later reaction calls for a synthesis rather than another menu.
The same method can compare complete drafts when their development and endings
matter; short passages suffice for this local choice.


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

## Agent skills: revise a visible model

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

The articulation describes how the opening should teach the idea. The concrete
expression is the rendered opening, including prose, code, quotation, and their
spacing on the site. Plain text could show the wording but would leave the
reader's path through those elements to the user's imagination. A sentence-only
choice may need only prose in chat; this comparison needs the page.

Use the actual renderer or a local preview, and inspect the result before
showing it. Keep comparison conditions consistent without forcing versions to
have equal heights: changes in flow are part of the result. Previewing a
proposal does not require publishing it or replacing the authored source.
