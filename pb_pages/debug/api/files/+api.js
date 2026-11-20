// GET /debug/api/files: every file under pb_hooks with its source ({ name, source, readonly, replay }).
// readonly: the debugger's own files. replay: whether the browser can run it (CommonJS .js for now).
const SEGMENT = /^[\w\-][\w.\-]*$/

module.exports = {
  get(ctx) {
    const root = globalThis.__hooks || ctx.app.dataDir() + "/../pb_hooks"
    const files = []
    const walk = (dir, prefix, depth) => {
      if (depth > 8) return
      for (const entry of $os.readDir(dir)) {
        const name = entry.name()
        if (!SEGMENT.test(name) || name === "node_modules" || name.startsWith("_ph_")) continue
        if (entry.isDir()) walk(dir + "/" + name, prefix + name + "/", depth + 1)
        else if (/\.(c|m)?(j|t)s$/.test(name) && !name.endsWith(".d.ts")) {
          const rel = prefix + name
          files.push({
            name: rel,
            source: toString($os.readFile(dir + "/" + name)),
            readonly: __dbg.self.indexOf(rel) !== -1,
            replay: /\.(c)?js$/.test(name),
          })
        }
      }
    }
    walk(root, "", 0)
    files.sort((a, b) => a.name.localeCompare(b.name))
    return ctx.res.json({ files, globals: __dbg.globals })
  },
}
