/* eslint-disable no-unused-expressions */
var chai = require('chai')
var expect = chai.expect
var express = require('express')
var request = require('supertest')
var pkg = require('../package.json')
var movies = require('./api/lib/data.json')
var redis = require('ioredis-mock')
var apicache = require('../src/apicache')
var helpers = require('../src/helpers')
var isKoa = helpers.isKoa

// node-redis usage
redis.createClient = function(options) {
  if (options.prefix) options.keyPrefix = options.prefix
  var client = new this(options)
  // patch append to work with buffers and add missing getrangeBuffer
  var multi = client.multi()
  client.multi = function() {
    return multi
  }
  var multiAppend = multi.append.bind(multi)
  multi.append = function(key, value) {
    if (!Buffer.isBuffer(value)) return multiAppend(key, value)

    var memo = client.data.get(key) || Buffer.alloc(0)
    value = Buffer.from(value, 'utf8') // ioredis-mock stores buffers as utf-8
    client.data.set(key, Buffer.concat([memo, value]))
  }
  client.getrangeBuffer = client.getrange
  return client
}

// unexpected order
var revertedCompressionApis = [
  { name: 'express+gzip (after)', server: require('./api/express-gzip-after') },
  { name: 'restify+gzip (after)', server: require('./api/restify-gzip-after') },
  // as we currently don't manipulate ctx.body (we patch res.write/end),
  // this regular one acts like a reverted compression api (apicache will receive an already compressed stream)
  { name: 'koa+compression (after)', server: require('./api/koa-compression') },
]
var compressionApis = [
  { name: 'express+gzip', server: require('./api/express-gzip') },
  { name: 'restify+gzip', server: require('./api/restify-gzip') },
  { name: 'koa+compression', server: require('./api/koa-compression') },
]
var regularApis = [
  { name: 'express', server: require('./api/express') },
  { name: 'restify', server: require('./api/restify') },
  { name: 'koa', server: require('./api/koa') },
]
var apis = regularApis.concat(compressionApis)

function assertNumRequestsProcessed(app, n) {
  return function() {
    expect(app.requestsProcessed).to.equal(n)
  }
}

var _setTimeout = global.setTimeout
var timeouts = []
global.setTimeout = function() {
  var timeout = _setTimeout.apply(null, arguments)
  timeouts.push(timeout)
  return timeout
}

function clearAllTimeouts(cb) {
  while (timeouts.length) clearTimeout(timeouts.pop())
  cb()
}

afterEach(function(done) {
  clearAllTimeouts(done)
})

describe('.options(opt?) {GETTER/SETTER}', function() {
  var apicache = require('../src/apicache')

  it('is a function', function() {
    expect(typeof apicache.options).to.equal('function')
  })

  describe('.options() {GETTER}', function() {
    it('returns global options as object', function() {
      expect(typeof apicache.options()).to.equal('object')
    })
  })

  describe('.options(opt) {SETTER}', function() {
    it('is chainable', function() {
      expect(apicache.options({})).to.equal(apicache)
    })

    it('extends defaults', function() {
      expect(apicache.options({ foo: 'bar' }).options().foo).to.equal('bar')
    })

    it('allows overrides of defaults', function() {
      var newDuration = 11

      expect(apicache.options()).to.have.property('defaultDuration')
      expect(apicache.options({ defaultDuration: newDuration }).options().defaultDuration).to.equal(
        newDuration
      )
    })
  })
})

describe('.getDuration(stringOrNumber) {GETTER}', function() {
  var apicache = require('../src/apicache')

  it('is a function', function() {
    expect(typeof apicache.getDuration).to.equal('function')
  })

  it('returns value unchanged if numeric', function() {
    expect(apicache.getDuration(77)).to.equal(77)
  })

  it('returns default duration when uncertain', function() {
    apicache.options({ defaultDuration: 999 })
    expect(apicache.getDuration(undefined)).to.equal(999)
  })

  it('accepts singular or plural (e.g. "1 hour", "3 hours")', function() {
    expect(apicache.getDuration('3 seconds')).to.equal(3000)
    expect(apicache.getDuration('3 second')).to.equal(3000)
  })

  it('accepts decimals (e.g. "1.5 hours")', function() {
    expect(apicache.getDuration('1.5 seconds')).to.equal(1500)
  })

  describe('unit support', function() {
    it('numeric values as milliseconds', function() {
      expect(apicache.getDuration(43)).to.equal(43)
    })
    it('milliseconds', function() {
      expect(apicache.getDuration('3 ms')).to.equal(3)
    })
    it('seconds', function() {
      expect(apicache.getDuration('3 seconds')).to.equal(3000)
    })
    it('minutes', function() {
      expect(apicache.getDuration('4 minutes')).to.equal(1000 * 60 * 4)
    })
    it('hours', function() {
      expect(apicache.getDuration('2 hours')).to.equal(1000 * 60 * 60 * 2)
    })
    it('days', function() {
      expect(apicache.getDuration('3 days')).to.equal(1000 * 60 * 60 * 24 * 3)
    })
    it('weeks', function() {
      expect(apicache.getDuration('5 weeks')).to.equal(1000 * 60 * 60 * 24 * 7 * 5)
    })
    it('months', function() {
      expect(apicache.getDuration('6 months')).to.equal(1000 * 60 * 60 * 24 * 30 * 6)
    })
    it('years', function() {
      expect(apicache.getDuration('3 years')).to.equal(1000 * 60 * 60 * 24 * 365 * 3)
    })
  })
})

describe('.getPerformance()', function() {
  var apicache = require('../src/apicache')

  it('is a function', function() {
    expect(typeof apicache.getPerformance).to.equal('function')
  })

  it('returns an array', function() {
    expect(Array.isArray(apicache.getPerformance())).to.be.true
  })

  it('returns a null hit rate if the api has not been called', function() {
    var api = require('./api/express')
    var app = api.create('10 seconds', { trackPerformance: true })
    expect(app.apicache.getPerformance()[0]).to.deep.equal({
      callCount: 0,
      hitCount: 0,
      missCount: 0,
      hitRate: null,
      hitRateLast100: null,
      hitRateLast1000: null,
      hitRateLast10000: null,
      hitRateLast100000: null,
      lastCacheHit: null,
      lastCacheMiss: null,
    })
  })

  it('returns a 0 hit rate if the api has been called once', function() {
    var api = require('./api/express')
    var app = api.create('10 seconds', { trackPerformance: true })

    return request(app)
      .get('/api/movies')
      .then(function(res) {
        expect(app.apicache.getPerformance()[0]).to.deep.equal({
          callCount: 1,
          hitCount: 0,
          missCount: 1,
          hitRate: 0,
          hitRateLast100: 0,
          hitRateLast1000: 0,
          hitRateLast10000: 0,
          hitRateLast100000: 0,
          lastCacheHit: null,
          lastCacheMiss: app.apicache.getKey({ method: 'get', url: '/api/movies' }),
        })
      })
  })

  it('returns a 0.5 hit rate if the api has been called twice', function() {
    var api = require('./api/express')
    var app = api.create('10 seconds', { trackPerformance: true })
    var requests = []
    for (var i = 0; i < 2; i++) {
      requests.push(request(app).get('/api/movies'))
    }
    return Promise.all(requests).then(function(res) {
      expect(app.apicache.getPerformance()[0]).to.deep.equal({
        callCount: 2,
        hitCount: 1,
        missCount: 1,
        hitRate: 0.5,
        hitRateLast100: 0.5,
        hitRateLast1000: 0.5,
        hitRateLast10000: 0.5,
        hitRateLast100000: 0.5,
        lastCacheHit: app.apicache.getKey({ method: 'get', url: '/api/movies' }),
        lastCacheMiss: app.apicache.getKey({ method: 'get', url: '/api/movies' }),
      })
    })
  })
})

describe('.getIndex([groupName]) {GETTER}', function() {
  var apicache = require('../src/apicache')

  it('is a function', function() {
    expect(typeof apicache.getIndex).to.equal('function')
  })

  it('returns an object', function() {
    expect(typeof apicache.getIndex()).to.equal('object')
  })

  it('can clear indexed cache groups', function() {
    var api = require('./api/express')
    var app = api.create('10 seconds')

    return request(app)
      .get('/api/testcachegroup')
      .then(function(res) {
        expect(app.apicache.getIndex('cachegroup').length).to.equal(1)
      })
  })
})

describe('.resetIndex() {SETTER}', function() {
  var apicache = require('../src/apicache')

  it('is a function', function() {
    expect(typeof apicache.resetIndex).to.equal('function')
  })
})

