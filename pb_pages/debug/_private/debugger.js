// Hooks Debugger v2: the page. The file tree, tabs, code view, variables tree, call stack, request runner, splitters
// and idle mode come from v1. What's new: nothing runs or pauses on the server. You pick a recording (made by
// pb_hooks/00_dbg.pb.js while this tab is open) and the browser replays it (_private/replay.js): stepping moves through
// the replay's trace, so you can also step back, and the variables and Evaluate come from replaying up to that step.
"use strict"

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1)

const state = {
  files: [], // { name, source, readonly, replay }
  globals: [],
  file: null, // { name, source, readonly, replay }
  analysis: null, // { probes, classes }
  analyses: new Map(),
  tabs: [],
  collapsed: new Set(),
  expanded: new Set(),
  breakpoints: [], // { file, line }, kept in this browser
  recs: [], // the list (summaries)
  latest: 0,
  rec: null, // the recording being replayed (with its log)
  trace: null, // the first replay: { steps, response, error, same, misses, unused, used }
  cur: 0, // the step shown (1-based); trace.steps.length + 1 = finished
  view: null, // what the replay saw at `cur`: { stack, locals, used }
  frameSel: 0,
  busy: false,
}

let toastTimer
function toast(msg, ms = 3500) {
  $("toast").textContent = msg
  $("toast").hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => ($("toast").hidden = true), ms)
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (res.status === 401) {
    location.href = "/debug/login"
    throw new Error("signed out")
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`)
  return data
}

/* ------------------------------------------------------------------ */
/* Record for: Only me / Everyone (heartbeats, as v1's presence)        */
/* ------------------------------------------------------------------ */

const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36)
const TOKEN = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
const HEARTBEAT_MS = 5000
let heartbeatTimer = null
let recordFor = "me"

function setRecordFor(value) {
  recordFor = value === "all" ? "all" : "me"
  $("pause-for").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === recordFor)))
}

function setTokenCookie() {
  const secure = location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `dbg=${TOKEN}; path=/; SameSite=Lax${secure}`
}

function clearTokenCookie() {
  if (document.cookie.split("; ").includes(`dbg=${TOKEN}`)) document.cookie = "dbg=; path=/; max-age=0"
}

async function heartbeat() {
  setTokenCookie()
  try {
    const r = await api("/debug/api/presence", { method: "POST", body: { tab: TAB_ID, token: TOKEN, all: recordFor === "all" } })
    setConn(true)
    if (r.latest !== state.latest) await loadRecs()
  } catch {
    setConn(false)
  }
}

function startHeartbeat() {
  clearInterval(heartbeatTimer)
  heartbeat()
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (!heartbeatTimer) return
  clearInterval(heartbeatTimer)
  heartbeatTimer = null
  clearTokenCookie()
  try {
    fetch("/debug/api/presence", {
      method: "POST", keepalive: true, credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tab: TAB_ID, bye: true }),
    })
  } catch {}
}

window.addEventListener("pagehide", stopHeartbeat)
window.addEventListener("pageshow", (e) => {
  if (e.persisted && !idle) startHeartbeat()
})

function setConn(on) {
  $("conn-dot").classList.toggle("on", on)
  $("conn-text").textContent = on ? "recording" : idle ? "idle" : "reconnecting…"
}

/* ------------------------------------------------------------------ */
/* Breakpoints (in this browser)                                       */
/* ------------------------------------------------------------------ */

const BP_KEY = "dbg2.breakpoints"
try {
  state.breakpoints = JSON.parse(localStorage.getItem(BP_KEY) || "[]")
} catch {}
const saveBreakpoints = () => {
  try {
    localStorage.setItem(BP_KEY, JSON.stringify(state.breakpoints))
  } catch {}
}
const isBreakpoint = (file, line) => state.breakpoints.some((b) => b.file === file && b.line === line)

function toggleBreakpoint(line) {
  if (!state.file || !state.analysis.probes.has(line)) return
  if (isBreakpoint(state.file.name, line)) state.breakpoints = state.breakpoints.filter((b) => !(b.file === state.file.name && b.line === line))
  else state.breakpoints.push({ file: state.file.name, line })
  saveBreakpoints()
  renderCode()
  renderBreakpoints()
}

function removeBreakpoint(bp) {
  state.breakpoints = state.breakpoints.filter((b) => !(b.file === bp.file && b.line === bp.line))
  saveBreakpoints()
  renderBreakpoints()
  if (state.file) renderCode()
}

/* ------------------------------------------------------------------ */
/* Syntax highlighting (acorn tokenizer), as v1                        */
/* ------------------------------------------------------------------ */

function tokenClasses(src) {
  const ranges = []
  const tt = acorn.tokTypes
  try {
    const tokenizer = acorn.tokenizer(src, {
      ecmaVersion: "latest", allowReturnOutsideFunction: true, allowHashBang: true,
      onComment: (block, text, start, end) => ranges.push([start, end, "t-com"]),
    })
    for (const tok of tokenizer) {
      let cls = null
      if (tok.type.keyword) cls = "t-kw"
      else if (tok.type === tt.string || tok.type === tt.template) cls = "t-str"
      else if (tok.type === tt.num) cls = "t-num"
      else if (tok.type === tt.regexp) cls = "t-re"
      if (cls) ranges.push([tok.start, tok.end, cls])
    }
  } catch {}
  return ranges.sort((a, b) => a[0] - b[0])
}

function analysisOf(file) {
  if (!state.analyses.has(file.name)) {
    let probes = new Map()
    try {
      if (file.replay && !file.readonly) probes = DbgReplay.analyze(file.source).probes
    } catch {}
    state.analyses.set(file.name, { probes, classes: tokenClasses(file.source) })
  }
  return state.analyses.get(file.name)
}

/* ------------------------------------------------------------------ */
/* Files: tree, tabs, code (as v1)                                     */
/* ------------------------------------------------------------------ */

const LOCK_ICON = '<svg class="lock" viewBox="0 0 16 16" fill="currentColor" aria-label="read-only"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1.6 0h3.8V5a1.9 1.9 0 0 0-3.8 0z"/></svg>'
const DIR_ICON = '<svg class="ico dir" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>'
const FILE_ICON = '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>'

function buildTree(files) {
  const root = { dirs: new Map(), files: [] }
  files.forEach((f) => {
    let node = root
    f.name.split("/").slice(0, -1).forEach((part) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    })
    node.files.push(f)
  })
  return root
}

function renderTreeNode(ul, node, prefix) {
  ;[...node.dirs.keys()].sort((a, b) => a.localeCompare(b)).forEach((dir) => {
    const path = prefix + dir
    const open = !state.collapsed.has(path)
    const li = document.createElement("li")
    const btn = document.createElement("button")
    btn.className = "folder"
    btn.title = path
    btn.setAttribute("aria-expanded", open)
    btn.innerHTML = `<span class="tw">${open ? "▾" : "▸"}</span>${DIR_ICON}<span class="fname">${esc(dir)}</span>`
    btn.addEventListener("click", () => {
      if (open) state.collapsed.add(path)
      else state.collapsed.delete(path)
      renderFiles()
    })
    const sub = document.createElement("ul")
    sub.className = "files"
    sub.hidden = !open
    renderTreeNode(sub, node.dirs.get(dir), path + "/")
    li.append(btn, sub)
    ul.append(li)
  })
  node.files.forEach((f) => {
    const li = document.createElement("li")
    const btn = document.createElement("button")
    btn.className = [state.file && state.file.name === f.name && "active", f.readonly && "ro"].filter(Boolean).join(" ")
    btn.title = f.readonly ? `${f.name} (read-only: part of the debugger)` : f.replay ? f.name : `${f.name} (can't be replayed yet: only CommonJS .js files)`
    btn.innerHTML = `${FILE_ICON}<span class="fname">${esc(baseName(f.name))}</span>${f.readonly ? LOCK_ICON : ""}`
    btn.addEventListener("click", () => openFile(f.name))
    li.append(btn)
    ul.append(li)
  })
}

