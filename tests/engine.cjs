// Replays every recording of the local test app with pb_pages/debug/_private/replay.js, in Node:
//   EMAIL=<superuser> PASSWORD=<password> ACORN=<path to acorn> node tests/engine.cjs
// For each: the trace (every executed line), then the variables and an expression at one step.
const fs = require("fs"), vm = require("vm")
globalThis.acorn = require(process.env.ACORN || "acorn")
vm.runInThisContext(fs.readFileSync(__dirname + "/../pb_pages/debug/_private/replay.js", "utf8"), { filename: "replay.js" })
const U = process.env.URL || "http://127.0.0.1:8094"
;(async () => {
  const login = await fetch(U + "/debug/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ email: process.env.EMAIL, password: process.env.PASSWORD }) })
  const cookie = login.headers.get("set-cookie").split(";")[0]
  const get = async (p) => (await fetch(U + p, { headers: { Cookie: cookie } })).json()
  const { files: list, globals } = await get("/debug/api/files")
  const files = Object.fromEntries(list.filter((f) => f.replay && !f.readonly).map((f) => [f.name, f.source]))
  for (const sum of (await get("/debug/api/recordings")).reverse()) {
    const rec = await get("/debug/api/recordings?id=" + sum.id)
    const res = await DbgReplay.run(files, rec, { globals, trace: true })
    console.log(`\n#${rec.id} ${rec.title} ${rec.path || ""}: ${res.same ? "same as on the server" : "DIFFERS"}, ${res.steps.length} steps, ${res.used.length}/${rec.log.length} answers` + (res.error ? `, error: ${res.error}` : ""))
    console.log("   lines:", res.steps.map((s) => `${s.file.replace(/.*\//, "")}:${s.line}${"·".repeat(s.depth - 1)}`).join(" "))
    if (res.response.length) console.log("   response:", res.response.join(" "))
    const at = Math.max(1, res.steps.length - 1)
    const look = (await DbgReplay.run(files, rec, { globals, stopAt: at, exprs: process.env.EXPR ? [process.env.EXPR] : ["e.request.url.path"] })).inspect
    const s = res.steps[at - 1]
    console.log(`   at step ${at} (${s.file}:${s.line}), stack: ${look.stack.map((f) => `${f.ctx} @${f.line}`).join(" ← ")}`)
    for (const [k, v] of Object.entries(look.locals)) console.log(`     ${k}: ${v.type} = ${JSON.stringify(v.value).slice(0, 110)}`)
    console.log(`     eval → ${JSON.stringify(look.evals[0]).slice(0, 120)}  (answers used so far: ${look.used.length})`)
  }
})()
