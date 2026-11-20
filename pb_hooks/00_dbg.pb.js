/// <reference path="../pb_data/types.d.ts" />

// Hooks Debugger v2: the recorder (PocketOne only). The debugger UI is in pb_pages/debug/.
//
// Nothing is rewritten and nothing pauses on the server. While a debugger tab is open, each run of a handler
// (routerAdd, cronAdd, every on*() hook) is recorded: every answer it gets from Go, in order (`e`, the $-globals,
// Record & co., toString(), sleep(), Date.now(), Math.random()). The browser replays a recording with the same hook
// files and fakes that give back exactly these answers, and steps through it.
//
// This file must load before the other hook files (names sort, hence "00_"): it wraps the functions they register
// their handlers with. pb_pages/debug/ reads the recordings through globalThis.__dbg (pages run in the same JS VM).

const DBG_MAX = 50 // recordings kept, newest first
const DBG_TAB_TTL = 90 * 1000 // a tab is gone 90 s after its last heartbeat
const DBG_SELF = ["00_dbg.pb.js"]

/* ------------------------------------------------------------------ */
/* Who is debugging: open debugger tabs (heartbeats from the page)     */
/* ------------------------------------------------------------------ */

const __dbgTabs = new Map() // tab id -> { token, all, seen }

function __dbgLiveTabs() {
  const now = Date.now()
  const live = []
  for (const [id, t] of __dbgTabs) {
    if (now - t.seen > DBG_TAB_TTL) __dbgTabs.delete(id)
    else live.push(t)
  }
  return live
}

// "Only me": the request comes from a superuser, or carries the token of an open debugger tab (`dbg` cookie, or the
// `X-Dbg` header for curl and apps on another origin). Hooks without a request (cron, model hooks) need "Everyone",
// unless they run inside a recorded request.
function __dbgShouldRecord(e) {
  if (__dbgDepth > 0) return true
  const tabs = __dbgLiveTabs()
  if (!tabs.length) return false
  if (tabs.some((t) => t.all)) return true
  const ev = e && (e.request ? e : e.requestEvent)
  if (!ev || !ev.request) return false
  try {
    if (ev.auth && ev.auth.isSuperuser()) return true
  } catch (_) {}
  let token = ""
  try {
    token = ev.request.header.get("X-Dbg")
  } catch (_) {}
  if (!token) {
    try {
      token = ev.request.cookie("dbg").value
    } catch (_) {}
  }
  return !!token && tabs.some((t) => t.token === token)
}

/* ------------------------------------------------------------------ */
/* A readable snapshot of a Go value, for the Variables view (as v1)   */
/* ------------------------------------------------------------------ */

const DBG_HIDDEN_KEYS = ["app", "response", "event", "context"]
const DBG_PRIORITY_KEYS = ["record", "collection", "auth", "request", "requestEvent"]
const DBG_SECRET_HEADERS = ["authorization", "cookie", "set-cookie"]

function __dbgIsHttpRequest(v) {
  return typeof v.method === "string" && !!v.url && !!v.header && typeof v.remoteAddr === "string"
}

function __dbgMask(name, value) {
  value = String(value)
  return DBG_SECRET_HEADERS.indexOf(String(name).toLowerCase().replace(/_/g, "-")) !== -1 && value.length > 12
    ? value.slice(0, 12) + "… (masked)"
    : value
}

function __dbgPlain(value, depth, seen) {
  if (value === null || value === undefined) return value === null ? null : "‹undefined›"
  const type = typeof value
  if (type === "function") return "ƒ " + (value.name || "anonymous") + "()"
  if (type === "number" && !isFinite(value)) return String(value)
  if (type !== "object") return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return "Error: " + value.message
  try {
    if (typeof value.publicExport === "function") return __dbgPlain(value.publicExport(), depth, seen)
    if (typeof value.isZero === "function" && typeof value.string === "function") return value.isZero() ? "" : value.string()
    if (__dbgIsHttpRequest(value)) {
      return { method: value.method, url: value.url.path + (value.url.rawQuery ? "?" + value.url.rawQuery : ""), host: value.host, remoteAddr: value.remoteAddr }
    }
    if (typeof value.isAuth === "function" && typeof value.name === "string" && value.fields) {
      return { id: value.id, name: value.name, type: value.type }
    }
  } catch (_) {}
  if (seen.indexOf(value) !== -1) return "‹circular›"
  if (depth <= 0) return Array.isArray(value) ? "‹Array(" + value.length + ")›" : "‹Object›"
  seen.push(value)
  if (Array.isArray(value)) {
    const arr = value.slice(0, 50).map((v) => __dbgPlain(v, depth - 1, seen))
    if (value.length > 50) arr.push("… " + (value.length - 50) + " more")
    return arr
  }
  const keys = []
  for (const key in value) keys.push(key)
  const isEvent = keys.indexOf("app") !== -1 && (keys.indexOf("request") !== -1 || keys.indexOf("requestEvent") !== -1)
  // Go structs: the useful event fields first, internals (the app, the response writer, contexts) left out
  const go = __dbgIsGo(value)
  const ordered = (isEvent ? DBG_PRIORITY_KEYS.filter((k) => keys.indexOf(k) !== -1) : []).concat(
    keys.filter((k) => (!isEvent || DBG_PRIORITY_KEYS.indexOf(k) === -1) && !(go && DBG_HIDDEN_KEYS.indexOf(k) !== -1)),
  )
  const out = {}
  let count = 0
  for (const key of ordered) {
    let item
    try {
      item = value[key]
    } catch (_) {
      item = "‹read error›"
    }
    if (typeof item === "function") continue
    if (++count > 40) {
      out["…"] = "truncated"
      break
    }
    if (isEvent && key === "request" && item && typeof value.requestInfo === "function") {
      try {
        const req = __dbgPlain(item, 1, [])
        const headers = value.requestInfo().headers
        req.headers = {}
        for (const h in headers) req.headers[h] = __dbgMask(h, headers[h])
        out[key] = req
        continue
      } catch (_) {}
    }
    out[key] = __dbgPlain(item, depth - 1, seen)
  }
  return out
}

