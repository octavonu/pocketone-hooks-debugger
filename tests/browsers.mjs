// Tests the debugger's whole flow in a real browser, with real key presses (macOS):
//   BROWSER=chrome|firefox|safari EMAIL=<superuser> PASSWORD=<password> node tests/browsers.mjs
// Sign-in, recording (also a hook inside a hook), the breakpoint, F5/F6/F7/F8/Shift+F6/Shift+F8, Evaluate,
// //# sourceURL, and "same as on the server". Nothing to install (Node 24 has fetch and WebSocket):
// - Chrome: its built-in DevTools protocol, headless, with a new empty profile (deleted after; HEADFUL=1 to watch).
//   CHROME=<path> if it isn't in /Applications.
// - Firefox: its built-in WebDriver BiDi, headless, with a new empty profile (deleted after; HEADFUL=1 to watch).
//   FIREFOX=<path> if it isn't in /Applications.
// - Safari: safaridriver, built into macOS. Turn it on once: sudo safaridriver --enable
// Like tests/engine.cjs it only connects to URL (default http://127.0.0.1:8094). It clears the recordings and
// creates a note through POST /api/notes, so use it on the demo app or a test app, not on real data.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const U = process.env.URL || "http://127.0.0.1:8094"
const BROWSER = process.env.BROWSER
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const K = { F5: "\uE035", F6: "\uE036", F7: "\uE037", F8: "\uE038", Shift: "\uE008", Enter: "\uE007" } // WebDriver key codes

/* Drivers: goto(url), run(asyncBody) -> JSON value, keys([...]), close(), version */