function renderFiles() {
  $("files").innerHTML = ""
  renderTreeNode($("files"), buildTree(state.files), "")
  if (!state.files.length) $("files").innerHTML = '<li class="muted pad">No files.</li>'
  renderTabs()
}

function topFrame() {
  return state.view && state.view.stack[0]
}

function renderTabs() {
  const bar = $("tabs")
  bar.innerHTML = ""
  bar.hidden = !state.tabs.length
  const paused = topFrame()
  state.tabs.forEach((name) => {
    const f = state.files.find((x) => x.name === name)
    const tab = document.createElement("div")
    tab.className = ["tab", state.file?.name === name && "active", paused?.file === name && "paused"].filter(Boolean).join(" ")
    tab.title = name
    tab.innerHTML = `${f?.readonly ? LOCK_ICON : ""}<span>${esc(baseName(name))}</span><button class="tx" title="Close" aria-label="Close ${esc(name)}">×</button>`
    tab.addEventListener("click", (e) => {
      if (e.target.closest(".tx")) closeTab(name)
      else if (state.file?.name !== name) openFile(name)
    })
    bar.append(tab)
  })
}

function closeTab(name) {
  const i = state.tabs.indexOf(name)
  if (i === -1) return
  state.tabs.splice(i, 1)
  if (state.file?.name === name) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)]
    if (next) return openFile(next)
    state.file = null
    state.analysis = null
    $("toolbar").hidden = true
    $("code").innerHTML = '<p class="empty-state">Pick a file on the left.</p>'
    renderFiles()
    return
  }
  renderTabs()
}

function openFile(name, line) {
  const file = state.files.find((f) => f.name === name)
  if (!file) return toast(`No file ${name}`)
  state.file = file
  state.analysis = analysisOf(file)
  if (!state.tabs.includes(name)) state.tabs.push(name)
  renderFiles()
  renderCode()
  if (line) scrollToLine(line)
}

