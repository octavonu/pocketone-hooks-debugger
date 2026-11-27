// The app's own middleware for every page and endpoint in pb_pages (pb_pages/+middleware.ts runs it).
export default function middleware(ctx, next) {
  ctx.res.header("X-Demo", "yes")
  ctx.data.started = Date.now()
  return next()
}