describe('.middleware {MIDDLEWARE}', function() {
  it('is a function', function() {
    var apicache = require('../src/apicache')
    expect(typeof apicache.middleware).to.equal('function')
    expect(apicache.middleware.length).to.equal(3)
  })

  it('returns the middleware function', function() {
    var middleware = require('../src/apicache').middleware('10 seconds')
    expect(typeof middleware).to.equal('function')
    expect(middleware.length).to.equal(3)
  })

  it('can be called by a shortcut', function() {
    var apicache = require('../src/apicache')
    var middleware = apicache('10 seconds')
    expect(typeof middleware).to.equal('function')
    expect(middleware.length).to.equal(3)
  })

  describe('signature', function() {
    var apicache = require('../src/apicache').newInstance()

    ;[
      {
        name: 'regular function',
        fn: apicache.middleware.bind(apicache),
      },
      {
        name: 'shortcut function',
        fn: apicache,
      },
    ].forEach(function(fnConfig) {
      describe(`of ${fnConfig.name}`, function() {
        var middlewareFn = fnConfig.fn

        it('Apicache#middleware(localOptions)', function() {
          var middleware = middlewareFn({ defaultDuration: 1 })
          expect(middleware.options().defaultDuration).to.equal(1)
        })

        it('Apicache#middleware(middlewareToggle, localOptions)', function() {
          var middlewareToggleCallCount = 0
          var middleware = apicache(
            function() {
              middlewareToggleCallCount++
              return false
            },
            { defaultDuration: 1000 }
          )
          var app = express()
            .use(middleware)
            .get('/api/signature', function(_req, res) {
              app.requestsProcessed++
              if (isKoa(_req)) return (_req.body = null)
              res.end()
            })
          app.requestsProcessed = 0

          return request(app)
            .get('/api/signature')
            .expect(200)
            .then(function() {
              return request(app)
                .get('/api/signature')
                .expect(200)
                .then(function() {
                  expect(middlewareToggleCallCount).to.equal(2)
                  expect(app.requestsProcessed).to.equal(2)
                  expect(middleware.options().defaultDuration).to.equal(1000)
                })
            })
        })

        it('Apicache#middleware(duration, localOptions)', function() {
          var middleware = apicache(40, { defaultDuration: 60000 })
          var app = express()
            .use(middleware)
            .get('/api/signature', function(_req, res) {
              app.requestsProcessed++
              if (isKoa(_req)) return (_req.body = null)
              res.end()
            })
          app.requestsProcessed = 0
          var key = apicache.getKey({ method: 'get', url: '/api/signature' })

          return request(app)
            .get('/api/signature')
            .expect(200)
            .then(function() {
              return request(app)
                .get('/api/signature')
                .expect(200)
                .then(function() {
                  expect(app.requestsProcessed).to.equal(1)
                  expect(middleware.options().defaultDuration).to.equal(60000)
                  return apicache.has(key)
                })
                .then(function(hasValue) {
                  expect(hasValue).to.equal(true)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      resolve(apicache.has(key))
                    }, 40)
                  })
                })
                .then(function(hasValue) {
                  expect(hasValue).to.equal(false)
                })
            })
        })

        it('Apicache#middleware(duration, middlewareToggle, localOptions)', function() {
          var middlewareToggleCallCount = 0
          var middleware = apicache(
            40,
            function() {
              middlewareToggleCallCount++
              return true
            },
            { defaultDuration: 60000 }
          )
          var app = express()
            .use(middleware)
            .get('/api/signature', function(_req, res) {
              app.requestsProcessed++
              if (isKoa(_req)) return (_req.body = null)
              res.end()
            })
          app.requestsProcessed = 0
          var key = apicache.getKey({ method: 'get', url: '/api/signature' })

          return request(app)
            .get('/api/signature')
            .expect(200)
            .then(function() {
              return request(app)
                .get('/api/signature')
                .expect(200)
                .then(function() {
                  expect(middlewareToggleCallCount).to.equal(2)
                  expect(app.requestsProcessed).to.equal(1)
                  expect(middleware.options().defaultDuration).to.equal(60000)
                  return apicache.has(key)
                })
                .then(function(hasValue) {
                  expect(hasValue).to.equal(true)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      resolve(apicache.has(key))
                    }, 40)
                  })
                })
                .then(function(hasValue) {
                  expect(hasValue).to.equal(false)
                })
            })
        })
      })
    })
  })

  describe('get key name from request properties', function() {
    describe('when parts are complete', function() {
      beforeEach(function() {
        this.cache = require('../src/apicache').newInstance()
        this.app = express()
        this.app.requestsProcessed = 0
        this.app.get(
          '/api/getkey',
          function(req, _res, next) {
            if (isKoa(req)) next = _res

            req.query = { a: 1, b: [2] }
            req.body = { a: 3, c: 'hi' }
            next()
          },
          this.cache('2 seconds', null, {
            append: function(req) {
              return req.query.a * 10
            },
          }),
          function(req, res) {
            this.app.requestsProcessed++
            if (isKoa(req)) return (req.body = movies)
            res.json(movies)
          }.bind(this)
        )
      })

      afterEach(function() {
        this.app.requestsProcessed = 0
      })

      it('cache with name from parts (with sorted params)', function() {
        var that = this
        var keyParts = {
          method: 'GET',
          url: '/api/getkey',
          params: { a: 3, b: [2], c: 'hi' },
          appendice: 10,
        }
        var key = this.cache.getKey(keyParts)
        expect(key).to.equal('get/api/getkey{"a":3,"b":[2],"c":"hi"}10')

        return request(this.app)
          .get('/api/getkey')
          .expect(200, movies)
          .then(function() {
            expect(that.app.requestsProcessed).to.equal(1)
            return that.cache.get(key)
          })
          .then(function(value) {
            expect(value.status).to.equal(200)
            expect(value.headers['cache-control']).to.equal('private, max-age=2, must-revalidate')
            expect(value.data).to.eql(movies)
            return request(that.app)
              .get('/api/getkey')
              .expect(200, movies)
          })
          .then(function() {
            expect(that.app.requestsProcessed).to.equal(1)
          })
      })
    })

    describe('when parts are incomplete', function() {
      beforeEach(function() {
        this.cache = require('../src/apicache').newInstance()
        this.app = express()
        this.app.requestsProcessed = 0
        this.app.get(
          '/api/getkey',
          this.cache('2 seconds'),
          function(req, res) {
            this.app.requestsProcessed++
            if (isKoa(req)) return (req.body = movies)
            res.json(movies)
          }.bind(this)
        )
      })

      afterEach(function() {
        this.app.requestsProcessed = 0
      })

      it('return key name (keeping {} as separator)', function() {
        var that = this
        var keyParts = {
          method: 'GET',
          url: '/api/getkey',
        }
        var key = this.cache.getKey(keyParts)
        expect(this.cache.getKey(keyParts)).to.equal('get/api/getkey{}')

        return request(this.app)
          .get('/api/getkey')
          .expect(200, movies)
          .then(function() {
            expect(that.app.requestsProcessed).to.equal(1)
            return that.cache.get(key)
          })
          .then(function(value) {
            expect(value.status).to.equal(200)
            expect(value.headers['cache-control']).to.equal('max-age=2, must-revalidate')
            expect(value.data).to.eql(movies)
            return request(that.app)
              .get('/api/getkey')
              .expect(200, movies)
          })
          .then(function() {
            expect(that.app.requestsProcessed).to.equal(1)
          })
      })
    })

    describe('with options.interceptKeyParts', function() {
      beforeEach(function() {
        this.cache = require('../src/apicache').newInstance()
        this.app = express()
        this.app.requestsProcessed = 0
        this.app.post(
          '/api/getkeyinterception',
          this.cache(),
          function(req, res) {
            this.app.requestsProcessed++
            if (isKoa(req)) return (req.body = movies)
            res.json(movies)
          }.bind(this)
        )
      })

      afterEach(function() {
        this.app.requestsProcessed = 0
      })

      describe('returning new key parts', function() {
        beforeEach(function() {
          this.app.get(
            '/api/getkey',
            function(req, _res, next) {
              if (isKoa(req)) next = _res
              req.query = { a: 1, b: [2] }
              req.body = { a: 3, c: 'hi' }
              next()
            },
            this.cache('2 seconds', null, {
              append: function(req) {
                return req.query.a * 10
              },
              interceptKeyParts: function(req, res, parts) {
                return { method: 'POST', url: parts.url + 'interception' }
              },
            }),
            function(req, res) {
              this.app.requestsProcessed++
              if (isKoa(req)) return (req.body = movies)
              res.json(movies)
            }.bind(this)
          )
        })

        it('can use intercepted key parts', function() {
          var that = this
          var keyParts = {
            method: 'POST',
            url: '/api/getkeyinterception',
          }
          var key = this.cache.getKey(keyParts)
          expect(key).to.equal('post/api/getkeyinterception{}')

          return request(this.app)
            .get('/api/getkey')
            .expect('Cache-Control', 'private, max-age=2, must-revalidate')
            .expect(200, movies)
            .then(function() {
              expect(that.app.requestsProcessed).to.equal(1)
              return that.cache.get(key)
            })
            .then(function(value) {
              expect(value.status).to.equal(200)
              expect(value.headers['cache-control']).to.equal('private, max-age=2, must-revalidate')
              expect(value.data).to.eql(movies)
              return request(that.app)
                .post('/api/getkeyinterception')
                .expect('Cache-Control', 'no-store')
                .expect(200, movies)
            })
            .then(function() {
              expect(that.app.requestsProcessed).to.equal(1)
              return request(that.app)
                .get('/api/getkey')
                .expect('Cache-Control', 'private, max-age=2, must-revalidate')
                .expect(200, movies)
            })
            .then(function(value) {
              expect(that.app.requestsProcessed).to.equal(1)
            })
        })
      })

      describe('mutating key parts', function() {
        beforeEach(function() {
          this.app.get(
            '/api/getkey',
            function(req, _res, next) {
              if (isKoa(req)) next = _res
              req.query = { a: 1, b: [2] }
              req.body = { a: 3, c: 'hi' }
              next()
            },
            this.cache('2 seconds', null, {
              append: function(req) {
                return req.query.a * 10
              },
              interceptKeyParts: function(req, res, parts) {
                parts.method = 'post'
                parts.url = parts.url + 'interception'
                parts.params = null
                delete parts.appendice
              },
            }),
            function(req, res) {
              this.app.requestsProcessed++
              if (isKoa(req)) return (req.body = movies)
              res.json(movies)
            }.bind(this)
          )
        })

        it('can use intercepted key parts', function() {
          var that = this
          var keyParts = {
            method: 'post',
            url: '/api/getkeyinterception',
          }
          var key = this.cache.getKey(keyParts)
          expect(key).to.equal('post/api/getkeyinterception{}')

          return request(this.app)
            .get('/api/getkey')
            .expect('Cache-Control', 'private, max-age=2, must-revalidate')
            .expect(200, movies)
            .then(function() {
              expect(that.app.requestsProcessed).to.equal(1)
              return that.cache.get(key)
            })
            .then(function(value) {
              expect(value.status).to.equal(200)
              expect(value.headers['cache-control']).to.equal('private, max-age=2, must-revalidate')
              expect(value.data).to.eql(movies)
              return request(that.app)
                .post('/api/getkeyinterception')
                .expect('Cache-Control', 'no-store')
                .expect(200, movies)
            })
            .then(function() {
              expect(that.app.requestsProcessed).to.equal(1)
              return request(that.app)
                .get('/api/getkey')
                .expect('Cache-Control', 'private, max-age=2, must-revalidate')
                .expect(200, movies)
            })
            .then(function(value) {
              expect(that.app.requestsProcessed).to.equal(1)
            })
        })
      })
    })
  })

  describe('options', function() {
    var apicache = require('../src/apicache').newInstance()

    it('uses global options if local ones not provided', function() {
      apicache.options({
        append: ['test'],
      })
      var middleware1 = apicache.middleware('10 seconds')
      var middleware2 = apicache.middleware('20 seconds')
      expect(middleware1.options()).to.eql({
        debug: false,
        defaultDuration: 3600000,
        enabled: true,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['test'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: [] },
        events: { expire: undefined },
        headers: {},
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
      expect(middleware2.options()).to.eql({
        debug: false,
        defaultDuration: 3600000,
        enabled: true,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['test'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: [] },
        events: { expire: undefined },
        headers: {},
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
    })

    it('uses local options if they provided', function() {
      apicache.options({
        append: ['test'],
      })
      function afterHit() {}
      var middleware1 = apicache.middleware('10 seconds', null, {
        debug: true,
        isBypassable: true,
        interceptKeyParts: null,
        defaultDuration: 7200000,
        append: ['bar'],
        statusCodes: { include: [], exclude: ['400'] },
        events: { expire: undefined },
        headers: {
          'cache-control': 'no-cache',
        },
        afterHit: afterHit,
      })
      var middleware2 = apicache.middleware('20 seconds', null, {
        debug: false,
        defaultDuration: 1800000,
        append: ['foo'],
        statusCodes: { include: [], exclude: ['200'] },
        events: { expire: undefined },
      })
      expect(middleware1.options()).to.eql({
        debug: true,
        defaultDuration: 7200000,
        enabled: true,
        isBypassable: true,
        interceptKeyParts: null,
        append: ['bar'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: ['400'] },
        events: { expire: undefined },
        headers: {
          'cache-control': 'no-cache',
        },
        shouldSyncExpiration: false,
        afterHit: afterHit,
        trackPerformance: false,
        optimizeDuration: false,
      })
      expect(middleware2.options()).to.eql({
        debug: false,
        defaultDuration: 1800000,
        enabled: true,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['foo'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: ['200'] },
        events: { expire: undefined },
        headers: {},
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
    })

    it('updates options if global ones changed', function() {
      apicache.options({
        debug: true,
        append: ['test'],
      })
      var middleware1 = apicache.middleware('10 seconds', null, {
        defaultDuration: 7200000,
        statusCodes: { include: [], exclude: ['400'] },
      })
      var middleware2 = apicache.middleware('20 seconds', null, {
        defaultDuration: 1800000,
        statusCodes: { include: [], exclude: ['200'] },
      })
      apicache.options({
        debug: false,
        append: ['foo'],
      })
      expect(middleware1.options()).to.eql({
        debug: false,
        defaultDuration: 7200000,
        enabled: true,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['foo'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: ['400'] },
        events: { expire: undefined },
        headers: {},
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
      expect(middleware2.options()).to.eql({
        debug: false,
        defaultDuration: 1800000,
        enabled: true,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['foo'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: ['200'] },
        events: { expire: undefined },
        headers: {},
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
    })

    it('updates options if local ones changed', function() {
      apicache.options({
        debug: true,
        append: ['test'],
      })
      var middleware1 = apicache.middleware('10 seconds', null, {
        defaultDuration: 7200000,
        statusCodes: { include: [], exclude: ['400'] },
      })
      var middleware2 = apicache.middleware('20 seconds', null, {
        defaultDuration: 900000,
        statusCodes: { include: [], exclude: ['404'] },
      })
      middleware1.options({
        debug: false,
        defaultDuration: 1800000,
        append: ['foo'],
        headers: {
          'cache-control': 'no-cache',
        },
      })
      middleware2.options({
        defaultDuration: 450000,
        enabled: false,
        append: ['foo'],
      })
      expect(middleware1.options()).to.eql({
        debug: false,
        defaultDuration: 1800000,
        enabled: true,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['foo'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: [] },
        events: { expire: undefined },
        headers: {
          'cache-control': 'no-cache',
        },
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
      expect(middleware2.options()).to.eql({
        debug: true,
        defaultDuration: 450000,
        enabled: false,
        isBypassable: false,
        interceptKeyParts: null,
        append: ['foo'],
        jsonp: false,
        redisClient: false,
        redisPrefix: '',
        headerBlacklist: [],
        statusCodes: { include: [], exclude: [] },
        events: { expire: undefined },
        headers: {},
        shouldSyncExpiration: false,
        afterHit: null,
        trackPerformance: false,
        optimizeDuration: false,
      })
    })
  })

  it('can change global defaultDuration at runtime', function() {
    apicache = apicache.newInstance()
    apicache.options({
      defaultDuration: '30 seconds',
    })
    var middleware = apicache.middleware()
    var app = express()
    app.get('/api/localduration', middleware, function(_req, res) {
      if (isKoa(_req)) return (_req.body = null)
      res.end()
    })
    apicache.options({
      defaultDuration: '20 seconds',
    })

    return request(app)
      .get('/api/localduration')
      .expect(200)
      .expect('Cache-Control', 'max-age=20, must-revalidate')
  })

  it('can change local defaultDuration at runtime', function() {
    var middleware = apicache.newInstance().middleware(null, null, { defaultDuration: '2 seconds' })
    var app = express()
    app.get('/api/localduration', middleware, function(_req, res) {
      if (isKoa(_req)) return (_req.body = null)
      res.end()
    })
    middleware.options({
      defaultDuration: '10 seconds',
    })

    return request(app)
      .get('/api/localduration')
      .expect(200)
      .expect('Cache-Control', 'max-age=10, must-revalidate')
  })

  it('can change local defaultDuration at runtime even if global one changed later', function() {
    apicache = apicache.newInstance()
    var middleware = apicache.middleware(null, null, { defaultDuration: '2 seconds' })
    var app = express()
    app.get('/api/localduration', middleware, function(_req, res) {
      if (isKoa(_req)) return (_req.body = null)
      res.end()
    })
    middleware.options({
      defaultDuration: '10 seconds',
    })
    apicache.options({
      defaultDuration: '40 seconds',
    })

    return request(app)
      .get('/api/localduration')
      .expect(200)
      .expect('Cache-Control', 'max-age=10, must-revalidate')
  })

  describe('when wrong encoding header is set too early by other middleware', function() {
    it('will fix headers', function() {
      var app = express()
      app.requestsProcessed = 0
      function setWrongEncoding(req, res, next) {
        if (isKoa(req)) {
          next = res
          res = req.res
        }

        // should be set inside custom res.writeHead but sometimes isn't
        res.setHeader('Content-Encoding', 'gzip')

        var _writeHead = res.writeHead
        res.writeHead = function() {
          // expect headers not to be sent
          this.removeHeader('Content-Length')
          // instead of really encoding body to gzip
          this.setHeader('Content-Encoding', 'identity')
          return _writeHead.apply(this, arguments)
        }
        next()
      }
      function respond(req, res) {
        app.requestsProcessed++
        if (isKoa(req)) {
          req.respond = false
          res = req.res
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain')
        res.write('wrong encoding')
        res.end()
      }
      var apicacheMiddleware = apicache.newInstance().middleware()
      app.get('/api/wrongencoding', setWrongEncoding, apicacheMiddleware, respond)

      var req = request(app)
      return request(app)
        .get('/api/wrongencoding')
        .expect(200, 'wrong encoding')
        .expect('Content-Type', 'text/plain')
        .then(function(res) {
          expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
          expect(app.requestsProcessed).to.equal(1)
          return req
            .get('/api/wrongencoding')
            .expect(200, 'wrong encoding')
            .expect('Content-Type', 'text/plain')
            .then(function() {
              expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
              expect(app.requestsProcessed).to.equal(1)
            })
        })
    })

    describe("when patched methods don't set implict headers immediately", function() {
      it('will fix headers', function() {
        var app = express()
        app.requestsProcessed = 0
        function changeWriteBehavior(req, res, next) {
          if (isKoa(req)) {
            next = res
            res = req.res
          }

          // should be set inside custom res.writeHead but sometimes isn't
          res.setHeader('Content-Encoding', 'gzip')

          var _writeHead = res.writeHead
          res.writeHead = function() {
            // expect headers not to be sent
            this.removeHeader('Content-Length')
            // instead of really encoding body to gzip
            this.setHeader('Content-Encoding', 'identity')
            return _writeHead.apply(this, arguments)
          }
          var _write = res.write
          res.write = function() {
            var args = arguments
            setImmediate(function() {
              _write.apply(res, args)
            })
            return res
          }
          var _end = res.end
          res.end = function() {
            var args = arguments
            setImmediate(function() {
              _end.apply(res, args)
            })
            return res
          }

          next()
        }
        function respond(_req, res) {
          app.requestsProcessed++
          if (isKoa(_req)) {
            _req.respond = false
            res = _req.res
          }
          res.statusCode = 201
          res.setHeader('Content-Type', 'text/plain')
          res.write('take this')
          res.end()
        }
        var cache = apicache.newInstance()
        app.get('/api/wrongencoding', changeWriteBehavior, cache(), respond)

        return request(app)
          .get('/api/wrongencoding')
          .expect(201, 'take this')
          .expect('Content-Type', 'text/plain')
          .then(function(res) {
            expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
            expect(app.requestsProcessed).to.equal(1)
            return request(app)
              .get('/api/wrongencoding')
              .expect(201, 'take this')
              .expect('Content-Type', 'text/plain')
              .then(function(res) {
                expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })
    })
  })

  apis.forEach(function(api) {
    describe(api.name + ' tests', function() {
      var mockAPI = api.server

      it('does not interfere with initial request', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200)
          .then(assertNumRequestsProcessed(app, 1))
      })

      it('properly returns a request while caching (first call)', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
      })

      it('returns max-age header on first request', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .expect('Cache-Control', /max-age/)
      })

      it('returns properly decremented max-age header on cached response', function(done) {
        var app = mockAPI.create('10 seconds')

        request(app)
          .get('/api/movies')
          .expect(200, movies)
          .expect('Cache-Control', 'max-age=10, must-revalidate')
          .then(function(res) {
            setTimeout(function() {
              request(app)
                .get('/api/movies')
                .expect(200, movies)
                .expect('Cache-Control', 'max-age=9, must-revalidate')
                .then(function() {
                  expect(app.requestsProcessed).to.equal(1)
                  done()
                })
                .catch(function(err) {
                  done(err)
                })
            }, 1000)
          })
          .catch(done)
      })
      ;['post', 'put', 'patch', api.name.indexOf('restify') !== -1 ? 'del' : 'delete'].forEach(
        function(method) {
          describe(`when ${method.toUpperCase()}`, function() {
            before(function() {
              var that = this
              this.app = mockAPI.create('10 seconds')
              this.app[method]('/api/nongethead', function(req, res) {
                that.app.requestsProcessed++
                if (isKoa(req)) {
                  req.respond = false
                  res = req.res
                }
                res.statusCode = 200
                res.write('non get nor head')
                res.end()
              })
            })

            it('returns no-store header', function() {
              var that = this
              return request(this.app)
                [method]('/api/nongethead')
                .expect(200, 'non get nor head')
                .expect('Cache-Control', 'no-store')
                .then(function(res) {
                  return request(that.app)
                    [method]('/api/nongethead')
                    .expect(200, 'non get nor head')
                    .expect('Cache-Control', 'no-store')
                    .then(function() {
                      expect(that.app.requestsProcessed).to.equal(1)
                      var key = that.app.apicache.getKey({
                        method: method === 'del' ? 'delete' : method,
                        url: '/api/nongethead',
                      })
                      return that.app.apicache.get(key)
                    })
                })
                .then(function(cached) {
                  expect(cached.headers['cache-control']).to.equal('no-store')
                })
            })
          })
        }
      )

      describe('when head request', function() {
        beforeEach(function() {
          var that = this
          this.app = mockAPI.create('10 seconds')
          this.app.get.restoreDefaultBehavior && this.app.get.restoreDefaultBehavior()
          this.app.get('/api/headget', function(req, res) {
            that.app.requestsProcessed++
            if (isKoa(req)) {
              req.body = 'headget response'
            } else {
              res.write('headget response')
              res.end()
            }
          })
          this.app.head('/api/headget', function(req, res) {
            that.app.requestsProcessed++
            if (isKoa(req)) {
              req.status = 200
            } else res.end()
          })
        })

        describe('when get is cached', function() {
          it('fallback to get', function() {
            var that = this

            return request(this.app)
              .get('/api/headget')
              .expect(200, 'headget response')
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(1)
                return request(that.app)
                  .head('/api/headget')
                  .expect(200, undefined)
              })
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(1)
                return request(that.app)
                  .get('/api/headget')
                  .expect(200, 'headget response')
              })
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(1)
              })
          })
        })

        describe('when get is not cached', function() {
          it("doesn't fallback to get", function() {
            var that = this

            return request(this.app)
              .head('/api/headget')
              .expect(200, undefined)
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(1)
                return request(that.app)
                  .head('/api/headget')
                  .expect(200, undefined)
              })
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(1)
                return request(that.app)
                  .get('/api/headget')
                  .expect(200, 'headget response')
              })
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(2)
                return request(that.app)
                  .get('/api/headget')
                  .expect(200, 'headget response')
              })
              .then(function() {
                expect(that.app.requestsProcessed).to.equal(2)
              })
          })
        })
      })

      it('returns decremented max-age header when overwritten one is higher than cache duration', function(done) {
        var app = mockAPI.create('10 seconds', { headers: { 'cache-control': 'max-age=15' } })

        request(app)
          .get('/api/movies')
          .expect(200, movies)
          .expect('Cache-Control', 'max-age=15')
          .then(function(res) {
            setTimeout(function() {
              request(app)
                .get('/api/movies')
                .expect(200, movies)
                .expect('Cache-Control', 'max-age=9')
                .then(function() {
                  expect(app.requestsProcessed).to.equal(1)
                  done()
                })
                .catch(function(err) {
                  done(err)
                })
            }, 1000)
          })
      })

      it('returns overwritten max-age header when lower than cache duration', function() {
        var app = mockAPI.create('10 seconds', { headers: { 'cache-control': 'max-age=5' } })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .expect('Cache-Control', 'max-age=5')
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect(200, movies)
              .expect('Cache-Control', 'max-age=5')
              .then(function() {
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })

      it('return a low max-age when apicacheGroup is set', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/testcachegroup')
          .expect('Cache-Control', 'max-age=3, must-revalidate')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/testcachegroup')
              .expect('Cache-Control', 'max-age=3, must-revalidate')
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('return 30s max-age when syncing is off', function() {
        var app = mockAPI.create('40 seconds')

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'max-age=30, must-revalidate')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Cache-Control', 'max-age=30, must-revalidate')
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('return regular max-age when syncing is on', function() {
        var app = mockAPI.create('40 seconds', { shouldSyncExpiration: true })

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'max-age=40, must-revalidate')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Cache-Control', 'max-age=40, must-revalidate')
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('return private cache-control when options.append is set', function() {
        var app = mockAPI.create('40 seconds', { shouldSyncExpiration: true, append: () => null })

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'private, max-age=40, must-revalidate')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Cache-Control', 'private, max-age=40, must-revalidate')
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      // naive optimization that just makes sure duration isn't higher than 5 min when append is set
      // a better one would probably need stats recording
      // and is not that useful when maxMemory option is set
      it('lower cache duration when optimizeDuration is on', function() {
        var app = mockAPI.create('10 minutes', {
          shouldSyncExpiration: true,
          optimizeDuration: true,
          append: () => null,
        })

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'private, max-age=300, must-revalidate')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Cache-Control', 'private, max-age=300, must-revalidate')
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('skips cache when using header "cache-control: no-store"', function() {
        var app = mockAPI.create('10 seconds', { isBypassable: true })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('cache-control', 'no-store')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, movies)
              .then(function(res) {
                expect(res.headers['apicache-store']).to.be.undefined
                expect(res.headers['apicache-version']).to.be.undefined
                expect(app.requestsProcessed).to.equal(2)
              })
          })
      })

      it('skips cache when using header "x-apicache-bypass"', function() {
        var app = mockAPI.create('10 seconds', { isBypassable: true })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('x-apicache-bypass', true)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, movies)
              .then(function(res) {
                expect(res.headers['apicache-store']).to.be.undefined
                expect(res.headers['apicache-version']).to.be.undefined
                expect(app.requestsProcessed).to.equal(2)
              })
          })
      })

      it('skips cache when using header "x-apicache-force-fetch (legacy)"', function() {
        var app = mockAPI.create('10 seconds', { isBypassable: true })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('x-apicache-force-fetch', true)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, movies)
              .then(function(res) {
                expect(res.headers['apicache-store']).to.be.undefined
                expect(res.headers['apicache-version']).to.be.undefined
                expect(app.requestsProcessed).to.equal(2)
              })
          })
      })

      it('prevent cache skipping when using header "cache-control: no-store" with isBypassable "false"', function() {
        var app = mockAPI.create('10 seconds', { isBypassable: false })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('cache-control', 'no-store')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(function(res) {
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })

      it('prevent cache skipping when using header "x-apicache-bypass (legacy)" with isBypassable "false"', function() {
        var app = mockAPI.create('10 seconds', { isBypassable: false })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('x-apicache-bypass', true)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(function(res) {
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })

      it('prevent cache skipping when using header "x-apicache-force-fetch (legacy)" with isBypassable "false"', function() {
        var app = mockAPI.create('10 seconds', { isBypassable: false })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('x-apicache-force-fetch', true)
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(function(res) {
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })

      it('does not cache header in headerBlacklist', function() {
        var app = mockAPI.create('10 seconds', { headerBlacklist: ['x-blacklisted'] })

        return request(app)
          .get('/api/testheaderblacklist')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['x-blacklisted']).to.equal(res.headers['x-notblacklisted'])
            return request(app)
              .get('/api/testheaderblacklist')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, movies)
              .then(function(res2) {
                expect(res2.headers['x-blacklisted']).to.not.equal(res2.headers['x-notblacklisted'])
              })
          })
      })

      it('does not cache header in headerBlacklist with any letter case', function() {
        var app = mockAPI.create('10 seconds', { headerBlacklist: ['X-blacklisteD'] })

        return request(app)
          .get('/api/testheaderblacklist')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['x-blacklisted']).to.equal(res.headers['x-notblacklisted'])
            return request(app)
              .get('/api/testheaderblacklist')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, movies)
              .then(function(res2) {
                expect(res2.headers['x-blacklisted']).to.not.equal(res2.headers['x-notblacklisted'])
              })
          })
      })

      it('properly returns a cached JSON request', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return request(app)
              .get('/api/movies')
              .set('Accept', 'application/json')
              .expect('Content-Type', /json/)
              .expect(200, movies)
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('properly uses appendKey params', function() {
        var app = mockAPI.create('10 seconds', { append: ['method'] })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function() {
            expect(app.apicache.getIndex().all[0]).to.equal(
              app.apicache.getKey({ method: 'get', url: '/api/movies', appendice: 'GET' })
            )
          })
      })

      it('can handle absent property from appendKey params', function() {
        var app = mockAPI.create('10 seconds', { append: ['method', 'undefined'] })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function() {
            expect(app.apicache.getIndex().all[0]).to.equal(
              app.apicache.getKey({ method: 'get', url: '/api/movies' })
            )
          })
      })

      it('properly uses custom appendKey(req, res) function', function() {
        var appendKey = function(req, res) {
          if (isKoa(req)) return req.method + req.state.id
          return req.method + res.id
        }
        var app = mockAPI.create('10 seconds', { append: appendKey })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function() {
            expect(app.apicache.getIndex().all[0]).to.equal(
              app.apicache.getKey({ method: 'get', url: '/api/movies', appendice: 'GET123' })
            )
          })
      })

      it('can set null local appendKey param to override global one', function() {
        var app = mockAPI.create('10 seconds', { append: ['method'] }, null, { append: null })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function() {
            expect(app.apicache.getIndex().all[0]).to.equal(
              app.apicache.getKey({ method: 'get', url: '/api/movies' })
            )
          })
      })

      it('returns cached response from write+end', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/writeandend')
          .expect(200, 'abc')
          .expect('Cache-Control', 'max-age=10, must-revalidate')
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(
                  request(app)
                    .get('/api/writeandend')
                    .expect(200, 'abc')
                    .then(assertNumRequestsProcessed(app, 1))
                )
              }, 10)
            })
          })
      })

      it('returns cached response from write Buffer+end', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/writebufferandend')
          .expect(200, 'abc')
          .expect('Cache-Control', 'max-age=10, must-revalidate')
          .then(assertNumRequestsProcessed(app, 1))
          .then(function() {
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(
                  request(app)
                    .get('/api/writebufferandend')
                    .expect(200, 'abc')
                    .then(assertNumRequestsProcessed(app, 1))
                )
              }, 10)
            })
          })
      })

      it('embeds store type and apicache version in cached responses', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['apicache-store']).to.be.undefined
            expect(res.headers['apicache-version']).to.be.undefined
            expect(app.requestsProcessed).to.equal(1)
          })
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('does NOT store type and apicache version in cached responses when NODE_ENV === "production"', function() {
        var app = mockAPI.create('10 seconds')
        process.env.NODE_ENV = 'production'

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['apicache-store']).to.be.undefined
            expect(res.headers['apicache-version']).to.be.undefined
            expect(app.requestsProcessed).to.equal(1)
          })
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect(200, movies)
              .then(function(res) {
                expect(res.headers['apicache-store']).to.be.undefined
                expect(res.headers['apicache-version']).to.be.undefined
                expect(app.requestsProcessed).to.equal(1)

                process.env.NODE_ENV = undefined
              })
          })
      })

      it('embeds cache-control header', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'max-age=10, must-revalidate')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['apicache-store']).to.be.undefined
            expect(res.headers['apicache-version']).to.be.undefined
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers.date).to.exist
          })
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('allows cache-control header to be overwritten (e.g. "no-cache"', function() {
        var app = mockAPI.create('10 seconds', { headers: { 'cache-control': 'no-cache' } })

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'no-cache')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['apicache-store']).to.be.undefined
            expect(res.headers['apicache-version']).to.be.undefined
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers.date).to.exist
          })
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Cache-Control', 'no-cache')
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('allows cache-control header to be overwritten by local options', function() {
        var globalOptions = { headers: { 'cache-control': 'no-cache' } }
        var localOptions = { headers: { 'cache-control': 'no-store' } }
        var app = mockAPI.create('10 seconds', globalOptions, null, localOptions)

        return request(app)
          .get('/api/movies')
          .expect('Cache-Control', 'no-store')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['apicache-store']).to.be.undefined
            expect(res.headers['apicache-version']).to.be.undefined
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers['date']).to.exist
          })
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Cache-Control', 'no-store')
              .expect('apicache-store', 'memory')
              .expect('apicache-version', pkg.version)
              .expect(200, movies)
              .then(assertNumRequestsProcessed(app, 1))
          })
      })

      it('preserves etag header', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200)
          .then(function(res) {
            var etag = res.headers.etag
            expect(etag).to.exist
            return etag
          })
          .then(function(etag) {
            return request(app)
              .get('/api/movies')
              .expect(200)
              .expect('etag', etag)
          })
      })

      it('respects if-none-match header', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers['last-modified']).to.be.undefined
            return res.headers.etag
          })
          .then(function(etag) {
            return request(app)
              .get('/api/movies')
              .set('if-none-match', etag)
              .expect(304, '')
              .expect('etag', etag)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it('respects if-modified-since header', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/ifmodifiedsince')
          .expect(200, 'hi')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers.etag).to.be.undefined
            return res.headers['last-modified']
          })
          .then(function(lastModified) {
            return request(app)
              .get('/api/ifmodifiedsince')
              .set('if-modified-since', lastModified)
              .expect(304, '')
              .expect('last-modified', lastModified)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it("don't send 304 if set if-match header", function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers['last-modified']).to.be.undefined
            return res.headers.etag
          })
          .then(function(etag) {
            return request(app)
              .get('/api/movies')
              .set('if-none-match', etag)
              .set('if-match', 'a-strong-etag')
              .expect(200, movies)
              .expect('etag', etag)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it("don't send 304 if set if-unmodified-since header", function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/ifmodifiedsince')
          .expect(200, 'hi')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers.etag).to.be.undefined
            return res.headers['last-modified']
          })
          .then(function(lastModified) {
            return request(app)
              .get('/api/ifmodifiedsince')
              .set('if-unmodified-since', new Date().toUTCString())
              .set('if-modified-since', lastModified)
              .expect(200, 'hi')
              .expect('last-modified', lastModified)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it("don't send 304 if set if-range header with an etag", function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers['last-modified']).to.be.undefined
            return res.headers.etag
          })
          .then(function(etag) {
            return request(app)
              .get('/api/movies')
              .set('if-none-match', etag)
              .set('if-range', 'a-strong-etag')
              .expect(200, movies)
              .expect('etag', etag)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it("don't send 304 if set if-range header with a date", function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/ifmodifiedsince')
          .expect(200, 'hi')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            return res.headers['last-modified']
          })
          .then(function(lastModified) {
            var date = new Date().toUTCString()
            return request(app)
              .get('/api/ifmodifiedsince')
              .set('if-unmodified-since', date)
              .set('if-range', 'a-strong-etag', date)
              .expect(200, 'hi')
              .expect('last-modified', lastModified)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it('support end-to-end reload requests', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/ifmodifiedsince')
          .expect(200, 'hi')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.headers.etag).to.be.undefined
            return res.headers['last-modified']
          })
          .then(function(lastModified) {
            return request(app)
              .get('/api/ifmodifiedsince')
              .set('cache-control', 'no-cache')
              .set('if-modified-since', lastModified)
              .expect(200, 'hi')
              .expect('last-modified', lastModified)
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
          })
      })

      it('send empty body for HEAD requests', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            return request(app)
              .head('/api/movies')
              .expect(200, undefined)
              .then(function(cachedRes) {
                expect(res.headers['content-type']).to.exist
                expect(res.headers['content-type']).to.eql(cachedRes.headers['content-type'])
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })

      it('embeds returns content-type JSON from original response and cached response', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .expect(200)
          .expect('Content-Type', 'application/json; charset=utf-8')
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect('Content-Type', 'application/json; charset=utf-8')
          })
      })

      it('cache a request when status code found in default status code inclusions', function() {
        var app = mockAPI.create('2 seconds')

        return request(app)
          .get('/api/missing')
          .set('Status-Code', 200)
          .expect(200)
          .expect('Cache-Control', /max-age/)
          .then(function(res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
          })
      })

      it('does not cache a request when status code not found in default status code inclusions', function() {
        var app = mockAPI.create('2 seconds')

        return request(app)
          .get('/api/missing')
          .set('Status-Code', 206)
          .expect(206)
          .then(function(res) {
            expect(res.headers['cache-control']).to.equal('no-store')
            expect(app.apicache.getIndex().all.length).to.equal(0)
          })
      })

      it('cache a request when status code not found in status code exclusions', function() {
        var app = mockAPI.create('2 seconds', {
          statusCodes: { exclude: [404] },
        })

        return request(app)
          .get('/api/missing')
          .set('Status-Code', 501)
          .expect(501)
          .expect('Cache-Control', /max-age/)
          .then(function(res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
          })
      })

      it('does not cache a request when status code found in status code exclusions', function() {
        var app = mockAPI.create('2 seconds', {
          statusCodes: { exclude: [404] },
        })

        return request(app)
          .get('/api/missing')
          .expect(404)
          .then(function(res) {
            expect(res.headers['cache-control']).to.equal('no-store')
            expect(app.apicache.getIndex().all.length).to.equal(0)
          })
      })

      it('cache a request when status code found in status code inclusions', function() {
        var app = mockAPI.create('2 seconds', {
          statusCodes: { include: [206] },
        })

        return request(app)
          .get('/api/missing')
          .set('Status-Code', 206)
          .expect(206)
          .expect('Cache-Control', /max-age/)
          .then(function(res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
          })
      })

      it('does not cache a request when status code not found in status code inclusions', function() {
        var app = mockAPI.create('2 seconds', {
          statusCodes: { include: [200] },
        })

        return request(app)
          .get('/api/missing')
          .expect(404)
          .then(function(res) {
            expect(res.headers['cache-control']).to.equal('no-store')
            expect(app.apicache.getIndex().all.length).to.equal(0)
          })
      })

      it('middlewareToggle does not block response on falsy middlewareToggle', function() {
        var hits = 0

        var onlyOnce = function(req, res) {
          return hits++ === 0
        }

        var app = mockAPI.create('2 seconds', {}, onlyOnce)

        return request(app)
          .get('/api/movies')
          .then(function(res) {
            return request(app)
              .get('/api/movies')
              .expect(200, movies)
              .then(function(res) {
                expect(res.headers['apicache-version']).to.be.undefined
              })
          })
      })

      it('middlewareToggle works correctly to control statusCode caching (per example)', function() {
        var onlyStatusCode200 = function(req, res) {
          if (isKoa(req)) res = req.res
          return res.statusCode === 200
        }

        var app = mockAPI.create('2 seconds', {}, onlyStatusCode200)

        return request(app)
          .get('/api/missing')
          .expect(404)
          .then(function(res) {
            expect(res.headers['cache-control']).to.equal('no-store')
            expect(app.apicache.getIndex().all.length).to.equal(0)
          })
      })

      it('removes a cache key after expiration', function(done) {
        var app = mockAPI.create(10)

        request(app)
          .get('/api/movies')
          .end(function(_err, res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(app.apicache.getIndex().all).to.include(
              app.apicache.getKey({ method: 'get', url: '/api/movies' })
            )
          })

        setTimeout(function() {
          expect(app.apicache.getIndex().all).to.have.length(0)
          done()
        }, 40)
      })

      it('executes expiration callback from globalOptions.events.expire upon entry expiration', function(done) {
        var callbackResponse
        var cb = function(a, b) {
          callbackResponse = b
        }
        var app = mockAPI.create(15, { events: { expire: cb } })

        request(app)
          .get('/api/movies')
          .end(function(_err, res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(app.apicache.getIndex().all).to.include(
              app.apicache.getKey({ method: 'get', url: '/api/movies' })
            )
          })

        setTimeout(function() {
          expect(app.apicache.getIndex().all).to.have.length(0)
          expect(callbackResponse).to.equal(
            app.apicache.getKey({ method: 'get', url: '/api/movies' })
          )
          done()
        }, 40)
      })

      it('clearing cache cancels expiration callback', function() {
        var timeout = 50
        var callCount = 0
        var cb = function() {
          callCount++
        }
        var app = mockAPI.create(timeout, { events: { expire: cb } })

        return request(app)
          .get('/api/movies')
          .then(function(res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(
              app.apicache.clear(app.apicache.getKey({ method: 'get', url: '/api/movies' })).all
                .length
            ).to.equal(0)
            expect(app.requestsProcessed).to.equal(1)

            return request(app)
              .get('/api/movies')
              .then(function() {
                expect(app.apicache.getIndex().all.length).to.equal(1)
                expect(app.apicache.getIndex().all).to.include(
                  app.apicache.getKey({ method: 'get', url: '/api/movies' })
                )
                expect(app.requestsProcessed).to.equal(2)

                return new Promise(function(resolve) {
                  setTimeout(function() {
                    expect(app.apicache.getIndex().all.length).to.equal(0)
                    expect(callCount).to.equal(1)
                    resolve()
                  }, timeout * 1.5)
                })
              })
          })
      })

      it('allows defaultDuration to be a parseable string (e.g. "1 week")', function(done) {
        var callbackResponse
        var cb = function(a, b) {
          callbackResponse = b
        }
        var app = mockAPI.create(null, { defaultDuration: '10ms', events: { expire: cb } })

        request(app)
          .get('/api/movies')
          .end(function(_err, res) {
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(app.apicache.getIndex().all).to.include(
              app.apicache.getKey({ method: 'get', url: '/api/movies' })
            )
          })

        setTimeout(function() {
          expect(app.apicache.getIndex().all).to.have.length(0)
          expect(callbackResponse).to.equal(
            app.apicache.getKey({ method: 'get', url: '/api/movies' })
          )
          done()
        }, 50)
      })

      it('run provided function after cache hit', function(done) {
        function afterHit(req, res) {
          if (isKoa(req)) res = req.res
          expect(req.headers['request-after-hit']).to.equal('1')
          expect((res.getHeaders ? res.getHeaders() : res._headers)['response-after-hit']).to.equal(
            '1'
          )
          done()
        }
        var app = mockAPI.create('2 seconds', { afterHit: afterHit })
        request(app)
          .get('/api/afterhit')
          .expect(200, 'after hit')
          .end(function(_err, res) {
            request(this.app)
              .get('/api/afterhit')
              .set('Request-After-Hit', '1')
              .expect(200, 'after hit')
              .end(function(_err, res) {
                expect(app.requestsProcessed).to.equal(1)
              })
          })
      })

      describe('can attach many apicache middlewares to same route', function() {
        var responseBody = "{ i: 'am' }"
        var respondWithWriteHeadFirst = function(_req, res) {
          this.app.requestsProcessed++
          if (isKoa(_req)) {
            _req.respond = false
            res = _req.res
          }

          res.writeHead(200)
          res.write(this.responseBody)
          res.end()
        }

        var otherResponseBody = { i: 'am' }
        var respondWithWriteFirst = function(_req, res) {
          this.app.requestsProcessed++
          if (isKoa(_req)) {
            _req.respond = false
            res = _req.res
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.write(JSON.stringify(this.responseBody))
          res.end()
        }

        // tested restify version will duplicate body when doing res.end(body)
        var anotherResponseBody = /restify/.test(api.name) ? '' : 'hello'
        var respondWithEndFirst = function(_req, res) {
          this.app.requestsProcessed++
          if (isKoa(_req)) {
            _req.respond = false
            res = _req.res
          }
          res.statusCode = 200
          res.end(this.responseBody)
        }

        ;[
          { body: responseBody, fn: respondWithWriteHeadFirst, desc: 'calling writeHead first' },
          { body: otherResponseBody, fn: respondWithWriteFirst, desc: 'calling write first' },
          { body: anotherResponseBody, fn: respondWithEndFirst, desc: 'calling end first' },
        ].forEach(function(testConfig) {
          describe(testConfig.desc, function() {
            beforeEach(function() {
              apicache = apicache.newInstance({ enabled: true })
              var cache = apicache.middleware
              var framework = ['express', 'restify', 'koa'].find(function(framework) {
                return api.name.indexOf(framework) !== -1
              })
              switch (framework) {
                case 'express':
                  this.serverHeader = 'x-powered-by'
                  this.serverHeaderValue = 'Express'
                  break
                case 'restify':
                  this.serverHeader = 'server'
                  this.serverHeaderValue = 'restify'
                  break
                case 'koa':
                  this.serverHeader = 'x-powered-by'
                  this.serverHeaderValue = 'tj'
                  break
              }
              this.app = mockAPI.create(null, { enabled: false })
              this.skippingMiddleware = cache('2 seconds', function(req) {
                return req.url !== '/sameroute'
              })
              this.regularMiddleware = cache(
                '2 seconds',
                function(req) {
                  return req.url === '/sameroute'
                },
                {
                  append: function(req) {
                    return req.url[req.url.length - 1].toUpperCase()
                  },
                  headerBlacklist: [this.serverHeader],
                  headers: { 'X-Custom': 'plus' },
                }
              )
              this.otherRegularMiddleware = cache('2 seconds', null)
              this.responseBody = testConfig.body
              this.respond = testConfig.fn.bind(this)
            })

            it('starting with a bypass toggle', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.otherRegularMiddleware,
                this.regularMiddleware,
                // this is starting one cause patched res functions gets called at reverse order
                this.skippingMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                  return apicache.get('get/sameroute{}')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(value.headers['x-custom']).to.be.undefined
                })
            })

            it('starting with a bypass toggle v2', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.regularMiddleware,
                this.otherRegularMiddleware,
                this.skippingMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                  return apicache.get('get/sameroute{}E')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.be.undefined
                  expect(value.headers['x-custom']).to.equal('plus')
                })
            })

            it('not starting with a bypass toggle', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.regularMiddleware,
                this.skippingMiddleware,
                this.otherRegularMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                  return apicache.get('get/sameroute{}E')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.be.undefined
                  expect(value.headers['x-custom']).to.equal('plus')
                })
            })

            it('not starting with a bypass toggle v2', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.otherRegularMiddleware,
                this.skippingMiddleware,
                this.regularMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                  return apicache.get('get/sameroute{}')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(value.headers['x-custom']).to.be.undefined
                })
            })

            it('ending with a bypass toggle', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.skippingMiddleware,
                this.regularMiddleware,
                this.otherRegularMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                  return apicache.get('get/sameroute{}E')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.be.undefined
                  expect(value.headers['x-custom']).to.equal('plus')
                })
            })

            it('ending with a bypass toggle v2', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.skippingMiddleware,
                this.otherRegularMiddleware,
                this.regularMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                  return apicache.get('get/sameroute{}')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(value.headers['x-custom']).to.be.undefined
                })
            })

            it('starting and ending with a bypass toggle', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.skippingMiddleware,
                this.otherRegularMiddleware,
                this.regularMiddleware,
                this.skippingMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.be.undefined
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}')
                  return apicache.get('get/sameroute{}')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(value.headers['x-custom']).to.be.undefined
                })
            })

            it('starting and ending with a bypass toggle v2', function() {
              var that = this
              this.app.get(
                '/sameroute',
                this.skippingMiddleware,
                this.regularMiddleware,
                this.otherRegularMiddleware,
                this.skippingMiddleware,
                this.respond
              )

              return request(this.app)
                .get('/sameroute')
                .expect(200, this.responseBody)
                .expect('Cache-Control', /max-age/)
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  return new Promise(function(resolve) {
                    setTimeout(function() {
                      expect(apicache.getIndex().all.length).to.equal(1)
                      expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                      resolve(
                        request(that.app)
                          .get('/sameroute')
                          .expect(200, that.responseBody)
                          .expect('Cache-Control', /max-age/)
                      )
                    }, 10)
                  })
                })
                .then(function(res) {
                  expect(res.headers[that.serverHeader]).to.equal(that.serverHeaderValue)
                  expect(res.headers['x-custom']).to.equal('plus')
                  expect(that.app.requestsProcessed).to.equal(1)
                  expect(apicache.getIndex().all.length).to.equal(1)
                  expect(apicache.getIndex().all[0]).to.equal('get/sameroute{}E')
                  return apicache.get('get/sameroute{}E')
                })
                .then(function(value) {
                  expect(value.headers[that.serverHeader]).to.be.undefined
                  expect(value.headers['x-custom']).to.equal('plus')
                })
            })
          })
        })
      })

      describe('request idempotence', function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var configs = [
          {
            clientName: 'memory',
            config: {},
          },
          {
            clientName: 'redis',
            config: { redisClient: db, redisPrefix: 'a-prefix:' },
          },
        ]

        configs.forEach(function(meta) {
          describe('with ' + meta.clientName + ' cache', function() {
            if (meta.clientName === 'redis') {
              after(function(done) {
                db.flushdb(done)
              })
            }

            describe('when calling a safe http method', function() {
              it("isn't idempotent", function() {
                var app = mockAPI.create('2 seconds', meta.config)
                function resolveWhenKeyIsCached() {
                  return Promise.resolve(app.apicache.getIndex()).then(function(keys) {
                    if (
                      keys.all.length === 0 ||
                      keys.all.some(k => k.startsWith('lock-with-id:make-cacheable:'))
                    ) {
                      return new Promise(function(resolve) {
                        setTimeout(function() {
                          resolve(resolveWhenKeyIsCached())
                        }, 5)
                      })
                    }
                  })
                }

                return Promise.all([
                  request(app)
                    .get('/api/bigresponse')
                    .expect(200),
                  request(app)
                    .get('/api/bigresponse')
                    .expect(200),
                ])
                  .then(function(responses) {
                    responses.forEach(function(res) {
                      expect(res.text.slice(-5)).to.equal('final')
                    })
                    expect(app.requestsProcessed).to.equal(2)
                  })
                  .then(resolveWhenKeyIsCached)
                  .then(function() {
                    return request(app)
                      .get('/api/bigresponse')
                      .expect(200)
                  })
                  .then(function(res) {
                    expect(res.text.slice(-5)).to.equal('final')
                    expect(app.requestsProcessed).to.equal(2)
                  })
              })
            })

            describe('when calling an unsafe http method', function() {
              it('is idempotent', function() {
                var app = mockAPI.create('2 seconds', meta.config)

                return Promise.all([
                  request(app)
                    .post('/api/bigresponse')
                    .expect(200),
                  request(app)
                    .post('/api/bigresponse')
                    .expect(200),
                ]).then(function(responses) {
                  responses.forEach(function(res) {
                    expect(res.text.slice(-5)).to.equal('final')
                  })
                  expect(app.requestsProcessed).to.equal(1)
                })
              })
            })
          })
        })
      })
    })
  })
})

