# Changelog

Notable changes to the PocketOne Hooks Debugger. There are no version numbers yet, so entries are grouped by date.

## 2026-11-21

### Added

- **Dry run**: a checkbox next to Send, on by default. The route's handler runs inside a database transaction that is always rolled back, so nothing is saved; you still get the response (with an `X-Dbg-Dry: rolled back` header) and the recording. Only for `routerAdd` handlers that aren't `async`; the page says when a request wasn't a dry run. `tests/browsers.mjs` checks it.
- **Saved examples** of requests, above the request runner: Save, pick one to fill in the form, Delete, and **Export** / **Import** as `requests.json`. Kept in the browser (localStorage), never on the server. `tests/browsers.mjs` checks them.

### Fixed

- The request runner sends only to this server: a path like `//other.site/x` used to send the request there, with the superuser token when "as superuser" was ticked. Now every path is checked (typed or imported): only `/…` paths or full addresses on this server; no other sites, no path without `/`, no backslashes, spaces or control characters.
- After a request that wasn't a dry run but failed (e.g. 404), the page no longer says "its changes were saved".
- A hook that runs inside a transaction (e.g. inside `$app.runInTransaction()`) now gets the transaction's `$app` while it's recorded, as without the debugger. Before, it got the app's normal `$app`, and a write through it would wait for the transaction's lock.

## 2026-11-20: first release

The successor of [pb-hooks-debugger](https://github.com/octavonu/pb-hooks-debugger) (v1, for plain PocketBase, now archived; its history is there). It's for [PocketOne](https://github.com/pockethost/pocketone) only, and works differently: nothing is rewritten and nothing pauses on the server.

### Added

- `pb_hooks/00_dbg.pb.js` records each run of a handler (routes, `on*()` hooks, cron jobs) while a debugger tab is open: every answer it gets from Go, in order. **Record for: Only me / Everyone** decides whose requests, as Pause for did.
- The browser replays a recording against those answers, instrumented in memory, and steps through its trace.
- **Step Back** (Shift+F6), **Replay from the start** (Shift+F8), a **Recordings** list, a **Recorded** tab (what Go answered, up to the current step), and "Finished: same as on the server" with the response at the end.
- A hook that runs inside another handler (e.g. `onRecordCreate` inside `$app.save()`) gets its own recording.
- Quick start with the PocketOne release binary (unzip only `pocketone`, it's in `.gitignore`), and a **Tested with** table in the README: PocketOne 0.0.1-alpha.9 (PocketBase 0.42.3), Chrome 157, acorn 8.19.0, Node 24.22.1. The hook files reference `../types.d.ts`, where PocketOne alpha.9 writes the JS types (with a `tsconfig.json`; both are in `.gitignore`).

### Changed

- The UI is a PocketPages folder, `pb_pages/debug/`, with its own superuser sign-in (`/debug/login`). It no longer uses the PocketBase JS SDK or realtime.
- Breakpoints are kept in the browser (localStorage), not in a collection.
- The demo app is now `pb_hooks/main.pb.js` and `pb_hooks/lib/greet.js` with a `notes` collection, instead of the message board.

### Removed

- v1: **Enable debug** / **Disable debug** (rewriting hook files), pausing on the server with `sleep()`, `pb_public/debug/`, `dbg.pb.js`, `_dbg_runtime.js`, `_dbg_server.js`, the `dbg_breakpoints` and `dbg_sessions` collections and their migrations, the message board demo, and `.pockethostconfig`. v1 still works on plain PocketBase and PocketHost, in the archived pb-hooks-debugger repo.

### Changed (later the same day)

- acorn 8.19.0 is included (`pb_pages/debug/_private/acorn.js`, unchanged, with its MIT license in `acorn.LICENSE`) instead of loaded from jsDelivr. The page works offline, and `tests/engine.cjs` uses the same file: no `npm i acorn` or `ACORN=` anymore.
- README **Security**: what the recorder records and where it keeps it, why the replay uses `eval` and `with`, and how to check that `acorn.js` is the original (SHA-256).
- `tests/browsers.mjs`: tests the whole flow in Chrome, Firefox or Safari, with real key presses, using the browser's built-in WebDriver.

### Fixed

- **Shift+F6** (Step Back) and **Shift+F8** (Replay from the start) did nothing in Safari: with Shift, Safari gives function keys the key `"\u0010"`. The page now reads `e.code` for F keys.
- The debugger's code (`replay.js`, `debugger.js`, `debugger.css`) was served to anyone at `/debug/assets/`: PocketPages serves static files without running `+middleware.js`. They are now in `pb_pages/debug/_private/` (never served) and written into the page, so only a signed-in superuser gets them. The login page has its own small style.

### Upgrading

From v1: remove `pb_hooks/dbg.pb.js`, `pb_hooks/_dbg_runtime.js`, `pb_hooks/_dbg_server.js` and `pb_public/debug/`, and delete the `dbg_breakpoints` and `dbg_sessions` collections. Then add `pb_hooks/00_dbg.pb.js` and `pb_pages/debug/` to a PocketOne app.
