// GET /debug/api/files: every code file under pb_hooks, and under pb_pages (named "pb_pages/…"), with its source
// ({ name, source, readonly, replay }). readonly: the debugger's own files. replay: whether the browser can run it
// (CommonJS .js for hooks; .ts and .js code for pages, plain JavaScript only). A read-only file may still be
// replayed (pb_pages/+middleware.ts), but has no breakpoints.
const SEGMENT = /^[\w\-+][\w.\-+]*$/

function walk(root, prefix, depth, keep, files) {
  if (depth > 8) return
  let entries
  try {
    entries = $os.readDir(root)
  } catch (_) {
    return
  }
  for (const entry of entries) {
    const name = entry.name()
    if (!SEGMENT.test(name) || name === "node_modules" || name.startsWith("_ph_")) continue
    if (entry.isDir()) walk(root + "/" + name, prefix + name + "/", depth + 1, keep, files)
    else {
      const f = keep(prefix + name, name)
      if (!f) continue
      const { note, ...file } = f
      files.push({ ...file, source: note ?? toString($os.readFile(root + "/" + name)) })
    }
  }
}

module.exports = {
  get(ctx) {
    const files = []

    const hooks = globalThis.__hooks || ctx.app.dataDir() + "/../pb_hooks"
    walk(hooks, "", 0, (rel, name) => {
      if (!/\.(c|m)?(j|t)s$/.test(name) || name.endsWith(".d.ts")) return null
      const ours = __dbg.self.indexOf(rel) !== -1 // the recorder: shown, never replayed
      return { name: rel, readonly: ours, replay: !ours && /\.(c)?js$/.test(name) }
    }, files)

    // pb_pages: route code (.ts), templates (not replayed yet), +middleware, and modules in _private/ folders; not
    // other .js files (those are static files, served as they are). And the debugger's own page (debug/), locked.
    walk(ctx.pagesDir, "", 0, (rel, name) => {
      // the debugger's own page: shown, locked, never replayed
      if (rel.startsWith("debug/")) {
        if (!/\.(ejs|ts|js|css)$/.test(name)) return null
        // acorn (246 KB): a note instead of the file, so this list stays small
        const note = name === "acorn.js" ? "// acorn 8.19.0, the JavaScript parser the replay uses (246 KB, not shown here).\n// See README, Security, for its SHA-256 and how to check it.\n" : undefined
        return { name: "pb_pages/" + rel, readonly: true, replay: false, note }
      }
      // templates (pages, layouts, partials): listed, not replayed yet
      if (/\.(ejs|ets|md|jsx|tsx)$/.test(name)) return { name: "pb_pages/" + rel, readonly: false, replay: false }
      const code = /\.ts$/.test(name) && !name.endsWith(".d.ts")
      const special = /^\+(middleware|config)\.(js|ts)$/.test(name)
      const priv = /(^|\/)_private\//.test(rel) && /\.(c)?js$/.test(name)
      if (!code && !special && !priv) return null
      // the root +middleware is the debugger's (it hands each page run to the recorder): locked, but replayed, since
      // it runs the app's own middleware (_private/middleware.ts). It has no function body, so it's never a step.
      const ours = /^\+middleware\.(js|ts)$/.test(rel)
      return { name: "pb_pages/" + rel, readonly: ours, replay: !name.startsWith("+config") }
    }, files)

    files.sort((a, b) => a.name.localeCompare(b.name))
    return ctx.res.json({ files, globals: __dbg.globals })
  },
}
