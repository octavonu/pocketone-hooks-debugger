// POST /debug/api/presence { tab, token, all, bye }: a debugger tab's heartbeat. Recording runs only while a tab is
// open; with all: false, only for this tab's requests (the dbg cookie or X-Dbg header) and superusers'.
module.exports = {
  post(ctx) {
    const { tab, token, all, bye } = ctx.req.body()
    return ctx.res.json(__dbg.presence(tab, token, all, bye))
  },
}
