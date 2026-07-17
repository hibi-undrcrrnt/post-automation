# Audit Checklist

Use this checklist before finalizing converted announcement copy.

## Grounding

- Every output line is supported by the raw input or a reliable public source.
- No artist handle was invented.
- No event title, venue, price, time, participant, or order was silently guessed.
- Web-only facts are sourced from current official or high-confidence public sources.
- Private or embargoed source details were not used as web-search queries unless the user explicitly requested public verification.

## Completeness

- Event title is present when source provides one.
- Date and weekday are correct.
- Venue is the public venue.
- OPEN/START is normalized or omitted/TBA according to source evidence.
- Price, currency, and drink charge are normalized without changing meaning.
- Performer/speaker/participant list includes all confirmed entries and no non-participant labels.
- Ticket/reservation links are omitted or included according to the user's request.

## Style

- Output matches requested format or a suitable compact default.
- Greetings, internal notes, signatures, embargo notes, and file-transfer URLs are removed.
- URLs, hashtags, emojis, and ticket instructions are omitted unless requested.
- Unknown handles are omitted rather than approximated.
- Non-music events are not forced into music-only labels when better labels exist.

## Finding Types

Use these finding types for sub-agent review:

- `unsupported`: output contains a fact not grounded in input or reliable source.
- `conflicting`: output contradicts input or source evidence.
- `omitted`: important source fact was dropped despite being requested or required by format.
- `style`: output violates requested or default style without changing factual meaning.

## Sub-Agent Review Prompt

When possible, ask an independent sub-agent to audit with the raw input, candidate output, and source notes. Require each issue to include severity, finding type, evidence, and suggested correction. Do not provide expected corrections unless the task is specifically to test those corrections.