function renderCode() {
  const code = $("code")
  if (!state.file) return
  const { source } = state.file
  const { probes, classes } = state.analysis
  const bpLines = new Set(state.breakpoints.filter((b) => b.file === state.file.name).map((b) => b.line))
  const stack = state.view ? state.view.stack : []
  const top = stack[0]
  const sel = state.frameSel > 0 ? stack[state.frameSel] : null
  const pausedLine = top && top.file === state.file.name ? top.line : null
  const frameLine = sel && sel.file === state.file.name ? sel.line : null

  const lines = source.split("\n")
  let pos = 0, ri = 0
  const html = lines.map((text, i) => {
    const lineStart = pos, lineEnd = pos + text.length
    pos = lineEnd + 1
    let out = "", cur = lineStart
    while (ri < classes.length && classes[ri][1] <= lineStart) ri++
    for (let j = ri; j < classes.length && classes[j][0] < lineEnd; j++) {
      const [s, e, cls] = classes[j]
      const a = Math.max(s, lineStart), b = Math.min(e, lineEnd)
      if (a < cur) continue
      out += esc(source.slice(cur, a)) + `<span class="${cls}">${esc(source.slice(a, b))}</span>`
      cur = b
    }
    out += esc(source.slice(cur, lineEnd))
    const n = i + 1
    const cls = ["ln", probes.has(n) && "can", bpLines.has(n) && "bp", pausedLine === n && "paused", frameLine === n && "frame"].filter(Boolean).join(" ")
    return `<div class="${cls}" data-line="${n}"><span class="gut">${n}</span><span class="src">${out || " "}</span></div>`
  })
  code.innerHTML = html.join("")

  $("toolbar").hidden = false
  $("file-name").textContent = state.file.name
  $("file-hint").textContent = state.file.readonly
    ? "Read-only: this file is part of the debugger."
    : !state.file.replay
      ? "Can't be replayed yet (only CommonJS .js files)."
      : probes.size
        ? "Click a line number to toggle a breakpoint. Nothing changes on the server."
        : "No code inside functions (handlers) to put breakpoints on."
}

function scrollToLine(line) {
  const el = document.querySelector(`.ln[data-line="${line}"]`)
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" })
}

function renderBreakpoints() {
  const list = $("bplist")
  list.innerHTML = ""
  $("bp-count").textContent = state.breakpoints.length ? `(${state.breakpoints.length})` : ""
  if (!state.breakpoints.length) {
    list.innerHTML = '<li class="muted">None. Click a line number.</li>'
    return
  }
  ;[...state.breakpoints]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .forEach((bp) => {
      const li = document.createElement("li")
      li.innerHTML = `<span style="color:var(--bp)">●</span><a>${esc(bp.file)}:${bp.line}</a><button class="x" title="Remove">✕</button>`
      li.querySelector("a").addEventListener("click", () => openFile(bp.file, bp.line))
      li.querySelector(".x").addEventListener("click", () => removeBreakpoint(bp))
      list.append(li)
    })
}

/* ------------------------------------------------------------------ */
/* Variables (tree table, as v1)                                       */
/* ------------------------------------------------------------------ */

const plainType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)
const EVENT_KEYS = ["record", "collection", "auth", "request", "requestEvent"]

function eventOrder(entries) {
  const keys = entries.map(([k]) => k)
  if (!keys.includes("request") && !keys.includes("requestEvent") && !keys.includes("record")) return entries
  const rank = (k) => (EVENT_KEYS.includes(k) ? EVENT_KEYS.indexOf(k) : EVENT_KEYS.length)
  return [...entries].sort((a, b) => rank(a[0]) - rank(b[0]))
}

function previewOf(value, type) {
  if (value === null) return "null"
  if (Array.isArray(value)) return `Array(${value.length})`
  if (typeof value === "object") {
    const keys = eventOrder(Object.entries(value)).map(([k]) => k)
    return "{" + keys.slice(0, 5).join(", ") + (keys.length > 5 ? ", …" : "") + "}"
  }
  if (typeof value === "string" && type === "string" && !/^[‹ƒ]/.test(value)) return JSON.stringify(value)
  return String(value)
}