var Compressor = require('../src/compressor')
// revertedCompressionApis.slice because currently koa reverted is already inside apis array
apis.concat(revertedCompressionApis.slice(0, 2)).forEach(function(api) {
  describe(api.name + ' Compressor tests', function() {
    var db = redis.createClient({ prefix: 'a-prefix:' })
    var mockAPI = api.server
    var configs = [
      {
        clientName: 'memory',
        config: {},
      },
      {
        clientName: 'redis',
        config: { redisClient: db, redisPrefix: 'a-prefix:' },
      },
    ]

    configs.forEach(function(meta) {
      describe('with ' + meta.clientName + ' cache', function() {
        if (meta.clientName === 'redis') {
          after(function(done) {
            db.flushdb(done)
          })
        }

        before(function() {
          var that = this
          this.old = Compressor.run
          this.wasCompressorCalled = false
          Compressor.run = function() {
            that.wasCompressorCalled = true
            return {
              on: function() {
                var NullObject = require('stream').PassThrough
                return new NullObject()
              },
            }
          }
        })

        after(function() {
          Compressor.run = this.old
        })

        it('use compressor', function() {
          var that = this
          var app = mockAPI.create('10 seconds', meta.config)
          return request(app)
            .get('/api/movies')
            .expect(200, movies)
            .then(function() {
              return new Promise(function(resolve) {
                setImmediate(function() {
                  var expectation = !// !(already compressed koa+compression/(after) || would compress even if already compressed)
                  (
                    api.name.indexOf('koa+compression') !== -1 ||
                    api.name.indexOf('(after)') !== -1 ||
                    api.name.indexOf('restify+gzip') !== -1
                  )
                  resolve(expect(that.wasCompressorCalled).to.equal(expectation))
                })
              })
            })
        })
      })
    })
  })
})

