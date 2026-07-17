---
name: post-automation
description: Work on the /home/kyhrysk/post-automation Apps Script project that reads a Google Sheet schedule and posts text, images, or videos to X/Twitter. Use when Codex is asked to inspect, debug, modify, deploy, or explain this repository, its clasp configuration, appsscript.json scopes, コード.js Apps Script code, or the backing Google Sheet named X自動投稿.
---

# Post Automation

## Purpose

Use this skill for the X/Twitter scheduled-post automation in `/home/kyhrysk/post-automation`. Keep changes grounded in the Apps Script runtime, the backing Google Sheet, and X API authentication constraints.

## Project Map

- `コード.js`: Apps Script source for OAuth 1.0a signing, media upload, tweet creation, sheet polling, and trigger setup.
- `appsscript.json`: Apps Script manifest and OAuth scopes.
- `.clasp.json`: clasp project binding. Do not expose script IDs in final answers unless the user asks.
- `.env`: local secrets or notes. Treat as sensitive; do not print contents unless explicitly required.
- `package.json`: local tooling, currently centered on `@google/clasp`.

## Default Workflow

1. Inspect the relevant local files before editing. Prefer `rg`, `sed`, and `git status --short`.
2. If sheet behavior matters, use the Google Drive/Sheets connector to read metadata first, then bounded ranges. Do not guess tab names.
3. Read `references/sheet-contract.md` before changing sheet columns, status semantics, or row-processing logic.
4. Keep secrets in Apps Script Script Properties. Do not hard-code X API keys or tokens.
5. Keep Apps Script compatibility in mind: V8 runtime, Apps Script services such as `SpreadsheetApp`, `DriveApp`, `UrlFetchApp`, `PropertiesService`, `ScriptApp`, `Utilities`, and `Logger`.
6. After edits, run local checks that do not require production credentials. If pushing with clasp, ask for approval before network/deployment commands.

## Google Sheet Grounding

The production spreadsheet currently has ID `1tv3WyINPLComoybseAXIu-SOJ98DQ2C0NbCxieQEW3c`, title `X自動投稿`, locale `ja_JP`, timezone `Asia/Tokyo`, and a visible tab named `config`.

Important: `コード.js` may contain stale or unused constants. Prefer metadata from the live sheet over assumptions such as `Sheet1`.

## Implementation Rules

- Process only rows with a scheduled `datetime`, non-empty `text` or media payload, and a non-terminal status.
- Treat `posted` and `error` as terminal unless the user explicitly asks for retry behavior.
- Update status and result columns atomically enough for Apps Script constraints: write success only after the X API call succeeds; write error details on catch.
- For Drive media URLs, extract file IDs robustly and keep `drive.readonly` scope unless write access is necessary.
- For X media upload, distinguish image upload from chunked video upload.
- For X posting, preserve OAuth 1.0a signing behavior unless the task is specifically to migrate authentication.
- Avoid logging secrets, full OAuth headers, or access tokens.

## Validation

Use the strongest safe checks available for the change:

- `git diff --check`
- `npx clasp status` to inspect local/remote drift when clasp auth is available.
- `npx clasp push --dry-run` if supported by the installed clasp version; otherwise avoid deployment unless the user asks.
- Manual review for Apps Script globals and OAuth scopes, because this project has no test suite yet.

## Deployment Safety

- Do not run `clasp push`, create/delete Apps Script triggers, or modify the live Google Sheet unless the user explicitly requests that action.
- Ask for approval before commands that require network access, Google auth, or deployment.
- In final answers, state whether changes were only local or also deployed.