function renderVarRows(container, entries, depth, prefix) {
  entries.forEach(([name, value, type]) => {
    const path = prefix + "/" + name
    const complex = value !== null && typeof value === "object" && Object.keys(value).length > 0
    const open = complex && state.expanded.has(path)
    const row = document.createElement("div")
    row.className = ["vt-row", complex && "can", type === "error" && "err"].filter(Boolean).join(" ")
    row.style.setProperty("--d", depth)
    if (complex) row.dataset.path = path
    const preview = previewOf(value, type)
    row.innerHTML = `<span class="vt-name"><span class="tw">${complex ? (open ? "▾" : "▸") : ""}</span>${esc(name)}</span><span class="vt-val"></span><span class="vt-ty"></span>`
    row.querySelector(".vt-val").textContent = preview
    row.querySelector(".vt-val").title = preview
    row.querySelector(".vt-ty").textContent = type
    row.querySelector(".vt-ty").title = /^[*\[]|map\[/.test(type) ? `${type}: a Go value, as recorded when the handler first got it` : type
    container.append(row)
    if (open) {
      const children = Array.isArray(value)
        ? value.map((v, i) => [String(i), v, plainType(v)])
        : eventOrder(Object.entries(value)).map(([k, v]) => [k, v, plainType(v)])
      renderVarRows(container, children, depth + 1, path)
    }
  })
}

function renderVars() {
  const vars = $("vars")
  if (!state.view) {
    vars.innerHTML = `<p class="muted pad">${state.trace ? "The replay has finished." : "Shown while a replay is paused."}</p>`
    return
  }
  const entries = Object.entries(state.view.locals || {}).map(([k, v]) => [k, v.value, v.type])
  if (!entries.length) {
    vars.innerHTML = '<p class="muted pad">No local variables in scope.</p>'
    return
  }
  const scroll = $("pane-vars").scrollTop
  vars.innerHTML = '<div class="vt-head"><span>Name</span><span>Value</span><span>Type</span></div>'
  renderVarRows(vars, entries, 0, "")
  $("pane-vars").scrollTop = scroll
}

function renderValue(v) {
  const wrap = document.createElement("details")
  wrap.className = "var"
  const isComplex = v.value !== null && typeof v.value === "object"
  const preview = isComplex ? JSON.stringify(v.value) : previewOf(v.value, v.type)
  wrap.innerHTML = `<summary><span class="ty">${esc(v.type)}</span> ${esc(preview.length > 120 ? preview.slice(0, 120) + "…" : preview)}</summary>`
  if (isComplex || preview.length > 120) {
    const pre = document.createElement("pre")
    pre.textContent = isComplex ? JSON.stringify(v.value, null, 2) : preview
    wrap.append(pre)
  } else {
    wrap.classList.add("leaf")
  }
  return wrap
}

/* ------------------------------------------------------------------ */
/* Recordings                                                          */
/* ------------------------------------------------------------------ */

async function loadRecs() {
  try {
    state.recs = await api("/debug/api/recordings")
  } catch {
    return
  }
  state.latest = state.recs.length ? state.recs[0].id : 0
  renderRecs()
}

function renderRecs() {
  const ul = $("recs")
  if (!state.recs.length) {
    ul.innerHTML = `<li class="muted pad" style="font-size: .85rem">None yet. Send a request below (or with the dbg cookie / X-Dbg header), or switch to Everyone.</li>`
    return
  }
  ul.innerHTML = state.recs
    .map((r) => {
      const t = new Date(r.at)
      return `<li><button data-id="${r.id}" class="${state.rec && state.rec.id === r.id ? "active" : ""}" title="${esc(r.key)}${r.where ? " · " + esc(r.where.file) + ":" + r.where.line : ""}">
        <span class="rt"><span class="kind">${esc(r.kind)}</span><b>${esc(r.title)}</b>${r.path ? " " + esc(r.path) : ""}</span>
        <span class="rs">#${r.id} · ${t.toLocaleTimeString()} · ${r.ms ?? "?"} ms · ${r.answers} answers${r.dry ? ' · <span class="dry">dry run</span>' : ""}${r.error ? ' · <span class="bad">error</span>' : ""}</span>
      </button></li>`
    })
    .join("")
  ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => selectRec(Number(b.dataset.id))))
}

const replayFiles = () => Object.fromEntries(state.files.filter((f) => f.replay && !f.readonly).map((f) => [f.name, f.source]))

async function selectRec(id) {
  try {
    state.rec = await api("/debug/api/recordings?id=" + id)
  } catch (err) {
    toast(err.message)
    return loadRecs()
  }
  $("console-out").innerHTML = ""
  renderRecs()
  await replay()
}

// The first replay: the whole run with its trace. Then go to the first breakpoint (or the first line).
async function replay() {
  if (!state.rec) return
  state.busy = true
  state.view = null
  try {
    state.trace = await DbgReplay.run(replayFiles(), state.rec, { globals: state.globals, trace: true })
  } catch (err) {
    state.trace = { steps: [], error: String(err), same: false, misses: [], unused: [], used: [], response: [] }
  }
  state.busy = false
  const steps = state.trace.steps
  const first = steps.findIndex((s) => isBreakpoint(s.file, s.line))
  if (!steps.length) return finish()
  await goTo(first === -1 ? 1 : first + 1)
}

// Show step i: replay up to it, look at the variables of the selected frame.
async function goTo(i, frame = 0) {
  const steps = state.trace.steps
  if (i < 1 || i > steps.length) return finish()
  state.cur = i
  state.frameSel = frame
  state.view = (await DbgReplay.run(replayFiles(), state.rec, { globals: state.globals, stopAt: i, frame })).inspect
  const f = state.view.stack[state.frameSel] || state.view.stack[0]
  if (!state.file || state.file.name !== f.file) openFile(f.file)
  else renderCode()
  renderSession()
  scrollToLine(f.line)
}

function finish() {
  state.cur = state.trace ? state.trace.steps.length + 1 : 0
  state.view = null
  state.frameSel = 0
  if (state.file) renderCode()
  renderSession()
}

const step = () => state.trace && state.trace.steps[state.cur - 1]

function next(pred) {
  const steps = state.trace.steps
  for (let j = state.cur; j < steps.length; j++) if (pred(steps[j])) return goTo(j + 1)
  return finish()
}

