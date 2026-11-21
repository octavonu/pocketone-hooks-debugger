// Hooks Debugger v2: the replay engine (browser). Needs acorn.
//
// A recording (made by pb_hooks/00_dbg.pb.js) is the list of answers a handler got from Go. Here the same hook files
// run again in the browser, against fakes that give back those answers in order, so the handler takes the same path.
// The files are instrumented in memory (never on the server) with a probe before each statement, so a run yields its
// trace: every executed line, with the call stack. Stepping is moving through the trace. To show the variables at a
// step, or evaluate an expression there, the replay runs again up to that step (it's deterministic) and looks.
;(function (root) {
  "use strict"

  const MAX_STEPS = 50000

  /* ---------------------------------------------------------------- */
  /* Fakes that answer from the recording                              */
  /* ---------------------------------------------------------------- */

  class Miss extends Error {}

  function replayer(log) {
    const entries = log.map((x, i) => ({ ...x, i }))
    const queues = new Map()
    for (const x of entries) {
      if (!queues.has(x.k)) queues.set(x.k, [])
      queues.get(x.k).push(x)
    }
    const methods = new Map()
    const isMethod = (base) => {
      if (!methods.has(base)) methods.set(base, entries.some((x) => x.k.startsWith(base + "(")))
      return methods.get(base)
    }
    // a method with its own methods (e.g. $wasm.run, called as $wasm.run.async(…)): never read as a value itself
    const parents = new Map()
    const hasMethods = (base) => {
      if (!parents.has(base)) parents.set(base, !queues.has(base) && entries.some((x) => x.k.startsWith(base + ".")))
      return parents.get(base)
    }
    const info = new WeakMap() // fake -> { path, type, view }
    const byPath = new Map()
    const used = new Set() // indexes of the answers given so far
    const last = new Map() // key -> the last answer given for it
    const misses = []
    let peeking = false // while inspecting: answer without using up the recording
    let loadingFiles = false // while the hook files load: their top-level code isn't in the recording

    // A stand-in for what top-level code gets from Go, e.g. `$apis.requireSuperuserAuth()` passed to routerAdd: it
    // ran when the server loaded the hooks, not in the handler, so the recording doesn't have it. It does nothing.
    const stub = (key) => {
      const s = new Proxy(function () {}, {
        get: (_, prop) =>
          prop === Symbol.toPrimitive ? () => `[not recorded: ${key}]` : typeof prop === "symbol" || prop === "then" ? undefined : s,
        apply: () => s,
        construct: () => s,
      })
      return s
    }

    // as in the recorder: a fake inside the handler's own objects and arrays is written as "@<its path>"
    const refs = (v, seen = new Set()) => {
      if (info.has(v)) return "@" + info.get(v).path
      if (v === null || typeof v !== "object" || seen.has(v)) return v
      const arr = Array.isArray(v)
      if (!arr && Object.getPrototypeOf(v) !== Object.prototype) return v
      seen.add(v)
      const out = arr ? [] : {}
      let changed = false
      for (const k of Object.keys(v)) {
        const x = refs(v[k], seen)
        if (x !== v[k]) changed = true
        out[k] = x
      }
      return changed ? out : v
    }
    const argKey = (args) =>
      args
        .map((a) => {
          if (info.has(a)) return "@" + info.get(a).path
          try {
            return JSON.stringify(refs(a)) ?? "undefined"
          } catch (_) {
            return "?"
          }
        })
        .join(",")

    const value = (x, key) => {
      if (x.err) {
        const err = new Error(x.err.replace(/^Error: /, ""))
        if (x.fields) Object.assign(err, x.fields) // e.g. a WasmError's name, code, retryable, module
        throw err
      }
      // a promise (e.g. $wasm.run.async): what it gave is under `<key>.await`, taken when it's awaited
      if (x.promise) return Promise.resolve().then(() => take(key + ".await"))
      if (x.ref) return byPath.get(x.ref)
      if (x.go) return fake(key, x.go, x.view)
      return x.u ? undefined : x.v
    }

    const take = (key, fromView) => {
      const q = queues.get(key)
      if (peeking) {
        if (last.has(key)) return value(last.get(key), key)
        if (q && q.length) return value(q[0], key)
        if (fromView) return fromView() // not read by the handler: the snapshot made when it was recorded
        throw new Miss("not in the recording: " + key)
      }
      if (!q || q.length === 0) {
        if (loadingFiles) return stub(key)
        misses.push(key)
        throw new Miss("not in the recording: " + key)
      }
      const x = q.shift()
      used.add(x.i)
      last.set(key, x)
      return value(x, key)
    }

    function fake(path, type, view) {
      if (byPath.has(path)) return byPath.get(path)
      let p
      p = new Proxy(function () {}, {
        get(_, prop) {
          if (prop === Symbol.toPrimitive) return () => `[Go ${type}]`
          if (prop === Symbol.iterator) {
            return function* () {
              for (let i = 0; i < p.length; i++) yield p[i]
            }
          }
          if (typeof prop === "symbol" || prop === "then") return undefined
          const base = `${path}.${prop}`
          if (hasMethods(base)) return fake(base, "function")
          if (isMethod(base)) return (...args) => take(`${base}(${argKey(args)})`)
          const snap = view !== null && typeof view === "object" && prop in view ? () => view[prop] : null
          return take(base, snap)
        },
        set(_, prop, v) {
          take(`${path}.${String(prop)}=${argKey([v])}`)
          return true
        },
        apply(_, __, args) {
          return take(`${path}(${argKey(args)})`)
        },
        construct(_, args) {
          return take(`new ${path}(${argKey(args)})`)
        },
      })
      info.set(p, { path, type, view })
      byPath.set(path, p)
      return p
    }

    return {
      fake,
      info,
      used,
      misses,
      unused: () => entries.filter((x) => !used.has(x.i)),
      peek: (on) => (peeking = on),
      loading: (on) => (loadingFiles = on),
    }
  }

  /* ---------------------------------------------------------------- */
  /* Source analysis and instrumentation (acorn), as in v1             */
  /* ---------------------------------------------------------------- */

  const isFn = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type)

  function childNodes(node) {
    const out = []
    for (const key in node) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === "string" && out.push(x))
      else if (v && typeof v.type === "string") out.push(v)
    }
    return out
  }

  function patternNames(p, out) {
    if (!p) return out
    if (p.type === "Identifier") out.push(p.name)
    else if (p.type === "ObjectPattern") p.properties.forEach((pr) => patternNames(pr.type === "RestElement" ? pr.argument : pr.value, out))
    else if (p.type === "ArrayPattern") p.elements.forEach((el) => patternNames(el, out))
    else if (p.type === "RestElement") patternNames(p.argument, out)
    else if (p.type === "AssignmentPattern") patternNames(p.left, out)
    return out
  }

  // Names declared in a function (params + body declarations, not nested functions).
  function scopeNames(fn) {
    const names = []
    fn.params.forEach((p) => patternNames(p, names))
    ;(function walk(node) {
      childNodes(node).forEach((child) => {
        if (child.type === "VariableDeclaration") child.declarations.forEach((d) => patternNames(d.id, names))
        if (child.type === "FunctionDeclaration" && child.id) {
          names.push(child.id.name)
          return
        }
        if (child.type === "ClassDeclaration" && child.id) names.push(child.id.name)
        if (child.type === "CatchClause" && child.param) patternNames(child.param, names)
        if (isFn(child)) return
        walk(child)
      })
    })(fn.body)
    return names
  }

  function describeFn(fn, parent, src) {
    if (parent && parent.type === "CallExpression" && parent.arguments.includes(fn)) {
      const callee = src.slice(parent.callee.start, parent.callee.end)
      const args = parent.arguments.map((a) => (a === fn ? "ƒ" : a.type === "Literal" ? JSON.stringify(a.value) : "…"))
      return `${callee}(${args.join(", ")})`
    }
    if (fn.id) return `function ${fn.id.name}()`
    if (parent && parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return `${parent.id.name}()`
    if (parent && parent.type === "Property" && parent.key) return `${parent.key.name || parent.key.value}()`
    return "anonymous function"
  }

  // probes: line -> { line, offset, names, ctx } (a statement in a function body starts on that line)
  // wraps: function bodies, for the call stack
  function analyze(src) {
    const ast = acorn.parse(src, {
      ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowHashBang: true,
    })
    const probes = new Map()
    const wraps = []
    ;(function visit(node, parent, scopes, ctx) {
      if (isFn(node)) {
        scopes = scopes.concat([scopeNames(node)])
        ctx = describeFn(node, parent, src)
        const body = node.body
        if (body.type === "BlockStatement" && !node.generator && !(body.body[0] && body.body[0].directive)) {
          wraps.push({ start: body.start + 1, end: body.end - 1, ctx })
        }
      }
      if (node.type === "BlockStatement" && scopes.length) {
        node.body.forEach((st) => {
          const line = st.loc.start.line
          if (probes.has(line)) return
          const names = [...new Set(scopes.flat())].filter((n) => /^[\w$]+$/.test(n) && !n.startsWith("__dbg"))
          probes.set(line, { line, offset: st.start, names, ctx })
        })
      }
      childNodes(node).forEach((child) => visit(child, node, scopes, ctx))
    })(ast, null, [], null)
    return { probes, wraps }
  }

  // Inserts the probes and enter()/exit() without adding a newline, so the line numbers stay the same.
  function instrument(name, src, analysis) {
    const q = JSON.stringify(name)
    const inserts = []
    analysis.wraps.forEach((w) => {
      inserts.push([w.start, 0, `/*@dbg*/;__dbg_enter(${q},${JSON.stringify(w.ctx)});try{/*@/dbg*/`])
      inserts.push([w.end, 2, `/*@dbg*/}finally{__dbg_exit()}/*@/dbg*/`])
    })
    analysis.probes.forEach((p) => {
      inserts.push([p.offset, 1, `/*@dbg*/;__dbg_bp(${q},${p.line},(__dbgx)=>eval(__dbgx),${JSON.stringify(p.names)});/*@/dbg*/`])
    })
    let out = src
    inserts
      .sort((a, b) => b[0] - a[0] || b[1] - a[1])
      .forEach(([offset, , text]) => (out = out.slice(0, offset) + text + out.slice(offset)))
    return out
  }

  const compiled = new Map() // name + source -> instrumented code

  function code(name, src) {
    const key = name + "\0" + src
    if (!compiled.has(key)) compiled.set(key, instrument(name, src, analyze(src)))
    return compiled.get(key)
  }

  /* ---------------------------------------------------------------- */
  /* Values as plain JSON for the Variables view (as v1's describe)    */
  /* ---------------------------------------------------------------- */

  function describe(value, info, depth = 3) {
    const plain = (v, d, seen) => {
      if (info.has(v)) {
        const f = info.get(v)
        return f.view !== undefined ? f.view : `‹${f.type}›`
      }
      if (v === null) return null
      if (v === undefined) return "‹undefined›"
      const t = typeof v
      if (t === "function") return "ƒ " + (v.name || "anonymous") + "()"
      if (t === "number" && !isFinite(v)) return String(v)
      if (t === "bigint") return String(v) + "n"
      if (t === "symbol") return String(v)
      if (t !== "object") return v
      if (v instanceof Date) return v.toISOString()
      if (v instanceof Error) return "Error: " + v.message
      if (seen.includes(v)) return "‹circular›"
      if (d <= 0) return Array.isArray(v) ? `‹Array(${v.length})›` : "‹Object›"
      seen.push(v)
      if (Array.isArray(v)) return v.slice(0, 100).map((x) => plain(x, d - 1, seen))
      const out = {}
      for (const k of Object.keys(v).slice(0, 60)) out[k] = plain(v[k], d - 1, seen)
      return out
    }
    let type = info.has(value) ? info.get(value).type : value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    let v
    try {
      v = plain(value, depth, [])
    } catch (err) {
      v = "‹cannot display: " + err.message + "›"
    }
    return { type, value: v }
  }

  /* ---------------------------------------------------------------- */
  /* One run                                                           */
  /* ---------------------------------------------------------------- */

  // run(files, rec, opts) replays rec once.
  //   files:  { "main.pb.js": source, "lib/greet.js": source, ... } (paths under pb_hooks)
  //   opts.globals:  the names the recorder faked
  //   opts.trace:    collect every step: { file, line, depth, stack: [{ file, line, ctx }] }
  //   opts.stopAt:   at this step (1-based), look: opts.frame (0 = top), opts.exprs (to evaluate there)
  // Returns { steps, inspect, error, misses, unused, used, response, finished }.
  async function run(files, rec, opts = {}) {
    const r = replayer(rec.log)
    const handlers = new Map()
    const add = (key, h) => {
      if (!handlers.has(key)) handlers.set(key, [])
      handlers.get(key).push(h)
    }
    const noop = () => {}
    const modules = new Map()
    const fakes = {}
    const globals = opts.globals || []
    const fakeGlobal = (k) => (fakes[k] ??= r.fake(k, "global"))

    // the tracer
    const frames = [] // { file, ctx, line, scope, names }
    const steps = []
    let step = 0
    let inspect = null
    let loading = true // probes while loading the files (top-level code has none, but modules may run code)

    const scope = {
      __hooks: "/pb_hooks",
      __dbg_enter(file, ctx) {
        frames.push({ file, ctx, line: null, scope: null, names: [] })
      },
      __dbg_exit() {
        frames.pop()
      },
      __dbg_bp(file, line, evalIn, names) {
        if (loading) return
        let top = frames[frames.length - 1]
        if (!top || top.file !== file) {
          top = { file, ctx: "anonymous function", line, scope: null, names: [] }
          frames.push(top)
        }
        top.line = line
        top.scope = evalIn
        top.names = names
        if (++step > MAX_STEPS) throw new Error(`stopped after ${MAX_STEPS} steps (an endless loop?)`)
        if (opts.trace) steps.push({ file, line, depth: frames.length, stack: frames.map((f) => ({ file: f.file, line: f.line, ctx: f.ctx })).reverse() })
        if (step === opts.stopAt) inspect = look(opts.frame || 0, opts.exprs || [])
      },
      routerAdd: (method, pattern, h) => add(`routerAdd(${JSON.stringify(method)},${JSON.stringify(pattern)})`, h),
      cronAdd: (id, _expr, h) => add(`cronAdd(${JSON.stringify(id)})`, h),
      routerUse: noop,
      cronRemove: noop,
      migrate: noop,
      Date: new Proxy(Date, { get: (t, k) => (k === "now" ? fakeGlobal("Date.now") : Reflect.get(t, k)) }),
      Math: new Proxy(Math, { get: (t, k) => (k === "random" ? fakeGlobal("Math.random") : Reflect.get(t, k)) }),
      require(path) {
        return load(resolve(String(path), "")).exports
      },
    }

    // the variables of a frame, and expressions evaluated in it; reads only, the recording isn't used up
    function look(frameIndex, exprs) {
      const stack = frames.map((f) => ({ file: f.file, line: f.line, ctx: f.ctx })).reverse()
      const f = frames[frames.length - 1 - frameIndex] || frames[frames.length - 1]
      r.peek(true)
      try {
        const locals = {}
        for (const name of f.names) {
          try {
            locals[name] = describe(f.scope(name), r.info)
          } catch (err) {
            if (!/ReferenceError|before initialization|is not defined/.test(String(err))) locals[name] = { type: "error", value: String(err) }
          }
        }
        const evals = exprs.map((x) => {
          try {
            return describe(f.scope(x), r.info, 4)
          } catch (err) {
            return { type: "error", value: String(err) }
          }
        })
        return { stack, frame: frames.length - 1 - frames.indexOf(f), locals, evals, used: [...r.used] }
      } finally {
        r.peek(false)
      }
    }

    const isHook = (k) => typeof k === "string" && /^on[A-Z]/.test(k)
    const isGlobal = (k) => typeof k === "string" && (globals.includes(k) || k.startsWith("$"))
    const sandbox = new Proxy(scope, {
      has: (t, k) => k in t || isHook(k) || isGlobal(k),
      get: (t, k) => {
        if (k === Symbol.unscopables) return undefined
        if (k in t) return t[k]
        if (isHook(k)) return (h, ...tags) => add(`${k}(${tags.map((x) => JSON.stringify(x)).join(",")})`, h)
        if (isGlobal(k)) return fakeGlobal(k)
        return undefined
      },
    })

    function resolve(path, fromDir) {
      let p = path.replace(/^\/pb_hooks\//, "")
      if (p.startsWith("./") || p.startsWith("../")) p = (fromDir ? fromDir + "/" : "") + p
      const parts = []
      for (const s of p.split("/")) {
        if (s === "..") parts.pop()
        else if (s && s !== ".") parts.push(s)
      }
      p = parts.join("/")
      if (!(p in files) && p + ".js" in files) p += ".js"
      return p
    }

    function load(name) {
      if (modules.has(name)) return modules.get(name)
      if (!(name in files)) throw new Error("module not found: " + name)
      const module = { exports: {} }
      modules.set(name, module)
      const dir = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : ""
      const req = (p) => load(resolve(String(p), dir)).exports
      compile(name, ["module", "exports", "require"])(sandbox, module, module.exports, req)
      return module
    }

    // Indirect eval with the wrapper on the first line keeps the file's line numbers; sourceURL names it in DevTools.
    function compile(name, params = []) {
      const src = `(function (__sim, ${params.join(", ")}) { with (__sim) { ${code(name, files[name])}\n} })\n//# sourceURL=pb_hooks/${name}`
      return (0, eval)(src)
    }

    r.loading(true)
    try {
      for (const name of Object.keys(files).sort()) {
        if (name.includes("/") || !/\.pb\.(c)?js$/.test(name)) continue // modules load on require()
        compile(name)(sandbox)
      }
    } finally {
      r.loading(false)
    }
    loading = false

    const handler = (handlers.get(rec.key) || [])[rec.n]
    if (!handler) throw new Error(`No ${rec.key}${rec.n ? " #" + (rec.n + 1) : ""} in the hook files any more.`)
    const args = rec.kind === "cron" ? [] : [r.fake("e", rec.root ? rec.root.go : "event", rec.root ? rec.root.view : undefined)]

    let error = null
    try {
      await handler(...args)
    } catch (err) {
      error = String(err)
    }
    const unused = r.unused()
    const response = [...r.used]
      .map((i) => rec.log[i])
      .filter((x) => /^e\.(json|string|html|xml|noContent|redirect|blob|file|stream)\(/.test(x.k))
      .map((x) => x.k)
    const sameError = !!error && error.replace(/^Error: /, "") === String(rec.error || "").replace(/^Error: /, "")
    return {
      steps,
      inspect,
      error,
      sameError,
      misses: r.misses,
      unused,
      used: [...r.used],
      response,
      same: (!error || sameError) && !r.misses.length && !unused.length,
    }
  }

  root.DbgReplay = { run, analyze, describe }
})(typeof window !== "undefined" ? window : globalThis)
