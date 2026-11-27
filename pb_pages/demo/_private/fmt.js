// A pb_pages module, found by a bare name from pb_pages/demo/ (Pages looks in _private/ folders)
module.exports = {
  title(s) {
    const t = String(s).trim()
    return t.charAt(0).toUpperCase() + t.slice(1)
  },
}