const cmd = {
  continue: () => next((s) => isBreakpoint(s.file, s.line)),
  into: () => goTo(state.cur + 1),
  over: () => {
    const d = step().depth
    return next((s) => s.depth <= d)
  },
  out: () => {
    const d = step().depth
    return next((s) => s.depth < d)
  },
  back: () => {
    const steps = state.trace.steps
    const at = state.cur > steps.length ? steps.length + 1 : state.cur
    const d = at > steps.length ? Infinity : steps[at - 1].depth
    for (let j = at - 2; j >= 0; j--) if (steps[j].depth <= d) return goTo(j + 1)
  },
}

async function run(name) {
  if (state.busy || !state.trace) return
  state.busy = true
  try {
    await cmd[name]()
  } catch (err) {
    toast(String(err))
  }
  state.busy = false
}

function renderSession() {
  const t = state.trace
  const paused = !!state.view
  const steps = t ? t.steps.length : 0
  const done = !!t && !paused
  $("btn-restart").disabled = !state.rec
  $("btn-continue").disabled = !paused
  $("btn-into").disabled = !paused
  $("btn-step").disabled = !paused
  $("btn-out").disabled = !paused || state.view.stack.length < 2
  $("btn-back").disabled = !t || state.cur <= 1
  $("btn-eval").disabled = !paused
  $("console-input").disabled = !paused

  const s = step()
  const st = $("state")
  if (!t) {
    st.textContent = "No recording"
    st.className = "state"
  } else if (paused) {
    st.innerHTML = `⏸ ${isBreakpoint(s.file, s.line) ? "Paused at breakpoint" : "Paused"} <span class="step">· step ${state.cur} of ${steps}</span>`
    st.className = "state paused"
  } else {
    st.innerHTML = t.same ? `✓ Finished: same as on the server <span class="step">· ${steps} steps</span>` : `✗ Finished: differs from the server <span class="step">· ${steps} steps</span>`
    st.className = "state " + (t.same ? "done" : "bad")
  }
  renderTabs()
  renderVars()
  renderLog()

  $("where").hidden = paused
  $("stack").hidden = !paused
  $("result").hidden = !done
  if (!t) {
    $("where").textContent = "Pick a recording on the left, or send a request below."
    return
  }
  if (paused) renderStack()
  else {
    $("where").textContent = `${state.rec.title}${state.rec.path ? " " + state.rec.path : ""}`
    renderResult()
  }
}

function renderResult() {
  const t = state.trace
  const parts = []
  if (t.response.length) parts.push(`<div><span class="muted">Response:</span> ${esc(t.response.join(" "))}</div>`)
  if (t.error) parts.push(`<div class="e">${esc(t.error)}${t.sameError ? ' <span class="muted">(the same on the server)</span>' : ""}</div>`)
  if (state.rec.error && !t.error) parts.push(`<div class="e">On the server: ${esc(state.rec.error)}</div>`)
  if (t.misses.length) parts.push(`<div class="e">Asked for something the server never answered (has the file changed since?): ${esc(t.misses[0])}</div>`)
  else if (t.unused.length) parts.push(`<div class="muted">${t.unused.length} recorded answer(s) not asked for (has the file changed since?)</div>`)
  $("result").innerHTML = parts.join("")
}

function renderStack() {
  const list = $("stack")
  list.innerHTML = ""
  state.view.stack.forEach((f, i) => {
    const li = document.createElement("li")
    li.className = i === state.frameSel ? "sel" : ""
    li.title = `${f.ctx} — ${f.file}:${f.line}`
    li.innerHTML = `<span class="mark">${i === 0 ? "▶" : ""}</span><span class="fn">${esc(f.ctx)}</span><span class="loc">${esc(baseName(f.file))}:${f.line}</span>`
    li.addEventListener("click", () => selectFrame(i))
    list.append(li)
  })
}

async function selectFrame(i) {
  if (!state.view || state.busy) return
  state.busy = true
  await goTo(state.cur, i)
  state.busy = false
}

const SECRET = /authorization|cookie|x-dbg/i
function renderLog() {
  const ol = $("log")
  if (!state.rec) {
    ol.innerHTML = '<li class="muted">Pick a recording.</li>'
    $("log-count").textContent = ""
    return
  }
  const used = new Set(state.view ? state.view.used : state.trace ? state.trace.used : [])
  $("log-count").textContent = `(${state.rec.log.length})`
  ol.innerHTML = state.rec.log
    .map((x, i) => {
      let a = x.err ? "throws " + x.err : x.go ? "‹" + x.go + "›" : x.ref ? "→ " + x.ref : x.u ? "undefined" : JSON.stringify(x.v)
      if (SECRET.test(x.k) && a.length > 16) a = a.slice(0, 16) + "… (masked)"
      return `<li class="${used.has(i) ? "used" : ""}"><span class="n">${i + 1}</span><span class="k">${esc(x.k)}</span><span class="a">${esc(a)}</span></li>`
    })
    .join("")
}

