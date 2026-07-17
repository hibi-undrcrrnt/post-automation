---
name: event-announcement-format
description: Convert raw Japanese or English live-event information, booking emails, venue messages, flyers, ticket pages, or copied SNS posts into concise X/Twitter-ready event announcement copy. Use when Codex must extract and normalize event title, date, venue, open/start times, prices, performers/speakers/lineup, ticket or reservation facts, and public handles, with safe web verification and sub-agent audit for output verification.
---

# Event Announcement Format

## Purpose

Convert messy event material into compact, post-ready announcement copy. Optimize for faithful extraction, public-facing clarity, and no invented facts.

## Required References

- Read `references/format-patterns.md` before handling unfamiliar input shapes, ticket terminology, non-standard price/time notation, or non-music events.
- Read `references/artist-handles.md` before adding performer handles.
- Read `references/audit-checklist.md` before finalizing output.

## Default Output Shapes

For music/live-house events, use this compact shape when fields exist:

```text
"<event title>"
<yyyy>/<m>/<d>(<weekday>)
<venue>
OPEN/START : <open-start>
ADV/DOOR : <adv>円/<door>円 +1D

出演:
<artist> ( @<handle> )
<artist>
```

For non-music events, adapt labels to the source, for example `登壇:`, `出店:`, `DJ:`, `Lineup:`, or neutral `参加者:`. Omit lines for fields that are absent rather than fabricating `TBA`, unless the source explicitly says `TBA` or `未定`.

## Workflow

1. Parse the source material into facts: title, date, venue, open/start, ticket prices, drink charge, performers/speakers/lineup, ticket/reservation URL, announcement embargo, and uncertainty notes.
2. Identify confidentiality. If the source is private, embargoed, or pre-announcement, do not search unpublished event-specific facts on the web. Search only already-public facts such as public artist handles, venue official names, or facts the user explicitly asks to verify.
3. Drop non-public boilerplate: greetings, signatures, internal coordination, file-transfer links, and apology/polite text.
4. Normalize only facts present in the source or verified through safe public search. Do not invent titles, venues, handles, prices, or lineup order.
5. Use web search when public facts are missing or ambiguous and searching will not expose private event details. Prefer current official artist/venue websites, verified SNS profiles, official event pages, ticket pages, and venue schedules. Avoid stale posts and aggregators unless no better source exists.
6. Draft the announcement in the requested or default format.
7. Run sub-agent audit when sub-agents are available. Pass the raw input, candidate output, source notes, and the currently loaded skill; ask for grounded findings, not stylistic rewriting.
8. Apply audit findings that are clearly grounded in the input or reliable public sources. If a fact remains uncertain, omit it or mark it as `TBA` only when that is the source value.
9. Final response should normally contain only the announcement block. Add a short note only when facts were unresolved, omitted, changed after audit, or sourced only from web verification.

## Web Search Rules

- Use narrow queries that do not leak private event details when the source is not public. For handles, search `<artist name> X`, `<artist name> official`, or the artist website.
- Use full event queries such as `<event title> <venue> <date>` only when the event is already public or the user explicitly asks to verify public listings.
- Use web search to verify handles; never infer handles from names.
- If multiple handles conflict, prefer the account linked from an official site or current official event/venue page. If still ambiguous, omit the handle.
- Keep source notes outside the announcement block when using web-only facts: source type, source URL if available, and whether the fact was missing from the raw input.
- Do not include source links in the announcement block unless the user requests ticket/reservation links.

## Normalization Rules

- Date: output `yyyy/m/d(曜)` with no zero padding. Convert Japanese dates, slash dates, dot dates, and English weekday forms.
- Weekday: compute or preserve only when confident. If source weekday conflicts with computed weekday, prefer the calendar date and note the conflict outside the block.
- Venue: use the public venue name, not the sender company name, unless the sender identity is the only venue evidence.
- OPEN/START: output `OPEN/START : TBA` when both are explicitly TBA/未定. Otherwise use `OPEN/START : <open>/<start>` only when at least one time exists.
- Price: for Japanese live events, output `ADV/DOOR : <adv>円/<door>円 +1D` when both prices exist and drink charge is separate. For other currencies or event types, preserve the source currency and label.
- Drink charge: normalize `+1Drink`, `D代別`, `1drink charge`, `(+D)`, and similar to `+1D` for Japanese live-house copy.
- Participants: remove honorifics such as `様`, trim bullets, preserve official capitalization/punctuation, and keep role labels like `(DJ)` only when part of the public listing.
- Ordering: preserve explicit billing/running order. If the input gives an unordered list, preserve input order unless a project-specific reference explicitly applies.

## Handle Rules

- Add handles from `references/artist-handles.md`, source text, or web-verified official profiles.
- Format known handles as `<artist> ( @handle )`.
- If a handle is unknown or ambiguous, output only `<artist>`.
- Do not create approximate handles from artist names.
- Update `references/artist-handles.md` only when the user asks to persist a new mapping or the current task is explicitly to maintain the skill.

## Sub-Agent Audit Requirement

When sub-agent tools are available, audit every non-trivial conversion before final output. Use a prompt shaped like:

```text
Use the currently loaded event-announcement-format skill and references to audit this conversion. Check whether every output fact is grounded in the raw input or a reliable public source, whether any source facts were incorrectly omitted, and whether unknown handles were invented. For each issue, return: severity, finding type (unsupported/conflicting/omitted/style), raw-input evidence or URL/source, and suggested correction. Return a corrected block only if needed.
```

Do not leak your intended answer as ground truth. Treat the sub-agent as an independent reviewer of the raw input, source notes, and candidate output.

If sub-agent tools are unavailable, run the same checklist locally and state only material unresolved issues.

## Output Discipline

- Do not add hashtags, emojis, sales copy, flyer URLs, ticket URLs, or reservation URLs unless requested.
- Keep the block scannable and short for X/Twitter.
- Do not label the answer as `output:`.
- Do not include audit notes when the conversion is clean and the user asked only for converted text.
