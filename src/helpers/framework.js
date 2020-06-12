function isKoa(ctx) {
  return ctx && typeof ctx === 'object' && ctx.request && ctx.response && ctx.req && ctx.res
}

module.exports = {
  isKoa: isKoa,
}
