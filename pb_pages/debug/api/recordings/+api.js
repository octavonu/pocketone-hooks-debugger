// GET /debug/api/recordings: the list (newest first); ?id=N: one recording with its log. DELETE: clear them.
module.exports = {
  get(ctx) {
    const id = ctx.req.query("id")
    if (id) {
      const rec = __dbg.get(id)
      return rec ? ctx.res.json(rec) : ctx.res.json(404, { message: "No such recording (a restart clears them)." })
    }
    return ctx.res.json(__dbg.list())
  },
  delete(ctx) {
    __dbg.clear()
    return ctx.res.json({ ok: true })
  },
}
