var Koa = require('koa')
var Router = require('@koa/router')
var addRoutes = require('./lib/koa-routes')
var compress = require('koa-compress')
var conditional = require('koa-conditional-get')
var etag = require('koa-etag')
var delegate = require('../../src/helpers').delegate

function MockAPI(expiration, options, toggle, localOptions) {
  var apicache = require('../../src/apicache').newInstance(options)
  var app = new Koa()
  var router = new Router()

  // EMBED UPSTREAM RESPONSE PARAM
  app.use(function(ctx, next) {
    ctx.set('x-powered-by', 'tj')
    ctx.state.id = 123
    return next()
  })

  // ENABLE COMPRESSION
  app.use(compress({ threshold: 1 }))

  // ENABLE APICACHE
  app.use(apicache.middleware(expiration, toggle, localOptions))
  router.apicache = apicache

  app.use(conditional())
  app.use(etag())

  // ADD API ROUTES
  router = addRoutes(router)
  app.use(router.routes()).use(router.allowedMethods())

  // ADD ROUTE METHODS TO APP
  delegate(app, router)

  // PREPARE FOR SUPERTEST
  app.address = function() {}
  var _listen = app.listen
  app.listen = function() {
    var ret = _listen.apply(this, arguments)
    delete this.address
    // don't trigger deprecated prop
    delegate(app, ret, { exclude: ['connections'] })

    return ret
  }

  return app
}

module.exports = {
  create: function(expiration, config, toggle, extraConfig) {
    return new MockAPI(expiration, config, toggle, extraConfig)
  },
}
