// Demo endpoint for the pb_pages spike: GET /demo/notes?q=milk
module.exports = {
  get(ctx) {
    const q = String(ctx.req.query("q") || "").trim()
    const notes = ctx.app.findRecordsByFilter("notes", "text ~ {:q}", "", 5, 0, { q })
    const texts = []
    for (const n of notes) texts.push(n.get("text"))
    return ctx.res.json(200, { q, count: texts.length, texts })
  },
}