// node >= v11.7.0
var hasBrotliSupport = (function(ret) {
  return function() {
    if (ret !== undefined) return ret

    var split = process.versions.node.split('.').map(function(number) {
      return parseInt(number, 10)
    })
    return (ret = split[0] > 11 || (split[0] === 11 && split[1] >= 7))
  }
})()
apis.forEach(function(api) {
  describe(api.name + ' compression tests', function() {
    before(function() {
      this.old = Compressor.prototype.isContentLengthBellowThreshold
      Compressor.prototype.isContentLengthBellowThreshold = function() {
        return false
      }
    })

    after(function() {
      Compressor.prototype.isContentLengthBellowThreshold = this.old
    })

    var db = redis.createClient({ prefix: 'a-prefix:' })
    var mockAPI = api.server
    var configs = [
      {
        clientName: 'memory',
        config: {},
      },
      {
        clientName: 'redis',
        config: { redisClient: db, redisPrefix: 'a-prefix:' },
      },
    ]

    configs.forEach(function(meta) {
      describe('with ' + meta.clientName + ' cache', function() {
        if (meta.clientName === 'redis') {
          // eslint-disable-next-line no-undef
          afterEach(function(done) {
            db.flushdb(done)
          })
        }

        it('will cache compressed at maximum quality', function() {
          var app = mockAPI.create('10 seconds', meta.config)
          var encoding = {
            express: 'identity',
            'express+gzip': 'deflate',
            restify: 'identity',
            'restify+gzip': 'gzip',
            koa: 'identity',
            'koa+compression': 'deflate',
          }[api.name]

          return request(app)
            .get('/api/movies')
            .set('Accept-Encoding', encoding)
            .expect(200, movies)
            .then(function(res) {
              expect(res.headers['content-encoding'] || 'identity').to.equal(encoding)
              expect(app.requestsProcessed).to.equal(1)
              return new Promise(function(resolve) {
                setTimeout(resolve, 10)
              })
            })
            .then(function() {
              var ret = request(app)
                .get('/api/movies')
                .set('Accept-Encoding', '*')
                // apicache compression won't necessarily be the same used by compression middleware
                // as apicache will prefer the best compression (slower)
                // while compression middleware tend to prefer a balanced one
                .expect(200, movies)
                .then(function(res) {
                  expect(app.requestsProcessed).to.equal(1)
                  // currently koa+compression will send compressed stream to apicache
                  if (api.name === 'koa+compression') {
                    expect(res.headers['content-encoding'] || 'identity').to.equal('deflate')
                  } else {
                    expect(res.headers['content-encoding'] || 'identity').to.equal(
                      hasBrotliSupport() ? 'br' : 'gzip'
                    )
                  }
                })

              // some node versions support brotli although supertest still doesntt
              if (hasBrotliSupport()) {
                var encoding = {
                  express: 'identity',
                  'express+gzip': 'gzip',
                  restify: 'identity',
                  'restify+gzip': 'gzip',
                  koa: 'identity',
                  'koa+compression': 'gzip',
                }[api.name]

                return ret.catch(function() {
                  return request(app)
                    .get('/api/movies')
                    .set('Accept-Encoding', 'gzip')
                    .expect(200, movies)
                    .then(function(res) {
                      expect(res.headers['content-encoding'] || 'identity').to.equal(encoding)
                    })
                })
              } else return ret
            })
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
        })

        it('can use compressed cache for identity request', function() {
          var app = mockAPI.create('10 seconds', meta.config)

          return request(app)
            .get('/api/movies')
            .expect(200, movies)
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
              return new Promise(function(resolve) {
                setTimeout(resolve, 50)
              })
            })
            .then(function() {
              return request(app)
                .get('/api/movies')
                .set('Accept-Encoding', 'identity')
                .expect(200, movies)
            })
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
        })
      })
    })
  })
})

