# Format Patterns

Use this reference to parse varied event source material.

## Common Music / Live-House Source Shapes

| Source text | Meaning | Normalized field |
| --- | --- | --- |
| `OPEN 18:30 / START 19:00` | Open and start times | `OPEN/START : 18:30/19:00` |
| `OPEN/START 16:30/17:00` | Open and start times | `OPEN/START : 16:30/17:00` |
| `開場 18:00 / 開演 19:00` | Open and start times | `OPEN/START : 18:00/19:00` |
| `open: 18:30 start: 19:00` | Open and start times | `OPEN/START : 18:30/19:00` |
| `OPEN / START：TBA / TBA` | Times unknown | `OPEN/START : TBA` |
| `ADV¥2500 / DOOR¥3000(+D)` | Advance/door, drink separate | `ADV/DOOR : 2,500円/3,000円 +1D` |
| `Adv. ¥4500 / Door ¥5000` | Advance/door | `ADV/DOOR : 4,500円/5,000円` unless drink charge appears elsewhere |
| `￥3,500- / ￥4,000- (D代別途要)` | Advance/door, drink separate | `ADV/DOOR : 3,500円/4,000円 +1D` |
| `admission: 2000yen ... door: 2500yen` | Advance/admission and door | `ADV/DOOR : 2,000円/2,500円` for Japanese live copy |
| `出演`, `ACT`, `live act`, `w/`, `with` | Performers | Lines under `出演:` or source label |
| `会場`, `at`, `@`, venue line after date | Venue | Venue line |
| `TICKET`, `予約フォーム`, `取り置き` | Ticket/reservation | Omit by default unless requested |

## Non-Music Event Labels

Choose labels from the source. If the source uses a clear role, preserve it.

| Source role | Output label candidate |
| --- | --- |
| `登壇者`, `Speakers`, `Talk` | `登壇:` or `Speakers:` |
| `DJ`, `DJ ACT` | `DJ:` |
| `出店`, `Vendors` | `出店:` or `Vendors:` |
| `出演`, `ACT`, `Lineup` | `出演:` or `Lineup:` |
| Unclear participant list | `参加者:` |

Do not force `出演:` onto talks, markets, screenings, workshops, or conferences if a better source label exists.

## Title Heuristics

Prefer explicit quoted or labeled titles:

- Japanese quotes: `「...」`, `『...』`, `“...”`
- Labels: `公演名`, `イベント名`, `presents`, `tour`, `LIVE INFORMATION`
- If multiple title-like strings exist, choose the event title, not the announcement heading such as `情報解禁` or `Live情報`.

## Date Heuristics

Accept these input forms:

- `2026年8月23日（日）`
- `2026/8/23(日)`
- `2026.04.04（SAT）`
- `2026/4/24/fri`
- `日時 : 2026年7月8日(水)`

Output `yyyy/m/d(曜)`. Japanese weekday labels: `日`, `月`, `火`, `水`, `木`, `金`, `土`.

## Price Heuristics

- Remove currency symbols and trailing hyphens for Japanese live-house output.
- Add thousands separators when absent: `2500` -> `2,500円`.
- Preserve source currency for non-JPY events.
- Keep special tiers only if the user asks; default compact copy should use the main `ADV/DOOR` pair.
- For `SOLD OUT`, keep only if it materially changes public copy and the user asks for current sales status.

## Performer / Participant Heuristics

- Remove list bullets: `・`, `-`, `*`, numbering.
- Remove honorifics: `様`, `さん` when clearly not part of the public name.
- Split slash-separated lists only when the slash separates acts or participants, not when it is part of a name.
- Preserve annotations that identify a role or lineup variation, e.g. `(DJ)`, `from ...`, only when present in the public listing.

## Public Copy Defaults

Default output intentionally omits:

- Flyer links
- Long ticketing instructions
- Embargo times
- Contact phone numbers
- Internal notes and possible-additional-act caveats

Include those only when the user requests a fuller announcement.