/* ------------------------------------------------------------------ */
/* Evaluate                                                            */
/* ------------------------------------------------------------------ */

function consoleLine(html) {
  const out = $("console-out")
  const div = document.createElement("div")
  div.innerHTML = html
  out.append(div)
  out.scrollTop = out.scrollHeight
  return div
}

async function evaluate(expr) {
  if (!state.view || !expr.trim()) return
  consoleLine(`<div class="q">${esc(expr)}</div>`)
  const slot = consoleLine('<span class="muted">…</span>')
  const res = await DbgReplay.run(replayFiles(), state.rec, { globals: state.globals, stopAt: state.cur, frame: state.frameSel, exprs: [expr] })
  const v = res.inspect.evals[0]
  slot.innerHTML = ""
  if (v.type === "error") slot.innerHTML = `<span class="e">${esc(v.value)}</span>`
  else slot.append(renderValue(v))
}

/* ------------------------------------------------------------------ */
/* Request runner (as v1)                                              */
/* ------------------------------------------------------------------ */

async function sendRequest() {
  const method = $("req-method").value
  const path = $("req-path").value.trim()
  const body = $("req-body").value.trim()
  const out = $("req-out")
  out.innerHTML = '<span class="muted">sending…</span>'
  // only this server: a path like //other.site would send the superuser token there
  const url = new URL(path, location.origin)
  if (url.origin !== location.origin) {
    out.innerHTML = '<span class="e">Only paths on this server, like /api/notes.</span>'
    return
  }
  const headers = {}
  if (body && method !== "GET") headers["Content-Type"] = "application/json"
  if ($("req-auth").checked) headers.Authorization = DBG.token
  const dry = $("req-dry").checked
  if (dry) headers["X-Dbg-Dry"] = TOKEN
  setTokenCookie()
  const before = state.latest
  const t0 = performance.now()
  try {
    const res = await fetch(url, { method, headers, body: method === "GET" || !body ? undefined : body })
    const text = await res.text()
    let pretty = text
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2)
    } catch {}
    out.innerHTML = `<div class="muted">${res.status} ${esc(res.statusText)} · ${Math.round(performance.now() - t0)} ms</div>`
    const dryAnswer = res.headers.get("X-Dbg-Dry")
    if (dryAnswer === "rolled back") {
      out.insertAdjacentHTML("beforeend", `<div class="dry">Dry run: rolled back, nothing was saved.</div>`)
    } else if (dryAnswer) {
      out.insertAdjacentHTML("beforeend", `<div class="bad">Dry run ${esc(dryAnswer)}.</div>`)
    } else if (dry && method !== "GET") {
      out.insertAdjacentHTML("beforeend", `<div class="bad">Not a dry run: no routerAdd handler answered (a built-in route?), so its changes were saved.</div>`)
    }
    const pre = document.createElement("pre")
    pre.textContent = pretty.length > 5000 ? pretty.slice(0, 5000) + "…" : pretty
    out.append(pre)
  } catch (err) {
    out.innerHTML = `<span class="e">${esc(err.message)}</span>`
    return
  }
  await loadRecs()
  // replay what this request recorded: the newest recording (an outer handler finishes after the hooks inside it)
  if (state.latest !== before && state.recs[0]) await selectRec(state.recs[0].id)
  else toast("Nothing was recorded: no handler ran for this request.")
}

/* ------------------------------------------------------------------ */
/* Saved examples: in this browser (localStorage), Export / Import     */
/* ------------------------------------------------------------------ */

const EX_KEY = "dbg2.examples"
const EX_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
let examples = []
try {
  examples = (JSON.parse(localStorage.getItem(EX_KEY) || "[]") || []).map(cleanExample).filter(Boolean)
} catch {}

