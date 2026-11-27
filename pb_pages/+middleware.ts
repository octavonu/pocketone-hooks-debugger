// Hooks Debugger: runs first, for every page and endpoint in pb_pages. While a debugger tab is open, it records
// each page run (the middleware included), so it can be replayed and stepped through. Without the debugger, the
// middleware runs as it is. Your own middleware code goes in _private/middleware.ts.
import middleware from "./_private/middleware"

export default typeof __dbg === "object" ? __dbg.page(middleware) : middleware
