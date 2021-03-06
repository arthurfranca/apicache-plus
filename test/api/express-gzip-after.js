var express = require('express')
var compression = require('compression')
var addRoutes = require('./lib/routes')

function MockAPI(expiration, options, toggle, localOptions) {
  var apicache = require('../../src/apicache').newInstance(options)
  var app = express()

  // EMBED UPSTREAM RESPONSE PARAM
  app.use(function(req, res, next) {
    res.id = 123
    next()
  })

  // ENABLE APICACHE
  app.use(apicache.middleware(expiration, toggle, localOptions))
  app.apicache = apicache

  // ENABLE COMPRESSION
  app.use(compression({ threshold: 1 }))

  // ADD API ROUTES
  app = addRoutes(app)

  return app
}

module.exports = {
  create: function(expiration, config, toggle, extraConfig) {
    return new MockAPI(expiration, config, toggle, extraConfig)
  },
}
