// Hooks Debugger v2: everything under /debug is for superusers only. The page signs in with its own cookie
// (dbg_auth, set by /debug/login, path /debug), so it needs nothing from the app's own pb_pages (+config.js,
// auth plugin, layouts). An Authorization header (e.g. curl) works too.
module.exports = (ctx, next) => {
  ctx.res.layout(false) // the app's own +layout.ejs doesn't wrap the debugger
  ctx.res.header("Cache-Control", "no-store")
  const path = ctx.req.url.pathname
  if (path.startsWith("/debug/login")) return next()

  let user = ctx.auth
  const token = ctx.req.cookie("dbg_auth")
  if (!user && token) {
    try {
      user = ctx.app.findAuthRecordByToken(token, "auth")
    } catch (_) {}
  }
  if (!user || !user.isSuperuser()) {
    if (path.startsWith("/debug/api/")) return ctx.res.json(401, { message: "Sign in as a superuser." })
    return ctx.res.redirect("/debug/login")
  }
  if (!globalThis.__dbg) {
    const msg = "The recorder isn't loaded: copy pb_hooks/00_dbg.pb.js next to your other hook files."
    if (path.startsWith("/debug/api/")) return ctx.res.json(503, { message: msg })
    return ctx.res.text(503, msg)
  }
  ctx.data.user = user
  return next()
}