revertedCompressionApis.forEach(function(api) {
  describe(api.name + ' compression tests', function() {
    var db = redis.createClient({ prefix: 'a-prefix:' })
    var mockAPI = api.server
    var configs = [
      {
        clientName: 'memory',
        config: {},
      },
      {
        clientName: 'redis',
        config: { redisClient: db, redisPrefix: 'a-prefix:' },
      },
    ]

    configs.forEach(function(meta) {
      describe('with ' + meta.clientName + ' cache', function() {
        if (meta.clientName === 'redis') {
          // eslint-disable-next-line no-undef
          afterEach(function(done) {
            db.flushdb(done)
          })
        }

        it('can send compressed cache', function() {
          var app = mockAPI.create('10 seconds', meta.config)

          return request(app)
            .get('/api/movies')
            .set('Accept-Encoding', 'deflate, gzip')
            .expect('Content-Encoding', 'gzip')
            .expect(200, movies)
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
            .then(function() {
              return request(app)
                .get('/api/movies')
                .set('Accept-Encoding', '*')
                .expect('Content-Encoding', 'gzip')
                .expect(200, movies)
            })
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
        })

        it('respect cache-control no-transform value', function() {
          var app = mockAPI.create('10 seconds', meta.config)

          return request(app)
            .get('/api/notransform')
            .set('Accept-Encoding', 'deflate, gzip')
            .expect(200, 'hi')
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
            .then(function() {
              return request(app)
                .get('/api/notransform')
                .set('Accept-Encoding', '*')
                .expect(200, 'hi')
            })
            .then(function(res) {
              expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
              expect(app.requestsProcessed).to.equal(1)
            })
        })

        it('can use cache with compression mismatch', function() {
          var app = mockAPI.create('10 seconds', meta.config)

          return request(app)
            .get('/api/movies')
            .set('Accept-Encoding', 'deflate, gzip')
            .expect('Content-Encoding', 'gzip')
            .expect(200, movies)
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
            .then(function() {
              return request(app)
                .get('/api/movies')
                .set('Accept-Encoding', 'br')
                .expect(200, movies)
                .then(function(res) {
                  expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
                  expect(app.requestsProcessed).to.equal(1)
                })
            })
        })

        it('can use compressed cache for uncompressed request', function() {
          var app = mockAPI.create('10 seconds', meta.config)
          var encoding =
            api.name === 'restify+gzip (after)'
              ? 'identity' // won't cache compressed
              : 'deflate'

          return request(app)
            .get('/api/movies')
            .set('Accept-Encoding', encoding)
            .expect(200, movies)
            .then(function(res) {
              expect(res.headers['content-encoding'] || 'identity').to.equal(encoding)
              expect(app.requestsProcessed).to.equal(1)
            })
            .then(function() {
              return request(app)
                .get('/api/movies')
                .set('Accept-Encoding', '')
                .expect(200, movies)
                .then(function(res) {
                  expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
                  expect(app.requestsProcessed).to.equal(1)
                })
            })
        })

        it('can use compressed cache for unknown encoding request', function() {
          var app = mockAPI.create('10 seconds', meta.config)

          return request(app)
            .get('/api/movies')
            .set('Accept-Encoding', 'gzip')
            .expect('Content-Encoding', 'gzip')
            .expect(200, movies)
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
            .then(function() {
              return request(app)
                .get('/api/movies')
                .set('Accept-Encoding', 'unknown')
                .expect(200, movies)
                .then(function(res) {
                  expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
                  expect(app.requestsProcessed).to.equal(1)
                })
            })
        })

        it("won't compress with unknown encoding request", function() {
          var app = mockAPI.create('10 seconds', meta.config)

          return request(app)
            .get('/api/movies')
            .set('Accept-Encoding', 'unknown')
            .expect(200, movies)
            .then(function() {
              expect(app.requestsProcessed).to.equal(1)
            })
            .then(function() {
              return request(app)
                .get('/api/movies')
                .set('Accept-Encoding', 'gzip')
                .expect(200, movies)
            })
            .then(function(res) {
              expect(res.headers['content-encoding'] || 'identity').to.equal('identity')
              expect(app.requestsProcessed).to.equal(1)
            })
        })
      })
    })
  })
})

