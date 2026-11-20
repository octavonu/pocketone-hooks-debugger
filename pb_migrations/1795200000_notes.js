migrate((app) => {
  const notes = new Collection({
    name: "notes",
    type: "base",
    listRule: "",
    viewRule: "",
    fields: [{ name: "text", type: "text", required: true }],
  })
  app.save(notes)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("notes"))
})
