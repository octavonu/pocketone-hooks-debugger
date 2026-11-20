# Changelog

Notable changes to the PocketOne Hooks Debugger. There are no version numbers yet, so entries are grouped by date.

## 2026-11-20: first release

The successor of [pb-hooks-debugger](https://github.com/octavonu/pb-hooks-debugger) (v1, for plain PocketBase, now archived; its history is there). It's for [PocketOne](https://github.com/pockethost/pocketone) only, and works differently: nothing is rewritten and nothing pauses on the server.

### Added

- `pb_hooks/00_dbg.pb.js` records each run of a handler (routes, `on*()` hooks, cron jobs) while a debugger tab is open: every answer it gets from Go, in order. **Record for: Only me / Everyone** decides whose requests, as Pause for did.
- The browser replays a recording against those answers, instrumented in memory, and steps through its trace.
- **Step Back** (Shift+F6), **Replay from the start** (Shift+F8), a **Recordings** list, a **Recorded** tab (what Go answered, up to the current step), and "Finished: same as on the server" with the response at the end.
- A hook that runs inside another handler (e.g. `onRecordCreate` inside `$app.save()`) gets its own recording.

### Changed

- The UI is a PocketPages folder, `pb_pages/debug/`, with its own superuser sign-in (`/debug/login`). It no longer uses the PocketBase JS SDK or realtime.
- Breakpoints are kept in the browser (localStorage), not in a collection.
- The demo app is now `pb_hooks/main.pb.js` and `pb_hooks/lib/greet.js` with a `notes` collection, instead of the message board.

### Removed

- v1: **Enable debug** / **Disable debug** (rewriting hook files), pausing on the server with `sleep()`, `pb_public/debug/`, `dbg.pb.js`, `_dbg_runtime.js`, `_dbg_server.js`, the `dbg_breakpoints` and `dbg_sessions` collections and their migrations, the message board demo, and `.pockethostconfig`. v1 still works on plain PocketBase and PocketHost, in the archived pb-hooks-debugger repo.

### Upgrading

From v1: remove `pb_hooks/dbg.pb.js`, `pb_hooks/_dbg_runtime.js`, `pb_hooks/_dbg_server.js` and `pb_public/debug/`, and delete the `dbg_breakpoints` and `dbg_sessions` collections. Then add `pb_hooks/00_dbg.pb.js` and `pb_pages/debug/` to a PocketOne app.
