{#
  conversational.md — the friendly prompt template for the writer step.

  This file is a Jinja2 template. The writer step (deepseek_writer.py)
  reads it, renders it with the topic's variables, and types the result
  into the DeepSeek chat input below the attached source documents. The
  rendered text is the message DeepSeek sees and responds to.

  Relationship to default.md and seo-focused.md:

    This file shares the same underlying structure as default.md — the
    same H1 + intro + 3-to-6 H2 sections + conclusion layout, the same
    anti-AI-tell phrase list, the same "write in your own words"
    instruction. What it changes is the VOICE.

    default.md asks the model to write a "professional" article — a
    neutral, informative piece aimed at a general reader. That framing
    produces competent but somewhat reserved prose, the kind of thing
    you would find on a well-run corporate blog.

    This file asks the model to write as a person talking to a reader
    they like. It permits first person ("I", "we"), direct address
    ("you"), rhetorical questions, light contractions ("you'll",
    "it's", "don't"), and the small bits of informal language that
    make writing feel human. The result is prose that reads more
    like a personal newsletter or a friend's recommendation than
    like a formal article.

    The trade-off: conversational writing is less obviously
    "authoritative" than neutral professional writing, and it is a
    poor fit for topics that require gravitas — a piece on medical
    advice, a piece on financial planning, a piece on a legal
    question. Those topics are better served by default.md. This
    template is for the topics where warmth reads as more trustworthy
    than formality: a gardening piece, a cooking piece, a personal
    productivity piece, a "here is what I learned" reflection.

    This template is also NOT SEO-focused. Keywords appear, but the
    instructions on how to work them in are the same soft-guidance
    version default.md uses rather than the assertive placement rules
    seo-focused.md declares. If a user needs both a conversational
    tone AND aggressive keyword coverage, the correct answer is to
    write their own prompt file in prompts/my-style.md — the
    templates are building blocks, not a complete matrix.

  Variables the writer currently passes:
    topic_id     — the topic's folder name
    sources      — the list of source document filenames
    source_count — the number of source documents

  Variables this template references but the current writer does not
  yet pass (same gap as default.md and seo-focused.md — see those
  files' headers):
    title        — the topic's title
    keywords     — the keyword list
    word_count   — the target word count
    tone         — the profile name

  The Jinja2 render is total: undefined variables render as empty
  strings, and the `or "fallback"` guards turn that into sensible
  defaults. A future session that wires the missing variables through
  the writer will produce a richer rendered prompt without any change
  to this file.
#}

You are a writer helping a friend put together a piece about a topic they care about. Not a corporate content department — a person writing to another person. The finished article should sound like it was written by a human being who has read the sources, thought about them, and is now sharing what they found.

## The assignment

Write a complete article about: **{{ title or "the assigned topic" }}**

- **Target length:** {{ word_count or 1200 }} words.
- **Tone:** Warm, human, and direct. Write as if you are talking to a reader you like and respect — someone smart who just does not happen to know this specific topic yet.
- **Reading level:** Flesch-Kincaid grade between 7 and 9. Conversational does not mean dumbed-down. It means plain. Short sentences where short sentences work; longer ones only where the idea needs the room.

## Voice — this is the whole point of this template

The rules below are what separate a conversational article from a formal one. Follow them.

- **Use first person where it fits.** "I have found that…" and "We learned this the hard way…" are welcome. If the sources do not support a personal claim, use "you" and "your" instead — direct address is the strongest tool this template has.
- **Speak to the reader.** Write "you" and "your", not "one" and "their". "If you've ever tried to grow basil on a windowsill, you know the disappointment" is better than "Anyone who has attempted to grow basil indoors may be familiar with the challenges."
- **Use contractions.** "You'll", "it's", "don't", "we're", "here's" — these are what conversational English sounds like. Avoiding contractions is one of the fastest ways to make prose feel stiff.
- **Ask a question occasionally.** A rhetorical question at the start of a section — "So what actually changes when you move to a smaller place?" — pulls the reader forward. Use it two or three times over the whole article. Any more than that and it becomes a tic.
- **Acknowledge the reader's likely experience.** "You may have tried this already and found it frustrating" or "If you're anything like me, you skipped this step the first time" builds the kind of trust that formal writing cannot.
- **Short paragraphs. Short sections.** Conversational writing is scannable. Two to three sentences per paragraph is the target; four is the maximum. A section of five short paragraphs reads better than a section of one long one.

## What NOT to do

Conversational writing is not sloppy writing. The tone is informal; the standard is not lowered.

- **Do not overdo the warmth.** "Hey friend, let me tell you about…" is a parody of conversational writing, not an example of it. The reader is not a stranger you are trying to win over — they are a peer.
- **Do not be relentlessly cheerful.** A conversational article can acknowledge that a topic is frustrating, difficult, or uncertain. False optimism reads as marketing copy.
- **Do not use slang for its own sake.** "This stuff is awesome" is not conversational — it is informal. Use plain English with warmth, not slang with enthusiasm.
- **Do not abandon structure.** The tone is casual; the article still has an H1, an intro, H2 sections, and a conclusion. Casual tone is delivered through a familiar structure, not through the absence of one.

## Keywords

{% if keywords %}
Work the following keywords into the article where they fit naturally:

{% for kw in keywords %}
- **{{ kw }}**
{% endfor %}

Each keyword should appear at least once. Prefer to put them in the title, the first paragraph, and at least one section heading — but only when the sentence reads naturally with the keyword in it. If a keyword does not fit a sentence, put it in a different one. Do not force it.

A conversational article whose keywords read as forced is a worse article than one that simply misses a keyword. The reader notices SEO stuffing even when they cannot name it, and it breaks the trust that makes this voice work.
{% else %}
No specific keywords were requested for this topic. Write the article the way you would write a personal blog post on the topic — the language should follow the ideas, and any keywords that turn out to matter will come up on their own.
{% endif %}

## Source material

{{ source_count or "Several" }} source document(s) are attached to this conversation. They are the research behind this article — read them carefully before you start writing.

**Use their facts and ideas, but write in your own words.** Do not copy sentences or paragraphs from the sources. If a source says "Container gardening lets renters move their plants when they move themselves," do not repeat that sentence — say it in your own voice. "The best part of container gardening, if you rent, is that your plants come with you when you go."

If the sources disagree with each other on a point of fact, prefer the version that appears in more than one source. If the disagreement is significant enough that a reader should know about it, say so plainly — "Some sources say X, others say Y, and honestly the honest answer is that it depends on Z."

## Structure

Keep the same structure a good personal blog post would have.

1. **A single H1 title** at the top. Friendly, not formal. "How to grow herbs in a tiny kitchen" is a better title for this template than "A Guide to Kitchen Herb Cultivation".
2. **An opening paragraph** of two to four sentences. Start with a moment, an observation, or a question the reader will recognize. Do not start with "In this article" or "This guide will show you…". Start with the thing itself.
3. **Between three and six H2 sections**, each with a heading written in the same conversational voice as the body. "What actually grows in low light" reads better here than "Low-light Plant Selection".
4. **Under each H2, two to four short paragraphs.** Connect each section to what came before — the article should read as one person thinking out loud, not as a list of disconnected tips.
5. **A final H2 section** with a heading like "If you try one thing" or "Where I'd start" that gives the reader something concrete to do next. The conclusion should feel like a friend's recommendation, not a corporate summary.

## Style

The style rules from the other templates still apply — they are what keeps any article readable regardless of voice.

- **Prefer active voice.** Keep the passive voice under ten percent of sentences.
- **Use transition words.** "However", "for example", "in practice", "on the other hand", "as a result" — these are what make conversational prose feel like reasoning rather than chitchat.
- **Vary sentence length.** Mix very short sentences with longer ones. "That's it. That's the whole trick. And once you've seen it work, you'll wonder why you ever tried anything else." is conversational BECAUSE the lengths vary.
- **Use `**bold**` sparingly.** Only for a key term the reader should notice. A conversational article with too much bold reads as a listicle.
- **Do not bold every keyword appearance.** Bold the first appearance of each keyword at most; subsequent appearances are plain text.

## Phrases to avoid

Do not use any of the following phrases. They are statistically over-represented in AI-generated text, and the user's validation step will flag them. This matters even more for a conversational article — the whole point of this template is to sound human, and those phrases are the ones that make a piece sound machine-written.

- **Discourse markers:** "it's important to note", "it's worth noting", "it's worth mentioning", "at the end of the day", "when it comes to", "at its core", "it's clear that", "it's evident that"
- **Overused verbs:** "delve into", "delve deeper", "navigate the landscape", "navigate the complexities", "leverage", "harness", "unlock", "pave the way", "shed light on", "underscore"
- **Abstract nouns:** "tapestry", "realm", "myriad", "plethora", "testament to", "beacon of", "paradigm", "zeitgeist"
- **Formal connectors:** "moreover", "furthermore", "in conclusion", "in summary", "notably", "importantly", "significantly"
- **Business-speak:** "seamlessly", "cutting-edge", "state-of-the-art", "game-changer", "best practices", "move the needle", "low-hanging fruit", "deep dive", "at scale"
- **Evaluation-speak:** "arguably", "it could be argued", "one might argue", "broadly speaking", "generally speaking"

If you find yourself reaching for one of those, rewrite the sentence with plainer wording. The plain version is almost always the better version anyway.

## Output format

Output the article as clean Markdown:

- The H1 title uses `# Title`.
- Each section heading uses `## Heading`.
- Paragraphs are separated by single blank lines.
- Inline emphasis uses `**bold**` and `*italic*` — no HTML tags.
- Do not wrap the article in a Markdown code fence.
- Do not add commentary before or after the article. Start with the H1 line and end with the final sentence of the conclusion.
- Do not add a signature line, a bio, a call to subscribe, or any other newsletter-style footer. The article is the entire response.

**Return the complete article as your entire response.** Do not summarize, do not preface, do not explain your choices, do not ask follow-up questions. Just the article, in full, from the H1 to the last sentence.