// Superuser sign-in for the debugger: sets dbg_auth (HttpOnly, path /debug).
module.exports = {
  post(ctx) {
    const { email, password } = ctx.req.body()
    try {
      const user = ctx.app.findAuthRecordByEmail("_superusers", String(email || ""))
      if (!user.validatePassword(String(password || ""))) throw new Error("wrong password")
      ctx.res.cookie("dbg_auth", user.newAuthToken(), { path: "/debug", sameSite: "Strict", maxAge: 7 * 24 * 3600 })
      return ctx.res.redirect("/debug/")
    } catch (_) {
      return { error: "Wrong email or password.", email: String(email || "") }
    }
  },
}
