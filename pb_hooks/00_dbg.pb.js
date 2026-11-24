/// <reference path="../types.d.ts" />

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
  const now = __dbgRealNow() // not Date.now: it may be wrapped by a recording in progress
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

// Dry run: a route handler runs inside a database transaction that is always rolled back. Asked for with the
// `X-Dbg-Dry` header; its value must be the token of an open debugger tab, so nobody else can ask for it.
const DBG_ROLLBACK = "__dbg_dry_run_rollback__"

function __dbgWantsDry(e) {
  let token = ""
  try {
    token = e.request.header.get("X-Dbg-Dry")
  } catch (_) {}
  return !!token && __dbgLiveTabs().some((t) => t.token === token)
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

// Secrets never go into a recording: private keys in PEM, and the values of environment variables whose names say
// they are secret (…KEY, …SECRET, …TOKEN, …PASSWORD, e.g. AS2_MASTER_KEY). Applied to a whole recording before the
// page can see it. The replay then gets the mask instead of the value (a handler that uses a secret replays
// differently from the server: that is the price).
const DBG_SECRET_ENV = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD)/i
const DBG_PEM_PRIVATE = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g

function __dbgSecretValues() {
  const out = []
  try {
    const env = typeof process !== "undefined" && process.env ? process.env : {}
    for (const name of Object.keys(env)) {
      const v = String(env[name] || "")
      if (DBG_SECRET_ENV.test(name) && v.length >= 12) out.push([name, v])
    }
  } catch (_) {}
  return out
}

function __dbgScrubString(str, secrets) {
  if (typeof str !== "string" || str.length < 12) return str
  let s = str.replace(DBG_PEM_PRIVATE, "‹private key masked›")
  for (const [name, v] of secrets) {
    // as it is, and as it looks inside JSON (an argument key is JSON)
    for (const form of [v, JSON.stringify(v).slice(1, -1)]) if (s.indexOf(form) !== -1) s = s.split(form).join(`‹${name} masked›`)
  }
  return s
}

// In place, through plain objects and arrays (a recording holds only those: Go values are snapshots already).
function __dbgScrub(value, secrets, seen = new Set()) {
  if (typeof value === "string") return __dbgScrubString(value, secrets)
  if (value === null || typeof value !== "object" || seen.has(value)) return value
  seen.add(value)
  for (const k of Object.keys(value)) {
    try {
      value[k] = __dbgScrub(value[k], secrets, seen)
    } catch (_) {}
  }
  return value
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
// proxy -> the real value, for every recorder (a nested recording must wrap the real $app, not a proxy)
const __dbgRealOf = new WeakMap()
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

// Has the object a property a Proxy can't answer with another value (not writable and not configurable)?
const __dbgFrozen = new WeakMap()
function __dbgHasFrozen(v) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return false
  if (__dbgFrozen.has(v)) return __dbgFrozen.get(v)
  let frozen = false
  try {
    frozen =
      !Object.isExtensible(v) ||
      Object.getOwnPropertyNames(v).some((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k)
        return d && !d.configurable && "value" in d && !d.writable
      })
  } catch (_) {}
  __dbgFrozen.set(v, frozen)
  return frozen
}

