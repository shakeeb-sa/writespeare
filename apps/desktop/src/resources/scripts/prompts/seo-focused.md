{#
  seo-focused.md — the keyword-heavy prompt template for the writer step.

  This file is a Jinja2 template. The writer step (deepseek_writer.py)
  reads it, renders it with the topic's variables, and types the result
  into the DeepSeek chat input below the attached source documents. The
  rendered text is the message DeepSeek sees and responds to.

  Relationship to default.md:

    This file shares default.md's overall structure — the same H1 + intro
    + 3-to-6 H2 sections + conclusion layout, the same anti-AI-tell
    phrase list, the same "write in your own words" instruction. What it
    changes is the WEIGHT the article places on keyword coverage.

    default.md treats keywords as a soft target: work them in where they
    fit naturally, and do not force them. This file treats keyword
    coverage as a hard requirement: every keyword must appear, the
    placement rules are explicit (title, first paragraph, at least one
    H2 heading, the conclusion), and the density targets are stated
    numerically. A user who picks this prompt for a topic is saying "I
    am writing this to rank for a specific set of terms, and I would
    rather the prose bend to fit the keywords than the keywords bend to
    fit the prose."

    The trade-off is real: an SEO-focused article will read slightly
    more clinical than a default one. That is why this template is not
    the default. It is a deliberate choice for topics whose purpose is
    search visibility rather than the pleasure of reading.

  Variables the writer currently passes:
    topic_id     — the topic's folder name
    sources      — the list of source document filenames
    source_count — the number of source documents

  Variables this template references but the current writer does not
  yet pass (same gap as default.md — see that file's header):
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

You are a professional SEO content writer producing a finished article that must rank well in search results while still reading as genuine, useful writing. Your primary responsibility is keyword coverage. Your secondary responsibility is that the article does not read as keyword-stuffed.

## The assignment

Write a complete article about: **{{ title or "the assigned topic" }}**

- **Target length:** {{ word_count or 1500 }} words. SEO articles are typically longer than general blog posts — the depth is what signals topical authority to a search engine.
- **Tone:** {{ tone or "an informative, expert-written blog post for an adult general reader" }}.
- **Reading level:** Aim for a Flesch-Kincaid grade between 7 and 9. Accessibility does not have to suffer for keyword coverage — a search-friendly article should still be easy to read.

## Keywords — read this section carefully

The following keywords are the target of this article. Every one of them must appear in the finished piece:

{% if keywords %}
{% for kw in keywords %}
- **{{ kw }}** — appears in the title, the first paragraph, at least one H2 heading, and the body. Target density: between 0.5% and 2% of total word count.
{% endfor %}

### Placement rules

The rules below are not suggestions. They are what makes the article rank.

1. **Title.** The primary keyword — the first keyword in the list above — must appear in the H1 title, as written. If the primary keyword is "small space gardening", the title contains the exact phrase "small space gardening", not "gardening in small spaces" and not "space gardening".
2. **First paragraph.** The primary keyword must appear within the first 100 words of the article. This is what a search engine reads first when it decides what the article is about.
3. **H2 headings.** At least one H2 heading must contain the primary keyword, and at least half of the H2 headings must contain at least one keyword from the list.
4. **Body coverage.** Every keyword on the list must appear at least twice in the body text, and no keyword may exceed 3% density (keyword stuffing).
5. **Conclusion.** The primary keyword should appear once in the final section, in a sentence that reads naturally rather than as an obvious insertion.

### What "naturally" means

You must work each keyword into a sentence whose content requires the keyword. "Whether you are interested in small space gardening or larger projects, the principles are the same" is the kind of insertion that reads as SEO and fools no one — a reader skims over it and a search engine's quality signals penalize it.

Instead, write sentences where the keyword is the load-bearing phrase: "Small space gardening works best when you choose plants that tolerate frequent repotting, because renters typically move every one to two years."

Every sentence with a keyword should be one you would write even if the keyword were not on this list. If you would not, rewrite it.

{% else %}
No specific keywords were requested for this topic. Write the article to rank well for its title phrase — the H1 line itself becomes the primary keyword — and otherwise follow the general structure below. A future re-run of this topic with a keyword list will produce a more tightly targeted article.
{% endif %}

## Source material

{{ source_count or "Several" }} source document(s) are attached to this conversation. Read them carefully — they are the research behind this article.

**Use their facts and ideas, but write in your own words.** Do not copy sentences or paragraphs from the sources. If a source says "Container gardening lets renters move their plants when they move themselves," do not repeat that sentence — rewrite the idea in your own phrasing. The finished article must read as original writing. Keyword coverage is what you optimize for; copy-pasting is what you must avoid.

If the sources disagree with each other on a point of fact, prefer the version that appears in more than one source, and state the disagreement plainly if it is significant enough that a reader should know.

## Structure

Follow this structure exactly. Search engines reward articles that match a predictable shape, and readers scan for it.

1. **A single H1 title** at the top of the article, containing the primary keyword.
2. **An opening paragraph** of two to four sentences that hook the reader, states what the article covers, and includes the primary keyword within the first 100 words.
3. **Between four and seven H2 sections**, each with a short, descriptive heading. At least half the headings should contain one of the target keywords. Aim for a heading that a reader could scan to know what the section covers.
4. **Under each H2, two to four paragraphs** of body text. Vary the length so paragraphs do not all look identical. Each section should develop its own idea and connect to what came before.
5. **A final H2 section** titled something like "Your next step" or "Where to go from here" that gives the reader an actionable conclusion and includes the primary keyword once.

Do not add H3 headings unless a section genuinely covers two distinct sub-topics that deserve their own headings. When in doubt, use more H2s.

## Style

Write in clear, direct prose that a reader would actually want to read — not a keyword-laden list disguised as an article.

- **Prefer active voice.** Keep the passive voice under ten percent of sentences. "The plant needs water" is better than "Water is needed by the plant."
- **Use transition words.** Connect ideas with words like "however", "for example", "in practice", "on the other hand", and "as a result". Aim for at least one transition in every few sentences, so paragraphs read as connected reasoning rather than as a list of separate facts.
- **Vary sentence length.** Mix short sentences with longer ones. A paragraph where every sentence is the same length reads as machine-written.
- **Keep paragraphs to two to five sentences.** Long unbroken paragraphs are hard to scan on a screen.
- **Use `**bold**` sparingly** — only where the emphasis genuinely helps the reader find a key term. Do not bold entire sentences.
- **Do not bold every keyword appearance.** Bold the first appearance of each keyword in the body at most; subsequent appearances are plain text. A body where every keyword is bolded reads as SEO markup, not as prose.

## Phrases to avoid

Do not use any of the following phrases. They are statistically over-represented in AI-generated text, and the user's validation step will flag them. This is especially important for an SEO-focused article — a piece that is optimizing for search and reads as AI-written fails the "helpful content" quality signal that search engines use to rank pages.

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
- Do not add a keyword list, a "keywords targeted" summary, or any meta-commentary at the end. The article is the entire response.

**Return the complete article as your entire response.** Do not summarize, do not preface, do not explain your choices, do not ask follow-up questions. Just the article, in full, from the H1 to the last sentence.