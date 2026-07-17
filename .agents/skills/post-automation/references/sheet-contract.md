# Sheet Contract

Use this reference before changing spreadsheet reads/writes or status behavior.

## Current Spreadsheet

- Spreadsheet ID: `1tv3WyINPLComoybseAXIu-SOJ98DQ2C0NbCxieQEW3c`
- Title: `X自動投稿`
- Timezone: `Asia/Tokyo`
- Visible tab: `config`

Always confirm metadata with the Google Sheets connector before relying on these values for live work.

## Columns

| Column | Header | Meaning |
| --- | --- | --- |
| A | `datetime` | Scheduled post time. Interpret in spreadsheet / Apps Script timezone. |
| B | `text` | X/Twitter post body. Preserve newlines. |
| C | `image` | Google Drive file URL for image media. Optional. |
| D | `video` | Google Drive file URL for video media. Optional. |
| E | `status` | Processing state. `posted` and `error` are terminal by default. Empty means pending. |
| F | `post_date` | Success timestamp or error details, depending on current implementation. |
| G | `text_count` | Character count or helper metadata. Do not require this for posting unless requested. |

## Row Rules

- Row 1 is the header row.
- Pending rows usually have blank `status`.
- Skip blank `datetime` rows.
- Skip future `datetime` rows.
- Write `posted` only after the X API call returns success.
- Write `error` and a useful message when media upload or posting fails.

## Connector Read Rules

- Read spreadsheet metadata first.
- Use the exact visible tab name from metadata.
- Use bounded ranges such as `A1:G20`, then page if more rows are needed.
- Do not scan whole columns or whole grids unless the cell count is safely bounded.