// One run's log. Every answer is logged under a key: its path from the root plus the call's arguments, e.g.
// `e.request.pathValue("name")`. Objects are wrapped again, so what's read from them is logged too.
function __dbgRecorder() {
  const log = []
  const targets = new WeakMap() // proxy -> { target, path }

  const unwrap = (v) => (targets.has(v) ? targets.get(v).target : v)
  // Plain objects and arrays the handler made can hold wrapped values, e.g. e.json(200, { limits: $wasm.limits() }).
  // swap: a copy with each wrapped value replaced by `swap(proxy)`; the same object when there's none.
  const deep = (v, swap, seen = new Set()) => {
    if (targets.has(v)) return swap(v)
    if (v === null || typeof v !== "object" || seen.has(v)) return v
    const arr = Array.isArray(v)
    if (!arr && Object.getPrototypeOf(v) !== Object.prototype) return v
    seen.add(v)
    const out = arr ? [] : {}
    let changed = false
    for (const k of Object.keys(v)) {
      const x = deep(v[k], swap, seen)
      if (x !== v[k]) changed = true
      out[k] = x
    }
    return changed ? out : v
  }
  // what Go gets: the real values, also inside the handler's own objects (so Go doesn't read through the proxies)
  const real = (v) => deep(v, unwrap)
  const argKey = (args) =>
    args
      .map((a) => {
        if (targets.has(a)) return "@" + targets.get(a).path
        try {
          return JSON.stringify(deep(a, (p) => "@" + targets.get(p).path)) ?? "undefined"
        } catch (_) {
          return "?"
        }
      })
      .join(",")

  const typeOf = (v) => (__dbgIsGo(v) ? String(v).slice(4, -1) : Array.isArray(v) ? "array" : typeof v)

  // primitive: its value; object: its type and a snapshot to show, and it's wrapped (the browser gets a fake)
  // an error keeps its own fields (e.g. a WasmError's code, retryable, module), so the replay can throw the same
  const failed = (key, err) => {
    const entry = { k: key, err: String(err) }
    if (err !== null && typeof err === "object") {
      try {
        entry.fields = JSON.parse(JSON.stringify({ name: err.name, message: err.message, ...err }))
      } catch (_) {}
    }
    log.push(entry)
  }

  const answer = (key, value) => {
    // a promise (e.g. $wasm.run.async): logged as one, and what it gives is logged under `<key>.await`
    if (value instanceof Promise) {
      log.push({ k: key, promise: true })
      return value.then(
        (v) => answer(key + ".await", v),
        (err) => {
          failed(key + ".await", err)
          throw err
        },
      )
    }
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
      failed(key, err)
      throw err
    }
    return answer(key, r)
  }

  // a method, recorded when called; its own methods too, one level (e.g. $wasm.run.async)
  const method = (path, self, v, sub = true) => {
    const fn = (...args) => call(`${path}(${argKey(args)})`, () => v.apply(self, args.map(real)))
    if (!sub) return fn
    let names = []
    try {
      names = Object.getOwnPropertyNames(v).filter((k) => k !== "length" && k !== "name" && k !== "prototype")
    } catch (_) {}
    for (const k of names) {
      let f
      try {
        f = v[k]
      } catch (_) {
        continue
      }
      if (typeof f === "function") fn[k] = method(`${path}.${k}`, v, f, false)
    }
    return fn
  }

  // overrides: properties answered with another value (a dry run's e.app is the transaction's app)
  const wrap = (target, path, overrides) => {
    // A Proxy must answer a frozen property (not writable, not configurable) with the property's own value, or JS
    // throws "proxy: inconsistent get". $wasm is frozen, and we answer with wrapped methods. So such an object gets
    // a stand-in as the Proxy's target, and the traps use the real one.
    const shadow = __dbgHasFrozen(target) ? (typeof target === "function" ? function () {} : {}) : null
    const t = target
    const traps = {
      get(_, prop) {
        if (overrides && typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) {
          return answer(`${path}.${prop}`, overrides[prop])
        }
        // for…of: walk it by length and index, which are recorded
        if (prop === Symbol.iterator && t != null && "length" in t) {
          return function* () {
            for (let i = 0; i < p.length; i++) yield p[i]
          }
        }
        // `then` is what `await` looks for: not recorded (the replay's fakes have none), so awaiting a value is free
        if (typeof prop === "symbol" || prop === "then") return t[prop]
        const v = t[prop]
        if (typeof v === "function") return method(`${path}.${prop}`, t, v)
        return answer(`${path}.${prop}`, v)
      },
      set(_, prop, value) {
        log.push({ k: `${path}.${String(prop)}=${argKey([value])}`, u: true })
        t[prop] = real(value)
        return true
      },
      apply(_, self, args) {
        return call(`${path}(${argKey(args)})`, () => Reflect.apply(t, unwrap(self), args.map(real)))
      },
      construct(_, args) {
        return call(`new ${path}(${argKey(args)})`, () => Reflect.construct(t, args.map(real)))
      },
    }
    if (shadow) traps.has = (_, prop) => prop in t
    if (shadow && typeof shadow !== "function") {
      // the stand-in is empty: Object.keys() and descriptors come from the real object (as configurable, which the
      // stand-in allows; a function stand-in has its own `prototype`, so it keeps its own keys)
      traps.ownKeys = () => Reflect.ownKeys(t)
      traps.getOwnPropertyDescriptor = (_, prop) => {
        const d = Reflect.getOwnPropertyDescriptor(t, prop)
        return d && { ...d, configurable: true }
      }
    }
    const p = new Proxy(shadow || target, traps)
    targets.set(p, { target, path })
    __dbgRealOf.set(p, target)
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
  // PocketOne sets $app to the event's app before each handler (the transaction's app inside a transaction):
  // wrap that one, not the $app from when this file loaded, or a hook inside a transaction would wait for it forever.
  const appNow = __dbgRealOf.get(globalThis.$app) || globalThis.$app || __dbgReal.$app
  for (const k of __dbgGlobals) globalThis[k] = r.wrap(k === "$app" ? appNow : __dbgReal[k], k)
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
    __dbgScrub(rec, __dbgSecretValues())
    __dbgRecs.unshift(rec)
    if (__dbgRecs.length > DBG_MAX) __dbgRecs.pop()
  }
  const wrapArgs = (overrides) =>
    args.map((a, i) => (a != null && typeof a === "object" ? r.wrap(a, i === 0 ? "e" : "arg" + i, i === 0 ? overrides : undefined) : a))

  if (info.kind === "route" && __dbgDepth === 1 && __dbgWantsDry(args[0])) {
    rec.dry = true
    return __dbgRunDry(handler, args[0], appNow, r, wrapArgs, done)
  }

  let out
  try {
    out = handler(...wrapArgs())
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

// A dry run: the handler gets the transaction's app as $app and e.app, then the transaction is rolled back. The
// response is still sent (it's written as the handler runs), with an `X-Dbg-Dry: rolled back` header.
// Sync handlers only (see below). Not undone: $http calls, emails, files, anything outside the database.
function __dbgRunDry(handler, e, appNow, r, wrapArgs, done) {
  const isRollback = (err) => String(err).indexOf(DBG_ROLLBACK) !== -1
  let out, failed = false, error
  const inTx = (txApp) => {
    globalThis.$app = r.wrap(txApp, "$app")
    return wrapArgs({ app: txApp })
  }

  if (handler.constructor && handler.constructor.name === "AsyncFunction") {
    // Not run at all: after an await, PocketOne gives $app back its real app, so the rest of the handler would write
    // outside the transaction (and wait forever for its lock).
    const err = new Error("dry run: not supported for async handlers yet, so the handler was not run")
    try {
      e.response.header().set("X-Dbg-Dry", "refused: async handler, not run")
    } catch (_) {}
    done(err)
    throw err
  }

  try {
    e.response.header().set("X-Dbg-Dry", "rolled back")
  } catch (_) {}
  try {
    appNow.runInTransaction((txApp) => {
      try {
        out = handler(...inTx(txApp))
      } catch (err) {
        failed = true
        error = err
      }
      throw new Error(DBG_ROLLBACK)
    })
  } catch (err) {
    if (!isRollback(err)) {
      done(err)
      throw err
    }
  }
  done(failed ? error : undefined)
  if (failed) throw error
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

const __dbgRoutes = [] // every routerAdd, for the page's "Suggest examples"
const __dbgRealRouterAdd = routerAdd
globalThis.routerAdd = function (method, pattern, handler, ...middlewares) {
  const key = `routerAdd(${JSON.stringify(method)},${JSON.stringify(pattern)})`
  const n = __dbgNth(key)
  const where = __dbgCaller()
  __dbgRoutes.push({ method: String(method), pattern: String(pattern), file: where && where.file, line: where && where.line })
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
    else if (tab) __dbgTabs.set(String(tab), { token: String(token || ""), all: !!all, seen: __dbgRealNow() })
    return { latest: __dbgRecs.length ? __dbgRecs[0].id : 0, tabs: __dbgLiveTabs().length }
  },

  list() {
    return __dbgRecs.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, path: r.path, key: r.key, n: r.n, where: r.where,
      at: r.at, ms: r.ms, error: r.error, dry: r.dry, answers: r.log.length,
    }))
  },

  get(id) {
    return __dbgRecs.find((r) => r.id === Number(id)) || null
  },

  // the routes registered with routerAdd: { method, pattern, file, line }
  routes() {
    return __dbgRoutes.map((r) => ({ ...r }))
  },

  clear() {
    __dbgRecs.length = 0
  },
}