function __dbgView(value) {
  try {
    const json = JSON.stringify(__dbgPlain(value, 3, []))
    return json && json.length < 20000 ? JSON.parse(json) : "‹too big to show›"
  } catch (err) {
    return "‹cannot display: " + err + "›"
  }
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

const __dbgRecs = []
let __dbgSeq = 0
let __dbgDepth = 0 // recordings in progress (a hook inside $app.save of a recorded handler)

// The globals a handler may get Go answers from; each is swapped for a recording wrapper while a handler runs.
const __dbgGlobals = Object.keys(globalThis)
  .filter((k) => k.startsWith("$"))
  .concat(["Record", "Collection", "DynamicModel", "toString", "readerToString", "sleep", "arrayOf"])
  .filter((k) => globalThis[k] != null)
const __dbgReal = Object.fromEntries(__dbgGlobals.map((k) => [k, globalThis[k]]))
const __dbgRealNow = Date.now
const __dbgRealRandom = Math.random

function __dbgIsGo(v) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return false
  try {
    return String(v).startsWith("[Go ")
  } catch (_) {
    return true
  }
}

// One run's log. Every answer is logged under a key: its path from the root plus the call's arguments, e.g.
// `e.request.pathValue("name")`. Objects are wrapped again, so what's read from them is logged too.
function __dbgRecorder() {
  const log = []
  const targets = new WeakMap() // proxy -> { target, path }

  const unwrap = (v) => (targets.has(v) ? targets.get(v).target : v)
  const argKey = (args) =>
    args
      .map((a) => {
        if (targets.has(a)) return "@" + targets.get(a).path
        try {
          return JSON.stringify(a) ?? "undefined"
        } catch (_) {
          return "?"
        }
      })
      .join(",")

  const typeOf = (v) => (__dbgIsGo(v) ? String(v).slice(4, -1) : Array.isArray(v) ? "array" : typeof v)

  // primitive: its value; object: its type and a snapshot to show, and it's wrapped (the browser gets a fake)
  const answer = (key, value) => {
    if (targets.has(value)) {
      log.push({ k: key, ref: targets.get(value).path })
      return value
    }
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      log.push({ k: key, go: typeOf(value), view: typeof value === "function" ? undefined : __dbgView(value) })
      return wrap(value, key)
    }
    log.push(value === undefined ? { k: key, u: true } : { k: key, v: value })
    return value
  }

  const call = (key, fn) => {
    let r
    try {
      r = fn()
    } catch (err) {
      log.push({ k: key, err: String(err) })
      throw err
    }
    return answer(key, r)
  }

  const wrap = (target, path) => {
    let p
    p = new Proxy(target, {
      get(t, prop) {
        // for…of: walk it by length and index, which are recorded
        if (prop === Symbol.iterator && t != null && "length" in t) {
          return function* () {
            for (let i = 0; i < p.length; i++) yield p[i]
          }
        }
        if (typeof prop === "symbol") return t[prop]
        const v = t[prop]
        if (typeof v === "function") {
          return (...args) => call(`${path}.${prop}(${argKey(args)})`, () => v.apply(t, args.map(unwrap)))
        }
        return answer(`${path}.${prop}`, v)
      },
      set(t, prop, value) {
        log.push({ k: `${path}.${String(prop)}=${argKey([value])}`, u: true })
        t[prop] = unwrap(value)
        return true
      },
      apply(t, self, args) {
        return call(`${path}(${argKey(args)})`, () => Reflect.apply(t, unwrap(self), args.map(unwrap)))
      },
      construct(t, args) {
        return call(`new ${path}(${argKey(args)})`, () => Reflect.construct(t, args.map(unwrap)))
      },
    })
    targets.set(p, { target, path })
    return p
  }
  return { log, wrap, typeOf }
}

