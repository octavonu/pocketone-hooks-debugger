# PocketOne Hooks Debugger

A breakpoint debugger for the JS hooks (`pb_hooks`) of a [PocketOne](https://github.com/pockethost/pocketone) app.
A file tree, tabs, breakpoints on line numbers, a call stack, Variables / Breakpoints / Evaluate and a request
runner, like a debugger in an IDE. But **nothing is rewritten and nothing pauses on the server**: requests are
recorded, and the browser replays them, so you can also step back.

![Paused inside greet() in lib/greet.js after Step Into, with the call stack, the variables and the recordings list](docs/screenshot.jpg)

## How it works

1. **Record.** While a debugger tab is open, `pb_hooks/00_dbg.pb.js` records each run of a handler: every answer
   it gets from Go (`e`, `$app`, `Record`, `$security`, …, `Date.now()`, `Math.random()`), in order.
2. **Replay.** You pick a recording. The browser runs the same hook files against fakes that give back exactly
   those answers, so the handler takes the same path through the code. Nothing reaches the server, so no write
   happens twice.
3. **Step.** The replay is instrumented in the browser, in memory, and gives its trace: every line it ran, with the
   call stack. Continue and Step Into / Over / Out move through the trace, and so does **Step Back**. To show the
   variables at a step, or evaluate an expression there, the replay runs again up to that step. That takes a few
   milliseconds, and the result is the same each time.

## Features

- A file tree with subfolders, editor tabs with syntax highlighting, breakpoints on line numbers, a call stack (click
  a frame to see its variables), the Variables tree (`record`, `auth` and `request` first, secret headers masked),
  Evaluate in the selected frame, and a request runner.
- **Record for: Only me / Everyone.** Only me records only your own requests: from the debugger's browser (a `dbg`
  cookie), with its `X-Dbg` header (for curl or an app on another origin), or from a superuser.
- Idle mode: after 2 minutes without input the tab stops its heartbeats, so nothing is recorded and a hosted
  instance can hibernate.
- **Recordings** list: every handler run while the tab is open (routes, `on*()` hooks, cron jobs), with its file and
  line. A hook that runs inside another handler (e.g. `onRecordCreate` inside `$app.save()`) gets its own recording.
- **Step Back** (Shift+F6) and **Replay from the start** (Shift+F8).
- **Recorded** tab: what Go answered during the run, highlighted up to the current step.
- At the end: **Finished: same as on the server** and the response, or what differs (e.g. the file changed since the
  recording).
- Your hook files are never changed, the hooks never restart, a pause has no time limit, and the debugger needs no
  collections or migrations.

## Quick start

1. Get the `pocketone` binary ([PocketOne](https://github.com/pockethost/pocketone)).
2. From this folder, create a superuser and start the server. `pocketone.yaml` sets the port (8094) and the
   folders:

   ```sh
   pocketone superuser upsert you@example.com your-password
   pocketone serve
   ```

3. Open http://127.0.0.1:8094/debug/ and sign in with the superuser.
4. Open `main.pb.js` and click line 17. In **Send a request**, press **Send**. The request is recorded, and the
   replay stops at the line. F8 Continue · F5 Into · F6 Over · F7 Out · Shift+F6 Back · Shift+F8 Replay.

The demo app has `GET /api/hello/{name}` (with a helper in `lib/greet.js`), `POST /api/notes` (writes a record), and
`GET /api/notes/summary`, plus an `onRecordCreate` hook for `notes`.

### Adding it to an existing PocketOne app

You only need:

- `pb_hooks/00_dbg.pb.js`: the recorder. It must load before your other hook files (they load in name order), since
  it wraps the functions they register their handlers with.
- `pb_pages/debug/`: the debugger, served by PocketOne's PocketPages at `/debug/`. It needs nothing from your own
  `pb_pages` (no `+config.js`, auth plugin or layout changes): it signs superusers in with its own cookie
  (`dbg_auth`, HttpOnly, path `/debug`).

Remove both again to turn the debugger off completely.

## Files

| Path | What |
|---|---|
| `pb_hooks/00_dbg.pb.js` | The recorder. Wraps `routerAdd`, `cronAdd` and every `on*()`. Records only while a debugger tab sends heartbeats; with **Only me**, only requests with the tab's `dbg` cookie or `X-Dbg` header, or from a superuser. Keeps the last 50 recordings in memory. Exposes them to the pages as `globalThis.__dbg` (pages run in the same JS VM). |
| `pb_pages/debug/+middleware.js` | Superusers only (the `dbg_auth` cookie or an `Authorization` header), no layouts, `no-store`. |
| `pb_pages/debug/login/`, `logout/` | Sign in and out. |
| `pb_pages/debug/index.ejs` | The page. |
| `pb_pages/debug/api/files`, `recordings`, `presence` | JSON for the page: the hook files with their sources, the recordings, the heartbeat. |
| `pb_pages/debug/assets/replay.js` | The replay engine: the fakes, the instrumentation (acorn), the tracer, and the inspector for variables and Evaluate. |
| `pb_pages/debug/assets/debugger.js`, `debugger.css` | The UI. |
| `tests/engine.cjs` | Replays every recording of a running app in Node: `npm i acorn` somewhere, then `EMAIL=… PASSWORD=… ACORN=<path to acorn> node tests/engine.cjs`. |
| `pb_hooks/main.pb.js`, `pb_hooks/lib/greet.js`, `pb_migrations/` | The demo app. |

## Limitations

- **PocketOne only.** The recorder relies on all hooks and pages sharing one JS VM, and the UI on PocketPages. For
  plain PocketBase (and PocketHost today) see [the earlier version](#earlier-version-plain-pocketbase).
- **CommonJS `.js` hook files only** for now (not `.pb.mjs` or `.pb.ts`). The replay runs in the browser's JS engine,
  not QuickJS. That rarely matters for hook code.
- **Go objects show a snapshot** taken when the handler first got them, e.g. a record before its `set()` calls.
- **Evaluate** runs in the browser. A Go method the handler called gives its recorded answer, which may be from later
  in the run (e.g. `record.get("text")` before `$app.save()` shows the value after the save hooks). Properties the
  handler never read come from the snapshot. Methods it never called aren't available.
- **Not recorded yet:** middlewares (`routerUse` and a route's own middlewares), and `new Date()` without arguments.
- **Async handlers:** other requests can run during an `await` and see the recorder's wrapped globals, so they may
  be recorded into the wrong run.
- **Recordings live in memory**: a restart or a hooks reload (e.g. after you edit a hook file) clears them.
- Arrow functions with an expression body (`(e) => e.json(...)`) have no line to stop on.

## Security

The debugger is for superusers only. Recordings can contain request data (headers, bodies, records), so they are
kept only in memory, only while a debugger tab is open, and only shown to superusers. Secret headers are masked in
the views but stay in the recording, because the replay needs the same values. Don't leave `00_dbg.pb.js` and
`pb_pages/debug/` on a production app you aren't debugging.

## Earlier version (plain PocketBase)

This project started as [pb-hooks-debugger](https://github.com/octavonu/pb-hooks-debugger) (now archived), which runs
on any PocketBase with JS hooks, including PocketHost. It puts probes into your hook files (**Enable debug**) and
pauses the real request on the server with `sleep()`.

## License

[MIT](LICENSE)
