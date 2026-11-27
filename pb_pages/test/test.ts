// The code of the page /test/test (its template is test.ejs): GET /test/test?name=Ana
export function load(ctx) {
  const name = String(ctx.req.query("name") || "world").trim()
  const notes = ctx.app.countRecords("notes")
  const greeting = notes > 0 ? `Hello, ${name}! There are ${notes} notes.` : `Hello, ${name}! No notes yet.`
  return { name, notes, greeting }
}
