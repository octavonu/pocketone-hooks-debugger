// Demo endpoint with ES module syntax, load + get: GET /demo/summary?t=my notes
import { title } from "fmt"

export function load(ctx) {
  const count = ctx.app.countRecords("notes")
  return { count }
}

export function get(ctx) {
  const name = title(ctx.req.query("t") || "notes")
  const ms = Date.now() - ctx.data.started
  return ctx.res.json(200, { name, count: ctx.data.count, ms })
}