// A valid example, or null. Also checks imported files: a path must be on this server.
function cleanExample(x) {
  if (!x || typeof x !== "object") return null
  const name = String(x.name ?? "").trim().slice(0, 120)
  const method = String(x.method ?? "GET").toUpperCase()
  const path = String(x.path ?? "")
  if (!name || !EX_METHODS.includes(method) || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null
  const body = x.body == null ? "" : typeof x.body === "string" ? x.body : JSON.stringify(x.body)
  return { name, method, path, body, superuser: x.superuser === true, dry: x.dry !== false }
}

function saveExamples() {
  try {
    localStorage.setItem(EX_KEY, JSON.stringify(examples))
  } catch {
    toast("Couldn't save in this browser (localStorage is full or blocked).")
  }
}

function renderExamples(selected = "") {
  const sel = $("ex-list")
  sel.innerHTML = ""
  const first = new Option(examples.length ? `Examples (${examples.length})…` : "No examples yet", "")
  sel.append(first)
  for (const x of examples) sel.append(new Option(`${x.name}  ·  ${x.method} ${x.path}`, x.name))
  sel.value = examples.some((x) => x.name === selected) ? selected : ""
  $("ex-delete").disabled = !sel.value
}

function pickExample(name) {
  const x = examples.find((x) => x.name === name)
  $("ex-delete").disabled = !x
  if (!x) return
  $("req-method").value = x.method
  $("req-path").value = x.path
  $("req-body").value = x.body
  $("req-auth").checked = x.superuser
  $("req-dry").checked = x.dry
}

function showNameRow(show) {
  $("ex-name-row").hidden = !show
  if (!show) return
  const input = $("ex-name")
  input.value = $("ex-list").value || `${$("req-method").value} ${$("req-path").value.trim()}`
  input.focus()
  input.select()
}

function saveExample() {
  const x = cleanExample({
    name: $("ex-name").value, method: $("req-method").value, path: $("req-path").value.trim(),
    body: $("req-body").value, superuser: $("req-auth").checked, dry: $("req-dry").checked,
  })
  if (!x) return toast("Give it a name, and a path that starts with /.")
  const i = examples.findIndex((e) => e.name === x.name)
  if (i >= 0) examples[i] = x
  else examples.push(x)
  saveExamples()
  renderExamples(x.name)
  showNameRow(false)
  toast(`${i >= 0 ? "Updated" : "Saved"} "${x.name}" in this browser.`)
}

function deleteExample() {
  const name = $("ex-list").value
  if (!name) return
  examples = examples.filter((x) => x.name !== name)
  saveExamples()
  renderExamples()
  toast(`Deleted "${name}".`)
}

function exportExamples() {
  if (!examples.length) return toast("No examples to export yet.")
  const data = { debugger: "pocketone-hooks-debugger", version: 1, examples }
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }))
  a.download = "requests.json"
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function importExamples(file) {
  let list
  try {
    const data = JSON.parse(await file.text())
    list = Array.isArray(data) ? data : data && data.examples
    if (!Array.isArray(list)) throw new Error()
  } catch {
    return toast("That file isn't a list of examples (expected an Export from here).")
  }
  let added = 0, replaced = 0, skipped = 0
  for (const raw of list) {
    const x = cleanExample(raw)
    if (!x) {
      skipped++
      continue
    }
    const i = examples.findIndex((e) => e.name === x.name)
    if (i >= 0) (examples[i] = x), replaced++
    else examples.push(x), added++
  }
  saveExamples()
  renderExamples()
  toast(`Imported: ${added} new, ${replaced} replaced${skipped ? `, ${skipped} skipped (not valid)` : ""}.`)
}

/* ------------------------------------------------------------------ */
/* Layout (resizable columns) and idle, as v1                          */
/* ------------------------------------------------------------------ */

const LAYOUT_KEY = "dbg.layout"
const DEFAULT_LAYOUT = { left: 250, right: 380 }
const MIN_LEFT = 150, MIN_RIGHT = 260, MIN_CODE = 320
let layout = { ...DEFAULT_LAYOUT }

function applyLayout(n, save) {
  const main = document.querySelector(".main")
  const total = main.clientWidth
  let { left, right } = n
  if (total) {
    left = Math.max(MIN_LEFT, Math.min(left, total - right - MIN_CODE))
    right = Math.max(MIN_RIGHT, Math.min(right, total - left - MIN_CODE))
  }
  layout = { left: Math.round(left), right: Math.round(right) }
  main.style.setProperty("--left-w", layout.left + "px")
  main.style.setProperty("--right-w", layout.right + "px")
  if (save) {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {}
  }
}

function initSplitter(id, side) {
  const el = $(id)
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = document.querySelector(".main").getBoundingClientRect()
    el.setPointerCapture(e.pointerId)
    el.classList.add("dragging")
    document.body.classList.add("resizing")
    const move = (ev) => applyLayout(side === "left" ? { left: ev.clientX - rect.left, right: layout.right } : { left: layout.left, right: rect.right - ev.clientX })
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.classList.remove("dragging")
      document.body.classList.remove("resizing")
      applyLayout(layout, true)
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up, { once: true })
    el.addEventListener("pointercancel", up, { once: true })
  })
  el.addEventListener("dblclick", () => applyLayout({ ...layout, [side]: DEFAULT_LAYOUT[side] }, true))
}

function initLayout() {
  let saved = null
  try {
    saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null")
  } catch {}
  if (saved && typeof saved.left === "number" && typeof saved.right === "number") layout = saved
  applyLayout(layout)
  initSplitter("split-left", "left")
  initSplitter("split-right", "right")
  window.addEventListener("resize", () => applyLayout(layout))
}

// A forgotten debugger tab must not keep recording, nor keep a hosted instance awake: after IDLE_MS without input,
// stop the heartbeats (the server then stops recording) until you come back.
const IDLE_MS = 2 * 60 * 1000
let idle = false
let idleTimer = null
let lastActivity = 0

function goIdle() {
  idle = true
  stopHeartbeat()
  setConn(false)
  $("idle-banner").hidden = false
}

function armIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(goIdle, IDLE_MS)
}

function wake() {
  if (!idle) return
  idle = false
  $("idle-banner").hidden = true
  startHeartbeat()
  armIdle()
}

function onInput() {
  if (idle) return wake()
  const now = Date.now()
  if (now - lastActivity < 1000) return
  lastActivity = now
  armIdle()
}

;["pointerdown", "keydown", "wheel"].forEach((type) => window.addEventListener(type, onInput, { capture: true, passive: true }))

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