describe('Redis support', function() {
  function hgetallIsNull(db, key) {
    return new Promise(function(resolve, reject) {
      db.hgetall(key, function(err, reply) {
        if (err) {
          reject(err)
        } else {
          // null when node-redis. {} when ioredis
          expect(reply || {}).to.eql({})
          db.flushdb()
          resolve()
        }
      })
    })
  }

  apis.forEach(function(api) {
    describe(api.name + ' tests', function() {
      this.timeout(4000)
      var mockAPI = api.server

      it('properly caches a request', function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('10 seconds', { redisClient: db, redisPrefix: 'a-prefix:' })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
          .then(function(res) {
            expect(res.headers['apicache-store']).to.be.undefined
            expect(res.headers['apicache-version']).to.be.undefined
            expect(app.requestsProcessed).to.equal(1)
          })
          .then(function() {
            return request(app)
              .get('/api/movies')
              .expect(200, movies)
              .expect('apicache-store', 'redis')
              .expect('apicache-version', pkg.version)
              .then(assertNumRequestsProcessed(app, 1))
              .then(function() {
                db.flushdb()
              })
          })
      })

      it('can clear indexed cache groups', function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('10 seconds', { redisClient: db, redisPrefix: 'a-prefix:' })

        return request(app)
          .get('/api/testcachegroup')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(app.apicache.getIndex())
              }, 10)
            })
          })
          .then(function(index) {
            expect(index.all.length).to.equal(1)
            expect(index.groups.cachegroup.length).to.equal(1)
            return app.apicache.clear('cachegroup').then(function() {
              return app.apicache.getIndex()
            })
          })
          .then(function(index) {
            expect(Object.keys(index.groups).length).to.equal(0)
            expect(index.all.length).to.equal(0)
            return hgetallIsNull(
              db,
              app.apicache.getKey({ method: 'get', url: '/api/testcachegroup' })
            )
          })
      })

      it('can clear indexed entries by url/key (non-group)', function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('10 seconds', { redisClient: db, redisPrefix: 'a-prefix:' })

        return request(app)
          .get('/api/testcachegroup')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(app.apicache.getIndex())
              }, 10)
            })
          })
          .then(function(index) {
            expect(index.all.length).to.equal(1)
            expect(Object.keys(index.groups).length).to.equal(1)
            return app.apicache
              .clear(app.apicache.getKey({ method: 'get', url: '/api/testcachegroup' }))
              .then(function() {
                return app.apicache.getIndex()
              })
          })
          .then(function(index) {
            expect(index.all.length).to.equal(0)
            expect(Object.keys(index.groups).length).to.equal(0)
            return hgetallIsNull(
              db,
              app.apicache.getKey({ method: 'get', url: '/api/testcachegroup' })
            )
          })
      })

      it('can clear all entries from index', function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('10 seconds', { redisClient: db, redisPrefix: 'a-prefix:' })

        return app.apicache
          .getIndex()
          .then(function(index) {
            expect(index.all.length).to.equal(0)
            return app.apicache.clear().then(function() {
              return new Promise(function(resolve) {
                setImmediate(function() {
                  resolve(app.apicache.getIndex())
                })
              }).then(function(index) {
                expect(index.all.length).to.equal(0)
              })
            })
          })
          .then(function() {
            return request(app).get('/api/testcachegroup')
          })
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(app.apicache.getIndex())
              }, 10)
            })
          })
          .then(function(index) {
            expect(index.all.length).to.equal(1)
            expect(Object.keys(index.groups).length).to.equal(1)
            return app.apicache.clear().then(function() {
              return app.apicache.getIndex()
            })
          })
          .then(function(index) {
            expect(index.all.length).to.equal(0)
            expect(Object.keys(index.groups).length).to.equal(0)
            return hgetallIsNull(
              db,
              app.apicache.getKey({ method: 'get', url: '/api/testcachegroup' })
            )
          })
      })

      it('can share cache between instances', function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('10 seconds', { redisClient: db, redisPrefix: 'a-prefix:' })
        var otherApp

        return request(app)
          .get('/api/testcachegroup')
          .then(function() {
            otherApp = mockAPI.create('10 seconds', { redisClient: db, redisPrefix: 'a-prefix:' })
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(Promise.all([app.apicache.getIndex(), otherApp.apicache.getIndex()]))
              }, 10)
            })
          })
          .then(function(indexes) {
            indexes.forEach(function(index) {
              expect(index.all.length).to.equal(1)
              expect(index.groups.cachegroup.length).to.equal(1)
            })
            return otherApp.apicache.clear('cachegroup')
          })
          .then(function() {
            return Promise.all([app.apicache.getIndex(), otherApp.apicache.getIndex()])
          })
          .then(function(indexes) {
            indexes.forEach(function(index) {
              expect(index.all.length).to.equal(0)
              expect((index.groups.cachegroup || []).length).to.equal(0)
            })
            return hgetallIsNull(db, '/api/testcachegroup')
          })
      })

      it('can download data even if key gets deleted in the middle of it', function(done) {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('1 minute', { redisClient: db, redisPrefix: 'a-prefix:' })
        function resolveWhenKeyIsCached() {
          return app.apicache.getIndex().then(function(keys) {
            if (
              keys.all.length === 0 ||
              keys.all.some(k => k.startsWith('lock-with-id:make-cacheable:'))
            ) {
              return new Promise(function(resolve) {
                setTimeout(function() {
                  resolve(resolveWhenKeyIsCached())
                }, 5)
              })
            }
          })
        }

        request(app)
          .get('/api/bigresponse')
          .expect(200)
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.text.slice(0, 5)).to.equal('aaaaa')
            expect(res.text.slice(-5)).to.equal('final')
            var then = Date.now()
            var clearElapsedTime = Number.MAX_SAFE_INTEGER
            var deletedKeyCount = 0
            var runOnceAfterReceivingFirstChunk = (function(memo) {
              function run(initialChunk) {
                return app.apicache
                  .clear(app.apicache.getKey({ method: 'get', url: '/api/bigresponse' }))
                  .then(function(deleteCount) {
                    clearElapsedTime = Date.now() - then
                    deletedKeyCount = deleteCount
                    expect(String(initialChunk).slice(0, 5)).to.equal('aaaaa')
                  })
              }
              return function(chunk) {
                if (memo) return
                memo = run(chunk)
              }
            })()
            var stream = require('stream')
            var wstream = new stream.Writable({
              write(chunk, _e, cb) {
                runOnceAfterReceivingFirstChunk(chunk)
                cb()
              },
            })

            return resolveWhenKeyIsCached().then(function() {
              var supertest = request(app).get('/api/bigresponse')
              supertest
                .expect(200)
                .pipe(wstream)
                .on('finish', function() {
                  var cachedResTime = Date.now() - then
                  expect(clearElapsedTime).to.be.below(cachedResTime)
                  expect(deletedKeyCount).to.equal(2)
                  expect(app.requestsProcessed).to.equal(1)

                  app.apicache
                    .getIndex()
                    .then(function(index) {
                      expect(index.all.length).to.equal(0)
                      expect(Object.keys(index.groups).length).to.equal(0)
                    })
                    .then(function() {
                      db.flushdb(function() {
                        // needed because piping don't auto close server
                        supertest._server.close()
                        done()
                      })
                    })
                })
            })
          })
      })

      it('can download data even if key group gets deleted in the middle of it', function(done) {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('1 minute', { redisClient: db, redisPrefix: 'a-prefix:' })
        function resolveWhenKeyIsCached() {
          return app.apicache.getIndex().then(function(keys) {
            if (
              keys.all.length === 0 ||
              keys.all.some(k => k.startsWith('lock-with-id:make-cacheable:'))
            ) {
              return new Promise(function(resolve) {
                setTimeout(function() {
                  resolve(resolveWhenKeyIsCached())
                }, 5)
              })
            }
          })
        }

        request(app)
          .get('/api/bigresponse')
          .expect(200)
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(res.text.slice(0, 5)).to.equal('aaaaa')
            expect(res.text.slice(-5)).to.equal('final')
            var then = Date.now()
            var clearElapsedTime = Number.MAX_SAFE_INTEGER
            var deletedKeyCount = 0
            var runOnceAfterReceivingFirstChunk = (function(memo) {
              function run(initialChunk) {
                return app.apicache.clear('bigresponsegroup').then(function(deleteCount) {
                  clearElapsedTime = Date.now() - then
                  deletedKeyCount = deleteCount
                  expect(String(initialChunk).slice(0, 5)).to.equal('aaaaa')
                })
              }
              return function(chunk) {
                if (memo) return
                memo = run(chunk)
              }
            })()
            var stream = require('stream')
            var wstream = new stream.Writable({
              write(chunk, _e, cb) {
                runOnceAfterReceivingFirstChunk(chunk)
                cb()
              },
            })

            return resolveWhenKeyIsCached().then(function() {
              var supertest = request(app).get('/api/bigresponse')
              supertest
                .expect(200)
                .pipe(wstream)
                .on('finish', function() {
                  var cachedResTime = Date.now() - then
                  expect(clearElapsedTime).to.be.below(cachedResTime)
                  expect(deletedKeyCount).to.equal(2)
                  expect(app.requestsProcessed).to.equal(1)

                  app.apicache
                    .getIndex()
                    .then(function(index) {
                      expect(index.all.length).to.equal(0)
                      expect(Object.keys(index.groups).length).to.equal(0)
                    })
                    .then(function() {
                      db.flushdb(function() {
                        // needed because piping don't auto close server
                        supertest._server.close()
                        done()
                      })
                    })
                })
            })
          })
      })

      it("won't append response to same key twice", function() {
        var db = redis.createClient({ prefix: 'a-prefix:' })
        var app = mockAPI.create('1 minute', { redisClient: db, redisPrefix: 'a-prefix:' })

        return Promise.all([
          request(app).get('/api/slowresponse'),
          request(app).get('/api/slowresponse'),
        ])
          .then(function(res) {
            expect(res[0].text).to.equal(res[1].text)
            expect(res[0].text).to.equal('hello world')
            // this was equal 2 when there was no idempotent request feature
            // expect(app.requestsProcessed).to.equal(2)
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(app.apicache.getIndex())
              }, 10)
            })
          })
          .then(function(index) {
            expect(index.all.length).to.equal(1)
            expect(index.all[0]).to.equal(
              app.apicache.getKey({ method: 'get', url: '/api/slowresponse' })
            )
            return request(app).get('/api/slowresponse')
          })
          .then(function(res) {
            // this was equal 2 when there was no idempotent request feature
            // expect(app.requestsProcessed).to.equal(2)
            expect(res.text).to.equal('hello world')
          })
          .then(function() {
            return new Promise(function(resolve) {
              db.flushdb(resolve)
            })
          })
      })

      it('sends a response even upon redis failure', function() {
        var app = mockAPI.create('10 seconds', { redisClient: {} })

        return request(app)
          .get('/api/movies')
          .expect(200, movies)
      })
    })
  })
})

