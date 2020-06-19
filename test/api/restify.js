var restify = require('restify')
var addRoutes = require('./lib/routes')

function MockAPI(expiration, options, toggle, localOptions) {
  var apicache = require('../../src/apicache').newInstance(options)
  var app = restify.createServer()

  // EMBED UPSTREAM RESPONSE PARAM
  app.use(function(req, res, next) {
    res.id = 123
    next()
  })

  // ENABLE APICACHE
  app.use(apicache.middleware(expiration, toggle, localOptions))
  app.apicache = apicache

  app.use(function(req, res, next) {
    res.charSet('utf-8')
    next()
  })

  app.use(require('restify-etag-cache')())

  // mimic express behavior of auto responding to .head requests
  var _get = app.get
  app.get = function() {
    app.head.apply(this, arguments)
    return _get.apply(this, arguments)
  }
  app.get.restoreDefaultBehavior = function() {
    app.get = _get
  }
  // ADD API ROUTES
  app = addRoutes(app)

  return app
}

module.exports = {
  create: function(expiration, config, toggle, extraConfig) {
    return new MockAPI(expiration, config, toggle, extraConfig)
  },
}
