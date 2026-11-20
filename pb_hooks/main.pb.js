/// <reference path="../types.d.ts" />

routerAdd("GET", "/api/hello/{name}", (e) => {
  const name = e.request.pathValue("name")
  const greet = require(`${__hooks}/lib/greet.js`).greet
  const greeting = greet(name)
  const superusers = e.app.countRecords("_superusers")
  return e.json(200, { greeting, superusers })
})

routerAdd("POST", "/api/notes", (e) => {
  const body = e.requestInfo().body
  const text = String(body.text || "").trim()
  if (!text) {
    return e.json(400, { error: "text is required" })
  }
  const notes = $app.findCollectionByNameOrId("notes")
  const record = new Record(notes)
  record.set("text", text)
  $app.save(record)
  const total = $app.countRecords("notes")
  return e.json(201, { id: record.id, text: record.get("text"), total, at: Date.now() })
})

routerAdd("GET", "/api/notes/summary", (e) => {
  const records = $app.findRecordsByFilter("notes", "text != ''", "-id", 3, 0)
  const words = []
  for (const r of records) {
    words.push(r.get("text"))
  }
  const token = $security.randomString(6)
  return e.json(200, { count: records.length, words, token })
})

// runs inside $app.save(): a recording inside a recording
onRecordCreate((e) => {
  const text = e.record.get("text")
  e.record.set("text", text.charAt(0).toUpperCase() + text.slice(1))
  return e.next()
}, "notes")