describe('.getKey(keyParts)', function() {
  describe('get key name from key parts', function() {
    beforeEach(function() {
      this.cache = require('../src/apicache').newInstance()
    })

    describe('when parts are complete', function() {
      it('return key name (with sorted params)', function() {
        var keyParts = {
          method: 'HEAD',
          url: '/api/test',
          params: { prop2: 'val2', prop1: ['val1'] },
          appendice: 'user:7',
        }
        expect(this.cache.getKey(keyParts)).to.equal(
          'head/api/test{"prop1":["val1"],"prop2":"val2"}user:7'
        )
      })
    })

    describe('when parts are incomplete', function() {
      it('return key name (keeping {} as separator)', function() {
        var keyParts = {}
        expect(this.cache.getKey(keyParts)).to.equal('{}')

        keyParts = { url: '/' }
        expect(this.cache.getKey(keyParts)).to.equal('/{}')

        keyParts = { method: 'HEAD' }
        expect(this.cache.getKey(keyParts)).to.equal('head{}')

        keyParts = { params: { prop10: 'val10', prop1: ['val1'] } }
        expect(this.cache.getKey(keyParts)).to.equal('{"prop1":["val1"],"prop10":"val10"}')

        keyParts = { appendice: 'user:7' }
        expect(this.cache.getKey(keyParts)).to.equal('{}user:7')
      })
    })

    describe('when parts are absent', function() {
      it('return empty key name', function() {
        expect(this.cache.getKey()).to.equal('{}')

        var keyParts = null
        expect(this.cache.getKey(keyParts)).to.equal('{}')
      })
    })

    it('help with slightly incorrect url', function() {
      var correctKey = this.cache.getKey({ url: '/test ' })
      expect(correctKey).to.equal('/test{}')
      expect(this.cache.getKey({ url: ' /test/ ' })).to.equal(correctKey)

      correctKey = this.cache.getKey({ url: '/' })
      expect(correctKey).to.equal('/{}')
      expect(this.cache.getKey({ url: ' ' })).to.equal(correctKey)
    })
  })
})