async function firefox() {
  const port = 9333
  const profile = mkdtempSync(join(tmpdir(), "dbg-firefox-"))
  const proc = spawn(process.env.FIREFOX || "/Applications/Firefox.app/Contents/MacOS/firefox",
    [process.env.HEADFUL ? "" : "--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", String(port)].filter(Boolean),
    { stdio: "ignore" })
  let ws
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500)
    try {
      ws = await new Promise((ok, bad) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/session`)
        s.onopen = () => ok(s)
        s.onerror = bad
      })
    } catch {}
  }
  if (!ws) throw new Error("Firefox didn't open its WebDriver BiDi port")
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) {
      const { ok, bad } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.type === "error" ? bad(new Error(msg.error + ": " + msg.message)) : ok(msg.result)
    }
  }
  const send = (method, params) => new Promise((ok, bad) => {
    const n = ++id
    waiting.set(n, { ok, bad })
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const session = await send("session.new", { capabilities: {} })
  const context = (await send("browsingContext.getTree", {})).contexts[0].context
  return {
    version: `Firefox ${session.capabilities.browserVersion}`,
    goto: (url) => send("browsingContext.navigate", { context, url, wait: "complete" }),
    async run(body) {
      const expression = `(async () => { ${body} })().then((v) => JSON.stringify(v ?? null), (e) => JSON.stringify({ __error: String(e) }))`
      const r = await send("script.evaluate", { expression, target: { context }, awaitPromise: true })
      if (r.type === "exception") throw new Error(r.exceptionDetails.text)
      return fail(JSON.parse(r.result.value))
    },
    keys: (list) => send("input.performActions", { context, actions: [{ type: "key", id: "kb", actions: keyActions(list) }] }),
    async close() {
      await send("session.end", {}).catch(() => {})
      proc.kill()
      await sleep(1000)
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

async function chrome() {
  const port = 9334
  const profile = mkdtempSync(join(tmpdir(), "dbg-chrome-"))
  const proc = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [process.env.HEADFUL ? "" : "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      "--no-first-run", "--no-default-browser-check", "about:blank"].filter(Boolean),
    { stdio: "ignore" })
  let page, version
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500)
    try {
      version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")
    } catch {}
  }
  if (!page) throw new Error("Chrome didn't open its DevTools port")
  const ws = await new Promise((ok, bad) => {
    const s = new WebSocket(page.webSocketDebuggerUrl)
    s.onopen = () => ok(s)
    s.onerror = bad
  })
  let id = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && waiting.has(msg.id)) {
      const { ok, bad } = waiting.get(msg.id)
      waiting.delete(msg.id)
      msg.error ? bad(new Error(msg.error.message)) : ok(msg.result)
    }
  }
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const n = ++id
    waiting.set(n, { ok, bad })
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  // CDP has no key names: each key needs its key, code and Windows key code
  const named = { F5: [116, "F5"], F6: [117, "F6"], F7: [118, "F7"], F8: [119, "F8"], Enter: [13, "Enter", "\r"] }
  return {
    version: version.replace("/", " "),
    async goto(url) {
      await send("Page.navigate", { url })
      for (let i = 0; i < 100; i++) {
        await sleep(100)
        const ready = await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`).catch(() => false)
        if (ready) return
      }
      throw new Error("page didn't load: " + url)
    },
    async run(body) {
      return fail(JSON.parse(await evaluate(`(async () => { ${body} })().then((v) => JSON.stringify(v ?? null), (e) => JSON.stringify({ __error: String(e) }))`)))
    },
    async keys(list) {
      for (const k of list) {
        const shift = k.startsWith("Shift+")
        const name = shift ? k.slice(6) : k
        const modifiers = shift ? 8 : 0
        if (shift) await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers })
        if (named[name]) {
          const [vk, key, text] = named[name]
          await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: key, windowsVirtualKeyCode: vk, text, modifiers })
          await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, modifiers })
        } else {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, text: name, modifiers })
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, modifiers })
        }
        if (shift) await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 })
      }
    },
    async close() {
      await send("Browser.close").catch(() => {})
      proc.kill()
      await sleep(1000)
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

async function safari() {
  const port = 4445
  const proc = spawn("safaridriver", ["-p", String(port)], { stdio: "inherit" })
  const base = `http://127.0.0.1:${port}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) })
    const json = await res.json()
    if (json.value && json.value.error) throw new Error(json.value.error + ": " + json.value.message)
    return json.value
  }
  let s
  for (let i = 0; i < 20 && !s; i++) {
    await sleep(500)
    try {
      s = await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } })
    } catch (e) {
      if (!/fetch failed|ECONNREFUSED/.test(String(e.cause || e))) throw e
    }
  }
  if (!s) throw new Error("safaridriver didn't start")
  const p = `/session/${s.sessionId}`
  await call("POST", p + "/timeouts", { script: 60000, pageLoad: 30000 })
  return {
    version: `Safari ${s.capabilities.browserVersion}`,
    goto: (url) => call("POST", p + "/url", { url }),
    async run(body) {
      const script = `const done = arguments[arguments.length - 1];
        (async () => { ${body} })().then((v) => done(JSON.stringify(v ?? null)), (e) => done(JSON.stringify({ __error: String(e) })))`
      return fail(JSON.parse(await call("POST", p + "/execute/async", { script, args: [] })))
    },
    keys: (list) => call("POST", p + "/actions", { actions: [{ type: "key", id: "kb", actions: keyActions(list) }] }),
    async close() {
      await call("DELETE", p).catch(() => {})
      proc.kill()
    },
  }
}

// an error inside the page stops the flow (it's reported as a FAIL)
const fail = (v) => { if (v && v.__error) throw new Error("in the page: " + v.__error); return v }

// "Shift+F6" -> shift down, F6 down/up, shift up
function keyActions(list) {
  const out = []
  for (const k of list) {
    const parts = k.length > 1 && k.includes("+") ? k.split("+") : [k]
    const vals = parts.map((p) => K[p] || p)
    for (const v of vals) out.push({ type: "keyDown", value: v })
    for (const v of vals.reverse()) out.push({ type: "keyUp", value: v })
  }
  return out
}

/* The flow */

const results = []
const known = (name) => console.log(`KNOWN ${name}`)
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  ·  " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`)
}

// runs in the page: waits until the debugger is idle, returns where it is
const SNAP = `
  const until = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 50)) } }
  await new Promise((r) => setTimeout(r, 150)); await until(() => !state.busy)
  const top = state.view && (state.view.stack[state.frameSel] || state.view.stack[0])
  const snap = { state: document.getElementById("state").textContent.trim(), cur: state.cur, file: top && top.file, line: top && top.line, depth: state.view ? state.view.stack.length : 0 }
`

