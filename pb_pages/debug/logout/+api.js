module.exports = {
  post(ctx) {
    ctx.res.clearCookie("dbg_auth", { path: "/debug" })
    return ctx.res.redirect("/debug/login")
  },
}