describe('.set(key, value, duration, group, expirationCallback)', function() {
  var db = redis.createClient({ prefix: 'a-prefix:' })
  var configs = [
    {
      clientName: 'memory',
      config: {},
    },
    {
      clientName: 'redis',
      config: { redisClient: db, redisPrefix: 'a-prefix:' },
    },
  ]
  configs.forEach(function(meta) {
    beforeEach(function() {
      this.cache = require('../src/apicache').newInstance(meta.config)
    })

    afterEach(function() {
      return this.cache.clear()
    })

    describe('with ' + meta.clientName + ' cache', function() {
      it('set item with defaultDuration', function() {
        var that = this
        this.cache.options({ defaultDuration: '20 ms' })
        return this.cache
          .set('a key', { a: 'value' })
          .then(function(item) {
            expect(item).to.eql({ a: 'value' })
            return that.cache.get('a key')
          })
          .then(function(item) {
            expect(item).to.eql({ a: 'value' })
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(that.cache.get('a key'))
              }, 20)
            })
          })
          .then(function(item) {
            expect(item).to.be.null
          })
      })

      it('set item with custom duration', function() {
        var that = this
        this.cache.options({ defaultDuration: '20 ms' })
        return this.cache
          .set('b key', { b: 'value' }, '40 ms')
          .then(function(item) {
            expect(item).to.eql({ b: 'value' })
            return that.cache.get('b key')
          })
          .then(function(item) {
            expect(item).to.eql({ b: 'value' })
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(that.cache.get('b key'))
              }, 20)
            })
          })
          .then(function(item) {
            expect(item).to.eql({ b: 'value' })
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(that.cache.get('b key'))
              }, 20)
            })
          })
          .then(function(item) {
            expect(item).to.be.null
          })
      })

      it('set item with group', function() {
        var that = this
        return this.cache
          .set('c key', { c: 'value' }, '2 seconds', 'a group')
          .then(function(item) {
            expect(item).to.eql({ c: 'value' })
            return that.cache.get('c key')
          })
          .then(function(item) {
            expect(item).to.eql({ c: 'value' })
            return that.cache.clear('a group')
          })
          .then(function() {
            return that.cache.get('c key')
          })
          .then(function(item) {
            expect(item).to.be.null
          })
      })

      it('set item with expirationCallback', function() {
        var that = this
        var callCount = 0
        var cb = function() {
          callCount++
        }
        return this.cache
          .set('d key', { d: 'value' }, '30 ms', null, cb)
          .then(function(item) {
            expect(item).to.eql({ d: 'value' })
            return that.cache.get('d key')
          })
          .then(function(item) {
            expect(callCount).to.equal(0)
            expect(item).to.eql({ d: 'value' })
            return new Promise(function(resolve) {
              setTimeout(resolve, 30)
            })
          })
          .then(function() {
            expect(callCount).to.equal(1)
          })
      })

      it('can modify existing item', function() {
        var that = this
        return this.cache
          .set('e key', { e: 'value' }, '50 ms')
          .then(function(item) {
            expect(item).to.eql({ e: 'value' })
            return that.cache.get('e key')
          })
          .then(function(item) {
            expect(item).to.eql({ e: 'value' })
            return that.cache.set('e key', 'change is good')
          })
          .then(function(item) {
            expect(item).to.equal('change is good')
            return that.cache.get('e key')
          })
          .then(function(item) {
            expect(item).to.equal('change is good')
          })
      })
    })
  })
})

describe('.has(key)', function() {
  var db = redis.createClient({ prefix: 'a-prefix:' })
  var configs = [
    {
      clientName: 'memory',
      config: {},
    },
    {
      clientName: 'redis',
      config: { redisClient: db, redisPrefix: 'a-prefix:' },
    },
  ]

  configs.forEach(function(meta) {
    beforeEach(function() {
      this.cache = require('../src/apicache').newInstance(meta.config)
    })

    afterEach(function() {
      return this.cache.clear()
    })

    describe('with ' + meta.clientName + ' cache', function() {
      describe("when key doesn't exist", function() {
        it('return false', function() {
          return this.cache.has('a key').then(function(value) {
            expect(value).to.be.false
          })
        })
      })

      describe('when key exists', function() {
        describe('when key is manually set by user', function() {
          it('return true', function() {
            var that = this
            return this.cache
              .set('a key', 'a value')
              .then(function() {
                return that.cache.has('a key')
              })
              .then(function(value) {
                expect(value).to.be.true
              })
          })
        })

        describe('when key is auto set by apicache middleware', function() {
          apis.forEach(function(api) {
            describe(api.name + ' tests', function() {
              beforeEach(function() {
                var mockAPI = api.server
                var app = mockAPI.create('10 seconds', meta.config)
                this.cache = app.apicache
                function resolveWhenKeyIsCached() {
                  return Promise.resolve(app.apicache.getIndex()).then(function(keys) {
                    if (
                      keys.all.length === 0 ||
                      keys.all.some(k => k.startsWith('lock-with-id:make-cacheable:'))
                    ) {
                      return new Promise(function(resolve) {
                        setTimeout(function() {
                          resolve(resolveWhenKeyIsCached())
                        }, 5)
                      })
                    }
                  })
                }
                return request(app)
                  .get('/api/movies')
                  .expect(200, movies)
                  .then(resolveWhenKeyIsCached)
              })

              if (meta.clientName === 'redis') {
                afterEach(function(done) {
                  db.flushdb(done)
                })
              }

              it('return true', function() {
                return this.cache
                  .has(this.cache.getKey({ method: 'GET', url: '/api/movies' }))
                  .then(function(value) {
                    expect(value).to.be.true
                  })
              })
            })
          })
        })
      })
    })
  })
})

describe('.get(key)', function() {
  var db = redis.createClient({ prefix: 'a-prefix:' })
  var configs = [
    {
      clientName: 'memory',
      config: {},
    },
    {
      clientName: 'redis',
      config: { redisClient: db, redisPrefix: 'a-prefix:' },
    },
  ]

  configs.forEach(function(meta) {
    beforeEach(function() {
      this.cache = require('../src/apicache').newInstance(meta.config)
    })

    afterEach(function() {
      return this.cache.clear()
    })

    describe('with ' + meta.clientName + ' cache', function() {
      describe("when key doesn't exist", function() {
        it('return null', function() {
          return this.cache.get('a key').then(function(value) {
            expect(value).to.be.null
          })
        })
      })

      describe('when key exists', function() {
        describe('when key is manually set by user', function() {
          it("returns it's value", function() {
            var that = this
            return this.cache
              .set('a key', 'a value')
              .then(function() {
                return that.cache.get('a key')
              })
              .then(function(value) {
                expect(value).to.equal('a value')
              })
          })
        })

        describe('when key is auto set by apicache middleware', function() {
          apis.forEach(function(api) {
            describe(api.name + ' tests', function() {
              describe('when cache is compressed', function() {
                beforeEach(function() {
                  var mockAPI = api.server
                  var app = mockAPI.create('2 seconds', meta.config)
                  this.cache = app.apicache
                  function resolveWhenKeyIsCached() {
                    return Promise.resolve(app.apicache.getIndex()).then(function(keys) {
                      if (
                        keys.all.length === 0 ||
                        keys.all.some(k => k.startsWith('lock-with-id:make-cacheable:'))
                      ) {
                        return new Promise(function(resolve) {
                          setTimeout(function() {
                            resolve(resolveWhenKeyIsCached())
                          }, 5)
                        })
                      }
                    })
                  }
                  return request(app)
                    .get('/api/bigresponse')
                    .expect(200)
                    .then(function(res) {
                      expect(res.text.slice(0, 5)).to.equal('aaaaa')
                      expect(res.text.slice(-5)).to.equal('final')
                    })
                    .then(resolveWhenKeyIsCached)
                })

                if (meta.clientName === 'redis') {
                  afterEach(function(done) {
                    db.flushdb(done)
                  })
                }

                it("return it's formatted value", function() {
                  return this.cache
                    .get(this.cache.getKey({ method: 'GET', url: '/api/bigresponse' }))
                    .then(function(value) {
                      expect(value.status).to.equal(200)
                      if (api.name === 'restify+gzip') {
                        // cache won't be compressed
                        expect(value.headers['content-encoding'] || 'identity').to.equal('identity')
                      } else {
                        // depending on node version, can be br or gzip
                        expect(value.headers['content-encoding'] || 'identity').to.not.equal(
                          'identity'
                        )
                      }
                      expect(value.headers['cache-control']).to.equal('max-age=2, must-revalidate')
                      expect(value.data.slice(0, 5)).to.equal('aaaaa')
                      expect(value.data.slice(-5)).to.equal('final')
                      expect(value.timestamp).to.be.a('number')
                    })
                })
              })

              describe("when cache isn't compressed", function() {
                beforeEach(function() {
                  var mockAPI = api.server
                  var app = mockAPI.create('2 seconds', meta.config)
                  this.cache = app.apicache
                  function resolveWhenKeyIsCached() {
                    return Promise.resolve(app.apicache.getIndex()).then(function(keys) {
                      if (
                        keys.all.length === 0 ||
                        keys.all.some(k => k.startsWith('lock-with-id:make-cacheable:'))
                      ) {
                        return new Promise(function(resolve) {
                          setTimeout(function() {
                            resolve(resolveWhenKeyIsCached())
                          }, 5)
                        })
                      }
                    })
                  }
                  return request(app)
                    .get('/api/movies')
                    .expect(200, movies)
                    .then(resolveWhenKeyIsCached)
                })

                if (meta.clientName === 'redis') {
                  afterEach(function(done) {
                    db.flushdb(done)
                  })
                }

                it("return it's formatted value", function() {
                  return this.cache
                    .get(this.cache.getKey({ method: 'GET', url: '/api/movies' }))
                    .then(function(value) {
                      expect(value.status).to.equal(200)
                      if (api.name === 'koa+compression') {
                        // supertest doesnt support br yet - hasBrotliSupport() ? 'br' : 'gzip'
                        expect(value.headers['content-encoding'] || 'identity').to.equal('gzip')
                      } else {
                        expect(value.headers['content-encoding'] || 'identity').to.equal('identity')
                      }
                      expect(value.headers['cache-control']).to.equal('max-age=2, must-revalidate')
                      expect(value.data).to.eql(movies)
                      expect(value.timestamp).to.be.a('number')
                    })
                })
              })
            })
          })
        })
      })
    })
  })
})

describe('.clear(key?) {SETTER}', function() {
  it('is a function', function() {
    var apicache = require('../src/apicache')
    expect(typeof apicache.clear).to.equal('function')
  })

  apis.forEach(function(api) {
    describe(api.name + ' tests', function() {
      var mockAPI = api.server

      it('works when called with group key', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/testcachegroup')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(app.apicache.getIndex().groups.cachegroup.length).to.equal(1)
            expect(Object.keys(app.apicache.clear('cachegroup').groups).length).to.equal(0)
            expect(app.apicache.getIndex().all.length).to.equal(0)
          })
      })

      it('works when called with specific endpoint (non-group) key', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/movies')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(
              app.apicache.clear(app.apicache.getKey({ method: 'get', url: '/api/movies' })).all
                .length
            ).to.equal(0)
          })
      })

      it('clears empty group after removing last specific endpoint', function() {
        var app = mockAPI.create('10 seconds')

        return request(app)
          .get('/api/testcachegroup')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(app.apicache.getIndex().groups.cachegroup.length).to.equal(1)
            expect(
              Object.keys(
                app.apicache.clear(
                  app.apicache.getKey({ method: 'get', url: '/api/testcachegroup' })
                ).groups
              ).length
            ).to.equal(0)
            expect(app.apicache.getIndex().all.length).to.equal(0)
          })
      })

      it('works when called with no key', function() {
        var app = mockAPI.create('10 seconds')

        expect(app.apicache.getIndex().all.length).to.equal(0)
        expect(app.apicache.clear().all.length).to.equal(0)
        return request(app)
          .get('/api/movies')
          .then(function(res) {
            expect(app.requestsProcessed).to.equal(1)
            expect(app.apicache.getIndex().all.length).to.equal(1)
            expect(app.apicache.clear().all.length).to.equal(0)
          })
      })
    })
  })
})
