# Example conversations

These examples preserve the conversational direction selected with the user.
They are illustrations, not transcripts of skill test runs or scripts to follow.
In a real conversation, write only the agent's next turn and wait for the user.

## Finding words for a discomfort

**User:** I don't like having all these skills, but I also spent time making them.

**Agent:** Is it that you still value what's in them, but don't want all of them
telling the agent how to behave?

**User:** Yeah. Some are just things I wanted it to know.

**Agent:** Those might belong in reference notes. We can keep what you learned
without making each piece a separate workflow.

**User:** That's right. I don't want to throw away the knowledge.

## When the first attempt misses

**User:** I want the app to feel simpler.

**Agent:** Do you mean fewer choices on the screen?

**User:** No. I actually like having the options. I hate having to set everything
up first.

**Agent:** Ah, you want to start doing the thing before the app asks you to
configure it.

**User:** That's right.

**Agent:** Then I'd look at the first useful action. What could someone do
immediately, with the settings available afterward?

## Questioning a proposed fix

**User:** Maybe we should delete all the documentation. It keeps going stale.

**Agent:** Would you want to keep the explanations of why we made certain decisions?

**User:** Maybe. I just don't want agents treating old decisions as rules.

**Agent:** That sounds like the part to fix. An old decision can explain how we
got here without deciding what we do next.

**User:** That's right.

## Working through preferences that seem to conflict

**User:** I want agents to take initiative, but I hate when they change things
I was only thinking about.

**Agent:** You want room to explore an idea without the exploration becoming
permission to implement it.

**User:** Yes, but I don't want them asking permission constantly either.

**Agent:** Once you've asked for a change, they should carry it through. While
you're still asking whether the change makes sense, they should stay in the
conversation.

**User:** That's right. Like earlier, when we were discussing the skills.

**Agent:** I treated your leaning toward a cleanup as a settled choice about
where every skill belonged. I should have shown you that mapping while it was
still something to judge.

## Recommending when there is a choice

**User:** So do we need both grilling skills?

**Agent:** I don't think so. The useful parts are asking a good question, checking
the code, and helping you work through an answer. Dialectic can do those.

**User:** I still sometimes want you to interview me.

**Agent:** You can ask for that. “Ask me one question at a time” can change how
we're talking without needing another skill.

**User:** That's right. Let's remove them.

**Agent:** I'll remove both and update anything that points to them.

## Checks for future revisions

Use the examples above to check whether a revision follows the user's
correction, helps express the thought, and leaves room to answer. The old skill
required a whole articulation and progress on a crux in every turn; those
requirements made these small, useful responses difficult to produce.

Also check cases outside these examples. A complex architecture question may
need several paragraphs or code. A factual uncertainty may need repository
inspection before the next reply. “That's right” during exploration should not
cause a file edit, while “implement that” after a settled discussion should not
restart the interview.

For description routing, “Use dialectic to work through this ownership model”
and “Help me put into words why this workflow feels wrong” should select this
skill. “Implement the approved ownership change” and “Explain what this
function does” should not select it merely because understanding is involved.
These are review cases, not a claim that live routing has been measured.
