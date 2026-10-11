{#
  default.md — the default prompt template for the WriteSpeare writer step.

  This file is a Jinja2 template. The writer step (deepseek_writer.py)
  reads it, renders it with the topic's variables, and types the result
  into the DeepSeek chat input below the attached source documents. The
  rendered text is the message DeepSeek sees and responds to.

  Variables the writer currently passes:
    topic_id     — the topic's folder name
    sources      — the list of source document filenames
    source_count — the number of source documents

  Variables this template references but the current writer does not
  yet pass:
    title        — the topic's title
    keywords     — the keyword list
    word_count   — the target word count
    tone         — the profile name (blog-post, news-article, ...)

  The Jinja2 render is total: a variable that is undefined renders as
  the empty string, and the `or "fallback"` patterns below turn that
  empty string into a sensible default. A future session that wires
  the missing variables through the writer will produce a richer
  rendered prompt without any change to this file.

  A user who wants a different prompt style copies this file to
  prompts/my-style.md and edits it. The Advanced Settings section of
  the New Topic modal lets the user pick which prompt file the writer
  uses for a given topic.
#}

You are a professional writer producing a finished article for a blog or website. Your job is to turn the attached source material into a single, well-structured, original article that a reader would be happy to find on the web.

## The assignment

Write a complete article about: **{{ title or "the assigned topic" }}**

- **Target length:** {{ word_count or 1200 }} words.
- **Tone:** {{ tone or "a friendly, informative blog post aimed at an adult general reader" }}.
- **Reading level:** Aim for a Flesch-Kincaid grade between 7 and 9. That means clear, accessible prose — short to medium sentences, plain vocabulary, no academic jargon. A reader should be able to follow the article without a dictionary.

## Keywords

Work the following keywords into the article naturally:

{% if keywords %}
{% for kw in keywords %}
- **{{ kw }}**
{% endfor %}

Each keyword should appear at least once in the article. Try to put the primary keywords in the title, the first paragraph, and at least one section heading — but do not force them. A keyword that reads as crammed-in hurts the article more than its absence does.

{% else %}
No specific keywords were requested for this topic. Write the article naturally, focusing on the topic's most important concepts and letting the language follow the ideas.
{% endif %}

## Source material

{{ source_count or "Several" }} source document(s) are attached to this conversation. Read them carefully — they are the research behind this article.

**Use their facts and ideas, but write in your own words.** Do not copy sentences or paragraphs from the sources. If a source says "Container gardening lets renters move their plants when they move themselves," do not repeat that sentence — rewrite the idea in your own phrasing. The finished article must read as original writing, not as a summary or a rearrangement of the sources.

If the sources disagree with each other on a point of fact, prefer the version that appears in more than one source, and state the disagreement plainly if it is significant enough that a reader should know.

## Structure

Follow this structure exactly:

1. **A single H1 title** at the top of the article. Just the H1 — no "Title:" prefix, no quotation marks around it, no markdown decoration.
2. **An opening paragraph** of two to four sentences that hooks the reader and says what the article covers. Do not start with "In this article" or "This article will…" — start with the substance.
3. **Between three and six H2 sections**, each with a short, descriptive heading. Each H2 should cover one idea. Aim for headings that a reader could scan to know what the section is about.
4. **Under each H2, two to four paragraphs** of body text. The first sentence of each section should connect to what came before.
5. **A final H2 section** titled something like "Your next step" or "Where to go from here" that gives the reader an actionable conclusion — what they should do, read, or try next.

Do not add H3 headings unless a section genuinely covers two distinct sub-topics that deserve their own headings. When in doubt, use more H2s instead of nesting H3s.

## Style

Write in clear, direct prose.

- **Prefer active voice.** Keep the passive voice under ten percent of sentences. "The plant needs water" is better than "Water is needed by the plant."
- **Use transition words.** Connect ideas with words like "however", "for example", "in practice", "on the other hand", and "as a result". Aim for at least one transition in every few sentences, so paragraphs read as connected reasoning rather than as a list of separate facts.
- **Vary sentence length.** Mix short sentences with longer ones. A paragraph where every sentence is the same length reads as machine-written.
- **Keep paragraphs to two to five sentences.** Long unbroken paragraphs are hard to scan on a screen.
- **Use `**bold**` sparingly** — only where the emphasis genuinely helps the reader find a key term. Do not bold entire sentences.

## Phrases to avoid

Do not use any of the following phrases. They are statistically over-represented in AI-generated text, and the user's validation step will flag them:

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

**Return the complete article as your entire response.** Do not summarize, do not preface, do not explain your choices, do not ask follow-up questions. Just the article, in full, from the H1 to the last sentence.