function showPanelTab(id) {
  document.querySelectorAll(".ptab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === id)
    b.setAttribute("aria-selected", b.dataset.tab === id)
  })
  document.querySelectorAll(".ptab-pane").forEach((p) => (p.hidden = p.id !== "pane-" + id))
}

async function loadFiles() {
  const r = await api("/debug/api/files")
  state.files = r.files
  state.globals = r.globals
  state.analyses.clear()
  state.tabs = state.tabs.filter((n) => state.files.some((f) => f.name === n))
  renderFiles()
  renderBreakpoints()
  if (state.file) {
    const f = state.files.find((x) => x.name === state.file.name)
    if (f) openFile(f.name)
  }
}

async function start() {
  initLayout()
  try {
    setRecordFor(localStorage.getItem("dbg.pauseFor"))
  } catch {}
  try {
    await loadFiles()
  } catch (err) {
    toast("Cannot load the files: " + err.message, 8000)
  }
  renderBreakpoints()
  renderSession()
  startHeartbeat()
  armIdle()
  const first = state.files.find((f) => !f.readonly && f.replay) || state.files[0]
  if (!state.file && first) openFile(first.name)
}

$("code").addEventListener("click", (e) => {
  const gut = e.target.closest(".gut")
  if (gut) toggleBreakpoint(Number(gut.parentElement.dataset.line))
})
$("pause-for").addEventListener("click", (e) => {
  const b = e.target.closest("button")
  if (!b || b.dataset.v === recordFor) return
  setRecordFor(b.dataset.v)
  try {
    localStorage.setItem("dbg.pauseFor", recordFor)
  } catch {}
  if (heartbeatTimer) heartbeat()
})
$("btn-token").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`X-Dbg: ${TOKEN}`)
    toast("Copied the X-Dbg header. It works while this tab stays open.")
  } catch {
    toast(`X-Dbg: ${TOKEN}`, 10000)
  }
})
$("btn-restart").addEventListener("click", () => !state.busy && replay())
$("btn-continue").addEventListener("click", () => run("continue"))
$("btn-into").addEventListener("click", () => run("into"))
$("btn-step").addEventListener("click", () => run("over"))
$("btn-out").addEventListener("click", () => run("out"))
$("btn-back").addEventListener("click", () => run("back"))
$("btn-eval").addEventListener("click", () => {
  showPanelTab("eval")
  $("console-input").focus()
})
$("btn-clear").addEventListener("click", async () => {
  await api("/debug/api/recordings", { method: "DELETE" }).catch(() => {})
  await loadRecs()
})
$("btn-refresh").addEventListener("click", async () => {
  try {
    await loadFiles()
    toast("Files reloaded. Replays use the new code.")
  } catch {
    toast("Cannot load the files.")
  }
})
document.querySelectorAll(".ptab").forEach((b) => b.addEventListener("click", () => showPanelTab(b.dataset.tab)))
$("vars").addEventListener("click", (e) => {
  const row = e.target.closest(".vt-row.can")
  if (!row) return
  const path = row.dataset.path
  if (state.expanded.has(path)) state.expanded.delete(path)
  else state.expanded.add(path)
  renderVars()
})
$("tree-root").addEventListener("click", () => {
  const open = $("files").hidden
  $("files").hidden = !open
  $("tree-root").setAttribute("aria-expanded", open)
  $("tree-root").querySelector(".tw").textContent = open ? "▾" : "▸"
})
$("console-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    evaluate(e.target.value)
    e.target.value = ""
  }
})
$("req-send").addEventListener("click", sendRequest)
renderExamples()
$("ex-list").addEventListener("change", (e) => pickExample(e.target.value))
$("ex-save").addEventListener("click", () => showNameRow($("ex-name-row").hidden))
$("ex-name-ok").addEventListener("click", saveExample)
$("ex-name-cancel").addEventListener("click", () => showNameRow(false))
$("ex-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveExample()
  else if (e.key === "Escape") showNameRow(false)
})
$("ex-delete").addEventListener("click", deleteExample)
$("ex-export").addEventListener("click", exportExamples)
$("ex-import").addEventListener("click", () => $("ex-file").click())
$("ex-file").addEventListener("change", async (e) => {
  const file = e.target.files[0]
  e.target.value = ""
  if (file) await importExamples(file)
})
$("idle-wake").addEventListener("click", wake)
document.addEventListener("keydown", (e) => {
  if (!state.trace || e.target.closest("input, textarea, select")) return
  const keys = { F8: e.shiftKey ? null : "continue", F5: "into", F6: e.shiftKey ? "back" : "over", F7: "out" }
  // e.code, not e.key: with Shift, Safari gives function keys the key "\u0010" (code is still "F6")
  const key = /^F\d+$/.test(e.code) ? e.code : e.key
  if (key === "F8" && e.shiftKey) {
    e.preventDefault()
    return !state.busy && replay()
  }
  const name = keys[key]
  if (!name) return
  e.preventDefault()
  if (name === "back" ? state.cur > 1 : state.view) run(name)
})

start()