const drivers = { chrome, firefox, safari }
if (!drivers[BROWSER]) {
  console.error("Set BROWSER=chrome, BROWSER=firefox or BROWSER=safari")
  process.exit(2)
}
const d = await drivers[BROWSER]()
console.log(`Browser: ${d.version}\n`)
try {
  // 1. sign in through the form: the dbg_auth cookie (SameSite=Strict, path /debug) on 127.0.0.1
  await d.goto(U + "/debug/login")
  await d.run(`
    document.querySelector("input[name=email]").value = ${JSON.stringify(process.env.EMAIL)}
    document.querySelector("input[name=password]").value = ${JSON.stringify(process.env.PASSWORD)}
    setTimeout(() => document.querySelector(".login form").submit(), 0)`)
  await sleep(1500)
  await d.goto(U + "/debug/")
  let r = await d.run(`return { path: location.pathname, acorn: typeof acorn === "object" && acorn.version, replay: typeof DbgReplay, scripts: [...document.scripts].filter((s) => s.src).length, other: performance.getEntriesByType("resource").filter((e) => !e.name.startsWith(location.origin)).map((e) => e.name) }`)
  check("sign in (SameSite=Strict cookie on 127.0.0.1)", r.path === "/debug/", r.path)
  check("inline acorn + replay.js loaded, nothing from other sites", r.acorn === "8.19.0" && r.replay === "object" && r.scripts === 0 && !r.other.length, r)

  // 2. a breakpoint on main.pb.js:6 (greet(name)), then two requests through the page's request runner
  await d.run(`localStorage.setItem("dbg2.breakpoints", JSON.stringify([{ file: "main.pb.js", line: 6 }]))`)
  await d.goto(U + "/debug/")
  r = await d.run(`
    const $ = (id) => document.getElementById(id)
    const until = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 50)) } }
    await until(() => state.files && state.files.length)
    await fetch("/debug/api/recordings", { method: "DELETE" })
    await new Promise((r) => setTimeout(r, 1200)) // a heartbeat, so the server knows this tab
    const send = async (m, p, b) => { $("req-method").value = m; $("req-path").value = p; $("req-body").value = b; $("req-send").click(); await until(() => /^\\d{3} /.test($("req-out").textContent)); const out = $("req-out").textContent; $("req-out").textContent = ""; return out.split("\\n")[0] }
    const a = await send("POST", "/api/notes", '{"text":"  buy milk "}')
    const b = await send("GET", "/api/hello/world", "")
    await until(() => document.querySelectorAll("#recs li").length >= 3)
    return { a, b, recs: [...document.querySelectorAll("#recs li")].map((li) => li.textContent.trim().replace(/\\s+/g, " ").slice(0, 40)) }`)
  check("requests recorded (route, route, nested hook)", r.recs && r.recs.length === 3, r)

  // 3. the hello recording: stops at the breakpoint
  r = await d.run(`
    const li = [...document.querySelectorAll("#recs li")].find((li) => li.textContent.includes("/api/hello"))
    li.querySelector("button").click(); await new Promise((r) => setTimeout(r, 300))
    ${SNAP}; document.activeElement && document.activeElement.blur(); return snap`)
  check("replay stops at the breakpoint main.pb.js:6", r.file === "main.pb.js" && r.line === 6 && /breakpoint/.test(r.state), r)

  const key = async (k) => {
    await d.keys([k])
    return d.run(`${SNAP}; return snap`)
  }
  r = await key("F5")
  check("F5 Step Into -> lib/greet.js", r.file === "lib/greet.js" && r.depth === 2, r)
  const into = r
  r = await key("F6")
  check("F6 Step Over -> next line in greet.js", r.file === "lib/greet.js" && r.line > into.line, r)
  r = await key("Shift+F6")
  check("Shift+F6 Step Back -> previous line", r.file === into.file && r.line === into.line, r)
  r = await key("F7")
  check("F7 Step Out -> back in main.pb.js", r.file === "main.pb.js" && r.depth === 1, r)

  // 4. Evaluate, typed: a value, and new Error().stack for //# sourceURL
  r = await d.run(`
    document.querySelector('.ptab[data-tab="eval"]').click()
    const i = document.getElementById("console-input"); i.focus(); return document.activeElement === i`)
  await d.keys(["n", "a", "m", "e", " ", "+", " ", '"', "!", '"', "Enter"])
  await sleep(800)
  await d.run(`document.getElementById("console-input").value = "new Error('x').stack"; return true`)
  await d.keys(["Enter"])
  await sleep(800)
  r = await d.run(`return document.getElementById("console-out").innerText`)
  check("Evaluate (typed) in the paused frame", /world!/.test(r), r.split("\n").slice(0, 2).join(" | "))
  if (BROWSER === "safari") known("//# sourceURL in stack traces: Safari doesn't use it there (README, Limitations)")
  else check("//# sourceURL names the hook file in stack traces", /pb_hooks\/main\.pb\.js/.test(r), (r.match(/[^\n]*pb_hooks[^\n]*/) || [r.slice(0, 200)])[0])

  // 5. F8 to the end
  await d.run(`document.activeElement && document.activeElement.blur(); return true`)
  r = await key("F8")
  check("F8 Continue -> finished, same as on the server", /same as on the server/.test(r.state), r.state)
  r = await key("Shift+F8")
  check("Shift+F8 Replay from the start -> breakpoint again", r.file === "main.pb.js" && r.line === 6, r)

  // the other two recordings: replay to the end
  for (const what of ["/api/notes", "onRecordCreate"]) {
    r = await d.run(`
      const li = [...document.querySelectorAll("#recs li")].find((li) => li.textContent.includes(${JSON.stringify(what)}))
      li.querySelector("button").click()
      const t0 = Date.now()
      while (!(state.rec && (state.rec.title + " " + (state.rec.path || "")).includes(${JSON.stringify(what)}))) { if (Date.now() - t0 > 15000) throw new Error("recording didn't load"); await new Promise((r) => setTimeout(r, 50)) }
      ${SNAP}; snap.rec = state.rec.title + " " + (state.rec.path || ""); document.activeElement && document.activeElement.blur(); return snap`)
    for (let i = 0; i < 30 && !/Finished/.test(r.state); i++) r = await key("F8")
    check(`replay ${what} -> same as on the server`, /same as on the server/.test(r.state), r.state)
  }

  // 6. dry run: the note is rolled back (same number of notes), and its recording replays the same
  r = await d.run(`
    const $ = (id) => document.getElementById(id)
    const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 50)) } }
    const count = async () => (await (await fetch("/api/collections/notes/records?perPage=1", { headers: { Authorization: DBG.token } })).json()).totalItems
    const before = await count()
    $("req-dry").checked = true
    $("req-method").value = "POST"; $("req-path").value = "/api/notes"; $("req-body").value = '{"text":"dry run note"}'
    $("req-send").click()
    await waitFor(() => /^\\d{3} /.test($("req-out").textContent))
    $("req-dry").checked = false
    await waitFor(() => state.rec && /dry run note/i.test(JSON.stringify(state.rec.log)))
    ${SNAP}
    const after = await count()
    return { out: $("req-out").textContent.split("\\n").slice(0, 2).join(" "), before, after, dry: state.rec.dry === true, state: snap.state }`)
  for (let i = 0; i < 30 && !/Finished/.test(r.state); i++) r = { ...r, state: (await key("F8")).state }
  check("dry run: rolled back, same as on the server", /rolled back/.test(r.out) && r.before === r.after && r.dry && /same as on the server/.test(r.state), r)

  // 7. saved examples: save, kept after a reload, pick fills the form, import skips a path to another site, delete
  await d.run(`
    localStorage.removeItem("dbg2.examples")
    const $ = (id) => document.getElementById(id)
    $("req-method").value = "POST"; $("req-path").value = "/api/notes"; $("req-body").value = '{"text":""}'; $("req-dry").checked = true
    $("ex-save").click(); $("ex-name").value = "empty text gives 400"; $("ex-name-ok").click(); return true`)
  await d.goto(U + "/debug/")
  r = await d.run(`
    const $ = (id) => document.getElementById(id)
    const waitFor = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 50)) } }
    await waitFor(() => $("ex-list").options.length > 1)
    $("req-body").value = ""
    $("ex-list").value = "empty text gives 400"; $("ex-list").dispatchEvent(new Event("change"))
    const picked = { method: $("req-method").value, path: $("req-path").value, body: $("req-body").value, dry: $("req-dry").checked }
    const file = new File([JSON.stringify({ examples: [
      { name: "hello", method: "get", path: "/api/hello/world" },
      { name: "elsewhere", method: "GET", path: "//example.com/x" },
      { name: "empty text gives 400", method: "POST", path: "/api/notes", body: { text: " " } },
    ] })], "requests.json")
    await importExamples(file)
    const names = examples.map((x) => x.name)
    const replaced = examples.find((x) => x.name === "empty text gives 400").body
    $("req-path").value = "//example.com/x"; $("req-send").click()
    await waitFor(() => $("req-out").textContent.length > 0)
    const guard = $("req-out").textContent
    $("ex-list").value = "hello"; $("ex-list").dispatchEvent(new Event("change")); $("ex-delete").click()
    const after = JSON.parse(localStorage.getItem("dbg2.examples")).map((x) => x.name)
    localStorage.removeItem("dbg2.examples")
    return { picked, names, replaced, guard, after }`)
  check("saved examples: save, reload, pick, import, delete",
    r.picked.path === "/api/notes" && r.picked.body === '{"text":""}' && r.picked.dry &&
    r.names.join() === "empty text gives 400,hello" && r.replaced === '{"text":" "}' &&
    /Only this server/.test(r.guard) && r.after.join() === "empty text gives 400", r)

  // 8. the path checker: only paths on this server
  r = await d.run(`
    const ok = ["/api/notes", "/api/hello/w%C3%B6rld?x=1#top", location.origin + "/api/notes"]
    const bad = ["www.google.de/api/notes", "api/notes", "//example.com/x", "https://example.com/api/notes",
      "/\\\\example.com/x", "/\\t/example.com/x", "/api/no tes", "javascript:alert(1)", "data:text/plain,x",
      "http://127.0.0.1:1/x", "", " "]
    return {
      ok: ok.map((p) => [p, checkPath(p).path || checkPath(p).error]),
      wrong: bad.filter((p) => !checkPath(p).error),
    }`)
  check("path checker: only paths on this server", r.ok.every(([, v]) => v.startsWith("/api/")) && !r.wrong.length, r)

  // 9. Suggest examples: without a model, says so; with one, the suggestions are checked before they can be saved
  r = await d.run(`
    const $ = (id) => document.getElementById(id)
    const waitFor = async (f, ms = 30000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout: " + f); await new Promise((r) => setTimeout(r, 50)) } }
    localStorage.removeItem("dbg2.examples"); examples.length = 0; renderExamples()
    $("req-method").value = "POST"; $("req-path").value = "/api/notes"
    $("sg-open").click()
    await waitFor(() => $("sg-info").textContent !== "Loading…")
    const route = $("sg-route").selectedOptions[0] && $("sg-route").selectedOptions[0].textContent
    if (!suggest.status.ready) return { ready: false, route, info: $("sg-info").textContent, ask: $("sg-ask").disabled }
    $("sg-ask").click()
    await waitFor(() => !$("sg-save-row").hidden || /failed|after/.test($("sg-info").textContent), 120000)
    const items = [...$("sg-list").querySelectorAll("li")].map((li) => ({ text: li.textContent, on: li.querySelector("input").checked, off: li.querySelector("input").disabled }))
    const html = $("sg-list").querySelectorAll("img, script").length
    $("sg-save").click()
    const saved = examples.map((x) => ({ name: x.name, path: x.path, dry: x.dry }))
    localStorage.removeItem("dbg2.examples")
    return { ready: true, model: $("sg-model").value, route, items, html, saved }`)
  if (!r.ready) {
    check("suggest examples: no model -> says so, Ask disabled", /No language model/.test(r.info) && r.ask && /POST \/api\/notes/.test(r.route), r)
  } else {
    check("suggest examples: asked, checked, saved", /POST \/api\/notes/.test(r.route) && r.html === 0 && r.saved.length > 0 &&
      r.saved.every((x) => x.path.startsWith("/") && !x.path.startsWith("//") && x.dry), r)
  }
} catch (e) {
  check("no unexpected error", false, String(e))
} finally {
  await d.close()
}
const failed = results.filter((x) => !x.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