// Runs handler(...args), recording it if a debugger wants it.
function __dbgRun(info, handler, args) {
  if (!__dbgShouldRecord(args[0])) return handler(...args)
  const r = __dbgRecorder()
  const rec = { id: ++__dbgSeq, ...info, at: new Date().toISOString(), log: r.log }
  if (args[0] != null && typeof args[0] === "object") rec.root = { go: r.typeOf(args[0]), view: __dbgView(args[0]) }
  const outer = Object.fromEntries(__dbgGlobals.map((k) => [k, globalThis[k]]))
  const outerNow = Date.now
  const outerRandom = Math.random
  for (const k of __dbgGlobals) globalThis[k] = r.wrap(__dbgReal[k], k)
  Date.now = r.wrap(__dbgRealNow, "Date.now")
  Math.random = r.wrap(__dbgRealRandom, "Math.random")
  __dbgDepth++
  let finished = false
  const done = (err) => {
    if (finished) return
    finished = true
    __dbgDepth--
    for (const k of __dbgGlobals) globalThis[k] = outer[k]
    Date.now = outerNow
    Math.random = outerRandom
    if (err) rec.error = String(err)
    rec.ms = __dbgRealNow() - Date.parse(rec.at)
    __dbgRecs.unshift(rec)
    if (__dbgRecs.length > DBG_MAX) __dbgRecs.pop()
  }
  let out
  try {
    out = handler(...args.map((a, i) => (a != null && typeof a === "object" ? r.wrap(a, i === 0 ? "e" : "arg" + i) : a)))
  } catch (err) {
    done(err)
    throw err
  }
  if (out && typeof out.then === "function") {
    // async handler: other requests may run during its awaits and see the wrapped globals (known limit)
    return out.then(
      (v) => (done(), v),
      (err) => (done(err), Promise.reject(err)),
    )
  }
  done()
  return out
}

/* ------------------------------------------------------------------ */
/* Wrap the functions that register handlers                           */
/* ------------------------------------------------------------------ */

// Each registration gets an index among those with the same key, so the browser finds the same handler.
const __dbgCounts = {}
const __dbgNth = (key) => (__dbgCounts[key] = (__dbgCounts[key] ?? 0) + 1) - 1

// The file and line a handler was registered from (for the Recordings list).
function __dbgCaller() {
  const lines = String(new Error().stack || "").split("\n")
  for (const l of lines) {
    const m = l.match(/pb_hooks\/([^:)]+):(\d+)/)
    if (m && DBG_SELF.indexOf(m[1]) === -1) return { file: m[1], line: Number(m[2]) }
  }
  return null
}

const __dbgRealRouterAdd = routerAdd
globalThis.routerAdd = function (method, pattern, handler, ...middlewares) {
  const key = `routerAdd(${JSON.stringify(method)},${JSON.stringify(pattern)})`
  const n = __dbgNth(key)
  const where = __dbgCaller()
  return __dbgRealRouterAdd(
    method,
    pattern,
    (e) => __dbgRun({ kind: "route", key, n, where, title: `${method} ${pattern}`, path: e.request.url.path }, handler, [e]),
    ...middlewares,
  )
}

const __dbgRealCronAdd = cronAdd
globalThis.cronAdd = function (id, expr, handler) {
  const key = `cronAdd(${JSON.stringify(id)})`
  const n = __dbgNth(key)
  const where = __dbgCaller()
  return __dbgRealCronAdd(id, expr, () => __dbgRun({ kind: "cron", key, n, where, title: `cron ${id} (${expr})` }, handler, []))
}

for (const name of Object.keys(globalThis).filter((k) => /^on[A-Z]/.test(k) && typeof globalThis[k] === "function")) {
  const real = globalThis[name]
  globalThis[name] = function (handler, ...tags) {
    const key = `${name}(${tags.map((t) => JSON.stringify(t)).join(",")})`
    const n = __dbgNth(key)
    const where = __dbgCaller()
    return real((e) => {
      let what = ""
      try {
        if (e && e.record) what = ` ${e.record.collection().name}/${e.record.id || "new"}`
      } catch (_) {}
      return __dbgRun({ kind: "hook", key, n, where, title: name + what }, handler, [e])
    }, ...tags)
  }
}

/* ------------------------------------------------------------------ */
/* What pb_pages/debug/ uses                                           */
/* ------------------------------------------------------------------ */

globalThis.__dbg = {
  version: 2,
  self: DBG_SELF,
  globals: __dbgGlobals,

  // A debugger tab's heartbeat. Returns the newest recording id, so the tab knows when to reload the list.
  presence(tab, token, all, bye) {
    if (bye) __dbgTabs.delete(tab)
    else if (tab) __dbgTabs.set(String(tab), { token: String(token || ""), all: !!all, seen: Date.now() })
    return { latest: __dbgRecs.length ? __dbgRecs[0].id : 0, tabs: __dbgLiveTabs().length }
  },

  list() {
    return __dbgRecs.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, path: r.path, key: r.key, n: r.n, where: r.where,
      at: r.at, ms: r.ms, error: r.error, answers: r.log.length,
    }))
  },

  get(id) {
    return __dbgRecs.find((r) => r.id === Number(id)) || null
  },

  clear() {
    __dbgRecs.length = 0
  },
}
