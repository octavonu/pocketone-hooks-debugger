// /debug/api/suggest: example requests for a route, written by a language model of the app ($llm, the llm
// extension: the providers and keys are in Settings → LLM).
//
// GET                         the text models (status.models, "provider/model") and the routes (from the recorder).
// POST { route: i, model }    sends the route's hook file (and the files it requires) to that model, in the
//                             background, so the page can show the time while it waits. Returns { job }.
// GET ?job=id                 { done, examples, error }.
//
// The model's answer is untrusted: the page checks every example (paths on this server only) and saves only the
// ones you pick. Nothing is saved here, and nothing is sent anywhere but to the model you pick, through the providers
// the app is set up with. Each call counts for the signed-in superuser ($llm.for(ctx)), so Settings → LLM limits apply.
const SEGMENT = /^[\w\-][\w.\-]*$/
const MAX_SOURCE = 24000 // characters of code sent, in all
const HOW_MANY = 6
const jobs = (globalThis.__dbgSuggestJobs = globalThis.__dbgSuggestJobs || new Map())

const SCHEMA = {
  type: "object",
  properties: {
    examples: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string" },
          body: { type: "string" },
          superuser: { type: "boolean" },
        },
        required: ["name", "method", "path", "body", "superuser"],
      },
    },
  },
  required: ["examples"],
}

// "provider/model" for a call; a listed id may or may not start with its provider already
function modelName(m) {
  return m.provider && !String(m.id).startsWith(m.provider + "/") ? m.provider + "/" + m.id : String(m.id)
}

// The text models of the providers in Settings → LLM, those that promise "structured output" (JSON in a schema)
// first. { ready, models: [{ name, title }], message }
async function modelStatus() {
  if (typeof $llm === "undefined") return { ready: false, models: [], message: "This PocketOne has no $llm (the llm extension)." }
  try {
    const list = (await $llm.text.modelsAsync({ signal: AbortSignal.timeout(15000) })).models || []
    const json = (m) => (m.features || []).includes("structured output")
    const models = list
      .filter((m) => !m.kinds || m.kinds.includes("text"))
      .sort((a, b) => json(b) - json(a))
      .map((m) => ({ name: modelName(m), title: m.name || "", json: json(m) }))
    if (!models.length) return { ready: false, models, message: "add a provider with text models in Settings → LLM." }
    return { ready: true, models, message: "" }
  } catch (err) {
    return { ready: false, models: [], message: String((err && err.message) || err) }
  }
}

function hooksRoot(ctx) {
  return globalThis.__hooks || ctx.app.dataDir() + "/../pb_hooks"
}

// a file under pb_hooks by its relative name, or null (no "..", no odd names)
function readHook(root, rel) {
  if (!rel || !rel.split("/").every((p) => SEGMENT.test(p))) return null
  try {
    return toString($os.readFile(root + "/" + rel))
  } catch (_) {
    return null
  }
}

// the hook files a file requires: require(`${__hooks}/lib/x.js`) or require("./lib/x.js")
function requiredFiles(rel, source) {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : ""
  const out = []
  const re = /require\(\s*[`'"]([^`'"]+\.js)[`'"]\s*\)/g
  let m
  while ((m = re.exec(source))) {
    let p = m[1]
    if (p.startsWith("${__hooks}/")) p = p.slice("${__hooks}/".length)
    else if (p.startsWith("./")) p = dir + p.slice(2)
    else continue
    if (!out.includes(p)) out.push(p)
  }
  return out
}

function prompt(route, files) {
  let code = ""
  for (const f of files) {
    const left = MAX_SOURCE - code.length
    if (left <= 200) break
    const src = f.source.length > left ? f.source.slice(0, left) + "\n// … (cut)" : f.source
    code += `=== pb_hooks/${f.name} ===\n${src}\n\n`
  }
  return [
    `The route: ${route.method} ${route.pattern}, registered in pb_hooks/${route.file} at line ${route.line}.`,
    "",
    `Suggest ${HOW_MANY} example requests to debug this route's handler: the normal case first, then each error`,
    "case the code checks, then edge cases (missing, empty, wrong type, very long, special characters).",
    "For each one:",
    '- name: short, says what it tests and the expected status, e.g. "empty text gives 400".',
    `- method: "${route.method}".`,
    "- path: starts with /. Replace path parameters like {name} with example values. Add a query string if the",
    "  code reads one.",
    '- body: the JSON request body as text, or "" for none.',
    "- superuser: true only if the code needs a superuser (e.g. e.auth.isSuperuser()).",
    "",
    "The code:",
    "",
    code,
  ].join("\n")
}

module.exports = {
  get(ctx) {
    const id = ctx.req.query("job")
    if (id) {
      const job = jobs.get(id)
      if (!job) return ctx.res.json(404, { message: "No such question (a restart clears them)." })
      return ctx.res.json({ done: job.done, examples: job.examples, error: job.error, model: job.model })
    }
    return modelStatus().then((status) => ctx.res.json({ status, routes: __dbg.routes() }))
  },

  async post(ctx) {
    const { route: i, model } = ctx.req.body()
    const route = __dbg.routes()[Number(i)]
    if (!route || !route.file) return ctx.res.json(400, { message: "No such route." })
    const status = await modelStatus()
    if (!status.ready) return ctx.res.json(503, { message: "No language model: " + status.message })
    if (!status.models.some((m) => m.name === model)) return ctx.res.json(400, { message: "Pick one of the app's text models." })

    const root = hooksRoot(ctx)
    const main = readHook(root, route.file)
    if (main == null) return ctx.res.json(400, { message: "Can't read pb_hooks/" + route.file })
    const files = [{ name: route.file, source: main }]
    for (const rel of requiredFiles(route.file, main)) {
      const src = readHook(root, rel)
      if (src != null) files.push({ name: rel, source: src })
    }

    // old questions go after 10 minutes
    const now = Date.now()
    for (const [k, j] of jobs) if (now - j.at > 10 * 60 * 1000) jobs.delete(k)

    const id = $security.randomString(16)
    const job = { at: now, done: false, examples: null, error: null, model }
    jobs.set(id, job)
    $llm
      .for(ctx)
      .text.completeAsync({
        model,
        system:
          "You help a developer debug the JavaScript route handlers of a PocketBase / PocketOne app (pb_hooks). " +
          "You suggest example HTTP requests that make a handler take each of its paths. Answer only with the JSON asked for.",
        prompt: prompt(route, files),
        schema: SCHEMA,
        maxTokens: 1500,
        temperature: 0.3,
        signal: AbortSignal.timeout(120000),
      })
      .then(
        (answer) => {
          const list = answer && answer.data && answer.data.examples
          if (Array.isArray(list)) job.examples = list.slice(0, 20)
          else job.error = "The model's answer had no list of examples."
          job.done = true
        },
        (err) => {
          job.error = String(err)
          job.done = true
        },
      )
    return ctx.res.json({ job: id, files: files.map((f) => f.name), model: job.model })
  },
}
