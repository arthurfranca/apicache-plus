var zlib = require('zlib')
var accepts = require('accepts')
var stream = require('stream')
var querystring = require('querystring')
var jsonSortify = require('json.sortify')
var generateUuidV4 = require('uuid').v4
var MemoryCache = require('./memory-cache')
var RedisCache = require('./redis-cache')
var Compressor = require('./compressor')
var pkg = require('../package.json')
var helpers = require('./helpers')
var setLongTimeout = helpers.setLongTimeout
var clearLongTimeout = helpers.clearLongTimeout
var delegateLazily = helpers.delegateLazily
var isKoa = helpers.isKoa

var FIVE_MINUTES = 5 * 60 * 1000
var SAFE_HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS']
var CACHEABLE_STATUS_CODES = {
  200: null,
  201: null,
  202: null,
  203: null,
  204: null,
  205: null,
  300: null,
  301: null,
  302: null,
  305: null,
  307: null,
}

var t = {
  ms: 1,
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 3600000 * 24,
  week: 3600000 * 24 * 7,
  month: 3600000 * 24 * 30,
  year: 3600000 * 24 * 365,
}

var instances = []

var matches = function(a) {
  return function(b) {
    return a === b
  }
}

var doesntMatch = function(a) {
  return function(b) {
    return !matches(a)(b)
  }
}

var logDuration = function(d, prefix) {
  var str = d > 1000 ? (d / 1000).toFixed(2) + 'sec' : d + 'ms'
  return '\x1b[33m- ' + (prefix ? prefix + ' ' : '') + str + '\x1b[0m'
}

function getSafeHeaders(res) {
  // getHeaders added in node v7.7.0
  return Object.assign({}, res.getHeaders ? res.getHeaders() : res._headers)
}

function ApiCache() {
  var memCache = new MemoryCache()
  var redisCache

  var globalOptions = {
    debug: false,
    defaultDuration: 3600000,
    enabled: true,
    isBypassable: false,
    append: null,
    interceptKeyParts: null,
    jsonp: false,
    redisClient: false,
    redisPrefix: '',
    headerBlacklist: [],
    statusCodes: {
      include: [],
      exclude: [],
    },
    events: {
      expire: undefined,
    },
    headers: {
      // 'cache-control':  'no-cache' // example of header overwrite
    },
    shouldSyncExpiration: false,
    afterHit: null,
    trackPerformance: false,
    optimizeDuration: false,
  }

  var middlewareOptions = []
  var instance = this
  var index = null
  var timers = {}
  var performanceArray = [] // for tracking cache hit rate

  instances.push(this)
  this.id = instances.length

  function shouldDebug() {
    var debugEnv = process.env.DEBUG && process.env.DEBUG.split(',').indexOf('apicache') !== -1

    return !!(globalOptions.debug || debugEnv)
  }

  function debug(a, b, c, d) {
    if (!shouldDebug()) return
    var arr = ['\x1b[36m[apicache]\x1b[0m', a, b, c, d].filter(function(arg) {
      return arg !== undefined
    })
    console.log.apply(null, arr)
  }

  function shouldCacheResponse(request, response, toggle, options) {
    if (!response) return false
    var codes = (options || globalOptions).statusCodes

    if (toggle && !toggle(request, response)) {
      return false
    }

    if ((!codes.exclude || !codes.exclude.length) && (!codes.include || !codes.include.length)) {
      return response.statusCode in CACHEABLE_STATUS_CODES
    }
    if (
      codes.exclude &&
      codes.exclude.length &&
      codes.exclude.indexOf(response.statusCode) !== -1
    ) {
      return false
    }
    if (
      codes.include &&
      codes.include.length &&
      codes.include.indexOf(response.statusCode) === -1
    ) {
      return false
    }

    return true
  }

  function addIndexEntries(key, req) {
    var groupName = req.apicacheGroup

    if (groupName) {
      debug('group detected "' + groupName + '"')
      var group = (index.groups[groupName] = index.groups[groupName] || [])
      group.unshift(key)
    }

    index.all.unshift(key)
  }

  function filterBlacklistedHeaders(headers, options) {
    return Object.keys(headers)
      .filter(function(key) {
        return (options || globalOptions).headerBlacklist.indexOf(key) === -1
      })
      .reduce(function(acc, header) {
        acc[header] = headers[header]
        return acc
      }, {})
  }

  function createCacheObject(status, headers, data, encoding, options) {
    return {
      status: status,
      headers: filterBlacklistedHeaders(headers, options),
      data: data,
      encoding: encoding,
      timestamp: Date.now(), // This is used to properly decrement max-age headers in cached responses
    }
  }

  function cacheResponse(key, value, duration) {
    var expireCallback = globalOptions.events.expire
    memCache.add(key, value, duration, expireCallback)

    // add automatic cache clearing from duration
    timers[key] = setLongTimeout(function() {
      instance.clear(key, true)
    }, duration)
  }

  function debugCacheAddition(cache, key, strDuration, req, res, options) {
    if (!shouldDebug()) return Promise.resolve()

    var elapsed = new Date() - req.apicacheTimer
    return Promise.resolve(cache.get(key))
      .then(function(cached) {
        var cacheObject
        if (cached && cached.value) {
          cached = cached.value
          cacheObject = createCacheObject(
            cached.status,
            cached.headers,
            cached.data && cached.data.toString(cached.encoding),
            cached.encoding,
            options
          )
          cacheObject.timestamp = cached.timestamp
        } else cacheObject = {}

        debug('adding cache entry for "' + key + '" @ ' + strDuration, logDuration(elapsed))
        debug('cacheObject: ', cacheObject)
      })
      .catch(function(err) {
        debug('error debugging cache addition', err)
      })
  }

  var isNodeLte7 = (function(ret) {
    return function() {
      if (ret !== undefined) return ret

      return (ret = parseInt(process.versions.node.split('.')[0], 10) <= 7)
    }
  })()

  function getHeadersFromParams(res, statusMsgOrHeaders, maybeHeaders) {
    if (statusMsgOrHeaders && typeof statusMsgOrHeaders !== 'string') {
      maybeHeaders = statusMsgOrHeaders
    }
    if (!maybeHeaders) maybeHeaders = {}

    return Object.keys(maybeHeaders).reduce(function(memo, item) {
      memo[item.toLowerCase()] = maybeHeaders[item]
      return memo
      // some framework writeHead patches remove headers from params, so merge with res.getHeaders()
    }, getSafeHeaders(res))
  }

  function preWriteHead(res, statusCode, statusMsgOrHeaders, maybeHeaders) {
    if (statusCode) res.statusCode = statusCode
    if (statusMsgOrHeaders && typeof statusMsgOrHeaders !== 'string') {
      maybeHeaders = statusMsgOrHeaders
    } else if (statusMsgOrHeaders) res.statusMessage = statusMsgOrHeaders
    if (!maybeHeaders) maybeHeaders = {}

    Object.keys(maybeHeaders).forEach(function(name) {
      res.setHeader(name, maybeHeaders[name])
    })
  }

  function fixEncodingHeaders(chunk, headers) {
    if (!chunk || !headers) return
    if (Compressor.isReallyCompressed(chunk, headers['content-encoding'])) {
      delete headers['content-length']
    } else {
      delete headers['content-encoding']
    }
  }

  function getCacheControlMaxAge(syncedMaxAge, group, options) {
    var maxAge
    if (group) maxAge = Math.min(3, syncedMaxAge)
    else if (!options.shouldSyncExpiration) maxAge = Math.min(30, syncedMaxAge)
    else maxAge = syncedMaxAge

    var directive = options.append || options.appendKey ? 'private, ' : '' // public is default
    return directive + 'max-age=' + maxAge.toFixed(0) + ', must-revalidate'
  }

  function makeResponseCacheable(
    req,
    res,
    next,
    key,
    duration,
    strDuration,
    toggle,
    options,
    afterFn
  ) {
    if (!afterFn) afterFn = Promise.resolve.bind(Promise)
    var afterTryingToCache = (function(isCalled) {
      return function() {
        if (isCalled !== undefined) return isCalled
        return (isCalled = afterFn())
      }
    })()
    var shouldCacheRes = (function(shouldIt) {
      return function(req, res, toggle, options) {
        if (shouldIt !== undefined) return shouldIt
        return (shouldIt = shouldCacheResponse(req, res, toggle, options))
      }
    })()

    // monkeypatch res to create cache object
    var apicacheResPatches = {
      write: res.write,
      writeHead: res.writeHead,
      end: res.end,
    }
    if (!req.apicacheResPatches) {
      req.apicacheResPatches = apicacheResPatches
      req.customWriteHeads = []
      req.runReversedCustomWriteHeadsOnce = (function(isCalled) {
        return function() {
          if (isCalled) return
          isCalled = true
          var fn
          while ((fn = req.customWriteHeads.pop())) {
            fn.apply(null, arguments)
          }
        }
      })()
    }

    function customWriteHead(statusCode, statusMsgOrHeaders, maybeHeaders) {
      if (res._shouldCacheResWriteHeadVersionAlreadyRun) return
      // to use with shouldCacheRes()
      res.statusCode = statusCode

      if (!res._currentResponseHeaders) {
        // these most likely (if default node writeHead implementation) won't be available at res.getHeaders() yet
        res._currentResponseHeaders = getHeadersFromParams(res, statusMsgOrHeaders, maybeHeaders)
      }

      // add cache control headers
      if (!options.headers['cache-control'] && !res._currentResponseHeaders['cache-control']) {
        if (shouldCacheRes(req, res, toggle, options)) {
          var cacheControl
          if (SAFE_HTTP_METHODS.indexOf(req.method) !== -1) {
            var syncedMaxAge = Math.ceil(duration / 1000)
            cacheControl = getCacheControlMaxAge(syncedMaxAge, req.apicacheGroup, options)
          } else {
            cacheControl = 'no-store'
          }

          res.setHeader('cache-control', cacheControl)
          res._currentResponseHeaders['cache-control'] = cacheControl
        } else {
          res.setHeader('cache-control', 'no-store')
        }
      }

      if (shouldCacheRes(req, res, toggle, options)) {
        res._shouldCacheResWriteHeadVersionAlreadyRun = true

        // append header overwrites if applicable
        Object.keys(options.headers).forEach(function(name) {
          res.setHeader(name, options.headers[name])
          res._currentResponseHeaders[name.toLowerCase()] = options.headers[name]
        })
      }
    }

    req.customWriteHeads.unshift(customWriteHead)

    res.writeHead = function(statusCode, statusMsgOrHeaders, maybeHeaders) {
      req.runReversedCustomWriteHeadsOnce(statusCode, statusMsgOrHeaders, maybeHeaders)

      return apicacheResPatches.writeHead.apply(this, arguments)
    }

    var getWstream = (function(wstream) {
      return function(method, chunk, encoding) {
        if (wstream) return wstream

        if (
          res._shouldCacheResWriteOrEndVersionAlreadyRun ||
          !shouldCacheRes(req, res, toggle, options)
        ) {
          var emptyWstream = new stream.Writable({
            write(_c, _e, cb) {
              cb()
            },
          }).on('finish', afterTryingToCache)
          return (wstream = Promise.resolve(emptyWstream))
        }

        res._shouldCacheResWriteOrEndVersionAlreadyRun = true

        var getCacheObject = function() {
          return createCacheObject(res.statusCode, res._currentResponseHeaders, null, null, options)
        }
        var getGroup = function() {
          return req.apicacheGroup
        }
        var expireCallback = globalOptions.events.expire
        var cache = redisCache || memCache
        var chunkSize = Buffer.byteLength(chunk || '', encoding)
        // if res.end was called first (without calling write), it will have only one chunk
        // res.socket.writableHighWaterMark is node gte 9
        var highWaterMark =
          method === 'end'
            ? chunkSize
            : res.socket.writableHighWaterMark || res.socket._writableState.highWaterMark

        var cacheWstream = cache
          .createWriteStream(
            key,
            getCacheObject,
            duration,
            expireCallback,
            getGroup,
            highWaterMark,
            // this is needed while memCache index/groups are still handled externally
            !redisCache &&
              function(statusCode, headers, data, encoding) {
                addIndexEntries(key, req)
                var cacheObject = createCacheObject(statusCode, headers, data, encoding, options)
                cacheResponse(key, cacheObject, duration)
              }
          )
          .then(function(wstream) {
            return wstream
              .on('error', function(err) {
                debug('error in makeResponseCacheable function', err)
              })
              .on('finish', function() {
                afterTryingToCache()
                if (!wstream.isLocked) {
                  debugCacheAddition(cache, key, strDuration, req, res, options)
                }
              })
              .on('unpipe', afterTryingToCache)
          })

        return (wstream = cacheWstream.then(function(wstream) {
          if (wstream.isLocked) return wstream

          // also indicates it may be already compressed
          var otherMiddlewareMayWantToChangeCompression =
            Compressor.getFirstContentEncoding(res._currentResponseHeaders['content-encoding']) !==
            'identity'
          // some middlewares will preset content-encoding to e.g. gzip too early
          // even if apicache is about to receive uncompressed response stream (middleware attached before apicache's one)
          fixEncodingHeaders(chunk, res._currentResponseHeaders)
          // don't compress before caching
          if (otherMiddlewareMayWantToChangeCompression) return wstream

          var tstream = Compressor.run(
            {
              chunkSize: chunkSize,
              requestMehod: req.method,
              responseStatusCode: res.statusCode,
              responseMethod: method,
              responseHeaders: res._currentResponseHeaders,
            },
            debug
          ).on('error', function(err) {
            debug('error in makeResponseCacheable function', err)
            wstream.emit('error')
          })
          tstream.pipe(wstream)
          return tstream
        }))
      }
    })()

    ;['write', 'end'].forEach(function(method) {
      var ret
      res[method] = function(chunk, encoding) {
        if (!this.headersSent) {
          req.runReversedCustomWriteHeadsOnce(
            res.statusCode,
            res.statusMsgOrHeaders,
            getSafeHeaders(res)
          )
        }

        ret = apicacheResPatches[method].apply(this, arguments)
        getWstream(method, chunk, encoding).then(function(wstream) {
          wstream[method](chunk, encoding)
        })
        return ret
      }
    })

    // res.end(data) writes data twice
    if (isNodeLte7()) {
      var _end = res.end
      res.end = function(chunk, encoding) {
        if (Buffer.byteLength(chunk || '') > 0) {
          this.write(chunk, encoding)
          arguments[0] = undefined
        }
        return _end.apply(this, arguments)
      }
    }

    return next()
  }

  var CACHE_CONTROL_NO_TRANSFORM_REGEX = /(?:^|,)\s*?no-transform\s*?(?:,|$)/
  var CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/
  function sendCachedResponse(request, response, cacheObject, toggle, next, duration, options) {
    if (toggle && !toggle(request, response)) {
      return next()
    }
    if (isKoa(request)) request.respond = false

    var isMarkedToCache = !!request.apicacheResPatches
    if (isMarkedToCache) {
      // undo patches
      Object.keys(request.apicacheResPatches).forEach(function(key) {
        response[key] = request.apicacheResPatches[key]
      })
    }

    if (options.afterHit) {
      response.on('finish', function() {
        isKoa(request) ? options.afterHit(request) : options.afterHit(request, response)
      })
    }

    var elapsed = new Date() - request.apicacheTimer
    debug(
      'sending cached',
      redisCache ? '(redis)' : '(memory-cache)',
      'version of',
      cacheObject.key,
      logDuration(elapsed)
    )

    var headers = getSafeHeaders(response)
    var cacheObjectHeaders = cacheObject.headers || {}

    var cacheControl
    // sync max-age with the cache expiration.
    var elapsedMs = Date.now() - cacheObject.timestamp
    var updatedMaxAge = Math.ceil((duration - elapsedMs) / 1000)
    // when caching with options.interceptKeyParts,
    // same key/cache could be reused for responding
    // with different middleware options.headers
    // and to different request methods, so recheck
    if (options.headers['cache-control']) cacheControl = options.headers['cache-control']
    else if (SAFE_HTTP_METHODS.indexOf(request.method) !== -1) {
      if (cacheObjectHeaders['cache-control']) cacheControl = cacheObjectHeaders['cache-control']
      else {
        cacheControl = getCacheControlMaxAge(updatedMaxAge, request.apicacheGroup, options)
      }
    } else cacheControl = 'no-store'

    Object.assign(headers, filterBlacklistedHeaders(cacheObjectHeaders, options), {
      'cache-control': cacheControl.replace(/max-age=\s*([+-]?\d+)/, function(_match, maxAge) {
        return 'max-age=' + Math.max(0, Math.min(parseInt(maxAge, 10), updatedMaxAge))
      }),
    })

    // only embed apicache headers when not in production environment
    if (process.env.NODE_ENV !== 'production') {
      Object.assign(headers, {
        'apicache-store': globalOptions.redisClient ? 'redis' : 'memory',
        'apicache-version': pkg.version,
      })
    }

    function hasNoBodyRequestingPreconditionCheck() {
      return (
        !request.headers['if-match'] &&
        !request.headers['if-unmodified-since'] &&
        !request.headers['if-range']
      )
    }
    function clientDoesntWantToReloadItsCache() {
      return (
        !request.headers['cache-control'] ||
        !CACHE_CONTROL_NO_CACHE_REGEXP.test(request.headers['cache-control'])
      )
    }
    // test Etag against If-None-Match for 304
    function isEtagFresh() {
      var cachedEtag = cacheObjectHeaders.etag
      var requestEtags = (request.headers['if-none-match'] || '').replace('*', '').split(/\s*,\s*/)
      return Boolean(
        cachedEtag &&
          requestEtags.length > 0 &&
          (requestEtags.indexOf(cachedEtag) !== -1 ||
            requestEtags.indexOf('W/' + cachedEtag) !== -1 ||
            requestEtags
              .map(function(rEtag) {
                return 'W/' + rEtag
              })
              .indexOf(cachedEtag) !== -1)
      )
    }
    function isResourceFresh() {
      var cachedLastModified = cacheObjectHeaders['last-modified']
      var requestModifiedSince = request.headers['if-modified-since']
      if (!cachedLastModified || !requestModifiedSince) return false

      try {
        return Date.parse(cachedLastModified) <= Date.parse(requestModifiedSince)
      } catch (err) {
        return false
      }
    }
    if (
      hasNoBodyRequestingPreconditionCheck() &&
      clientDoesntWantToReloadItsCache() &&
      (isEtagFresh() || isResourceFresh())
    ) {
      if ('content-length' in headers) delete headers['content-length']
      response.writeHead(304, headers)
      return response.end()
    }

    if (request.method === 'HEAD') {
      response.writeHead(cacheObject.status || 200, headers)
      // skip body for HEAD
      return response.end()
    }

    function getRstream() {
      return (redisCache || memCache)
        .createReadStream(
          cacheObject.key,
          cacheObject['data-token'] || cacheObject.data,
          cacheObject.encoding,
          // res.socket.writableHighWaterMark is node gte 9
          response.socket.writableHighWaterMark || response.socket._writableState.highWaterMark
        )
        .on('error', function() {
          debug('error in sendCachedResponse function')
          response.end()
        })
    }

    // dont use headers['content-encoding'] as it may be already changed to e.g. gzip by some middleware
    var cachedEncoding = (cacheObjectHeaders['content-encoding'] || 'identity').split(',')[0]
    var currentResCacheEncoding = (headers['content-encoding'] || 'identity').split(',')[0]
    var noOtherMiddlewareMayWantToChangeCompression = cachedEncoding === currentResCacheEncoding
    var requestAccepts = accepts(request)
    if (
      (cachedEncoding === 'identity' ||
        (noOtherMiddlewareMayWantToChangeCompression &&
          !CACHE_CONTROL_NO_TRANSFORM_REGEX.test(headers['cache-control'] || ''))) &&
      requestAccepts.encodings(cachedEncoding)
    ) {
      // Doing response.writeHead(cacheObject.status || 200, headers)
      // can make writeHead patch from some compression middlewares fail
      // (although using res.writeHead with headers that don't mess with content-length / content-encoding
      // would mostly be ok)
      preWriteHead(response, cacheObject.status || 200, headers)
      return getRstream().pipe(response)
      // try to decompress
    } else if (cachedEncoding !== 'identity' && requestAccepts.encodings('identity')) {
      var tstream
      if (cachedEncoding === 'br' && zlib.createBrotliDecompress) {
        tstream = zlib.createBrotliDecompress()
      } else if (['gzip', 'deflate'].indexOf(cachedEncoding) !== -1) {
        tstream = zlib.createUnzip()
      } else {
        var errorMessage = "can't decompress" + cachedEncoding + 'encoding'
        throw new Error(errorMessage)
      }

      delete headers['content-encoding']
      preWriteHead(response, cacheObject.status || 200, headers)
      tstream.on('error', function() {
        debug('error in decompression stream')
        this.unpipe()
        // if erroed cause didn't need to decompress
        // try sending it without transforming
        getRstream()
          .on('error', function() {
            debug('error in decompression stream')
            this.unpipe()
            response.end()
            // if node < 8
            if (!this.destroy) return this.pause()
            this.destroy()
          })
          .pipe(response)
        // if node < 8
        if (!this.destroy) return this.pause()
        this.destroy()
      })
      return getRstream()
        .pipe(tstream)
        .pipe(response)
    } else {
      var contentEncodings = Array.from(new Set([cachedEncoding, 'identity']))
      var statusMessage =
        'Please accept' +
        contentEncodings.slice(0, -1).join(', ') +
        contentEncodings.slice(-1).join(', or ')

      response.writeHead(406, statusMessage)
      return response.end()
    }
  }

  var syncOptions = (function() {
    function syncOptionsByIndex(i) {
      Object.assign(middlewareOptions[i].options, globalOptions, middlewareOptions[i].localOptions)
      var options = middlewareOptions[i].options
      if (options.headerBlacklist) {
        options.headerBlacklist = options.headerBlacklist.map(function(v) {
          return v.toLowerCase()
        })
      }
    }

    return function(i) {
      if (i) return syncOptionsByIndex(i)
      else {
        for (i in middlewareOptions) {
          syncOptionsByIndex(i)
        }
      }
    }
  })()

  function getAppendice(append, req, res) {
    if (!append) return ''

    var appendice
    if (typeof append === 'function') {
      appendice = isKoa(req) ? append(req) : append(req, res)
      // ['x', 'y'] => req?.x?.y
    } else if (append.length > 0) {
      appendice = req
      for (var i = 0; i < append.length; i++) {
        if (!appendice) break
        appendice = appendice[append[i]]
      }
    }

    return appendice || ''
  }

  function getKeyParts(req, res, options) {
    var query
    if (req.query !== null && typeof req.query === 'object') query = Object.assign({}, req.query)
    // In Express,the url is ambiguous based on where a router is mounted.  originalUrl will give the full Url
    var url = (req.originalUrl || req.url).replace(/\/?(?:\?([^#]*)(?:#.*)?)?$/, function(
      _match,
      qs
    ) {
      if (!query) {
        query = querystring.parse(qs)
        delete query['']
      }
      return ''
    })
    // couldn't use (?:(?<!^)\/)? negative look-behind instead of \/? at regexp above to keep / if at beginning (node gte 9)
    // also, it will consider a maybe possible req.originalUrl || req.url '' as '/'
    if (url === '') url = '/'
    if (options.jsonp) {
      if ([true, false].indexOf(options.jsonp) === -1) {
        delete query.jsonp
        delete query.callback
      } else delete query[options.jsonp]
    }

    var parts = {
      method: req.method,
      url: url,
      params: Object.assign(query, typeof req.body === 'object' ? Object.assign({}, req.body) : {}),
      appendice: getAppendice(options.append || options.appendKey, req, res),
    }

    if (options.interceptKeyParts) {
      parts =
        (isKoa(req)
          ? options.interceptKeyParts(req, parts)
          : options.interceptKeyParts(req, res, parts)) || parts
    }
    return parts
  }

  function getSimilarKeyFromOtherMethod(key, method, otherMethod) {
    return key.replace(method.toLowerCase(), otherMethod.toLowerCase())
  }

  this.getKey = function(keyParts) {
    if (!keyParts || typeof keyParts !== 'object') return '{}'

    var url
    if (typeof keyParts.url === 'string') {
      url = keyParts.url.trim()
      if (url[0] !== '/') url = '/' + url
      if (url.length > 1) url = url.replace(/\/$/, '')
    } else url = ''

    var appendice
    if (typeof keyParts.appendice === 'string') appendice = keyParts.appendice
    else if (Number.isNaN(keyParts.appendice)) appendice = 'NaN'
    else if ([null, undefined].indexOf(keyParts.appendice) === -1) {
      try {
        appendice = jsonSortify(keyParts.appendice)
      } catch (err) {
        appendice = ''
      }
    } else appendice = ''

    return (
      (typeof keyParts.method === 'string' ? keyParts.method.toLowerCase() : '') +
      url +
      (keyParts.params !== null && typeof keyParts.params === 'object'
        ? jsonSortify(keyParts.params)
        : '{}') +
      appendice
    )
  }

  this.has = function(key) {
    if ([null, undefined].indexOf(key) !== -1) return Promise.resolve(false)

    return (redisCache || memCache).has(key)
  }

  this.get = function(key) {
    if ([null, undefined].indexOf(key) !== -1) return Promise.resolve(false)

    return Promise.resolve((redisCache || memCache).get(key)).then(function(cached) {
      if (!cached) return null

      cached = cached.value
      // this.set can store any value, so return raw cached if not what apicache regularly stores
      if (
        cached === null ||
        typeof cached !== 'object' ||
        !['status', 'headers', 'data', 'encoding', 'timestamp'].every(function(k) {
          return k in cached
        })
      ) {
        return cached
      }

      // try formatting and decompressing
      try {
        var data = cached.data
        if ([null, undefined].indexOf(data) === -1) {
          if (Buffer.byteLength(data) === 0) data = ''
          else {
            var cachedEncoding = cached.headers['content-encoding']
            if (cachedEncoding && cachedEncoding !== 'identity') {
              var decompress = {
                br: zlib.brotliDecompressSync,
                gzip: zlib.unzipSync,
                deflate: zlib.unzipSync,
              }[cachedEncoding]
              if (decompress) data = decompress(data)
            }
            data = data.toString(cached.encoding)
            try {
              data = JSON.parse(data)
            } catch (err) {}
          }
        }

        // don't send with all properties if it's really what apicache regularly stores
        // (e.g. encoding as it was already used above for parsing and redis data-extra-pttl prop)
        return {
          status: cached.status,
          headers: cached.headers,
          data: data,
          timestamp: cached.timestamp,
        }
      } catch (err) {
        return cached
      }
    })
  }

  this.set = function(key, value, duration, group, expirationCallback) {
    if ([null, undefined].indexOf(key) !== -1) return Promise.resolve(false)

    duration = this.getDuration(duration)
    return (
      // for now, this is the way we make sure .set can safely modify an already existing item
      // e.g. it will remove from old group
      Promise.resolve(this.clear(key))
        .then(function() {
          return Promise.resolve(
            (redisCache || memCache).add(key, value, duration, expirationCallback, group)
          )
        })
        // this is needed while memCache index/groups are still handled externally
        .then(function() {
          if (!redisCache) {
            addIndexEntries(key, { apicacheGroup: group })
          }
          return value
        })
        .catch(function() {
          return false
        })
    )
  }

  this.clear = function(target, isAutomatic) {
    if (redisCache) {
      return redisCache
        .clear(target)
        .then(function(deleteCount) {
          debug(deleteCount, 'keys cleared')
          return deleteCount
        })
        .catch(function() {
          debug('error in clear function')
        })
    }

    var group = index.groups[target]
    if (group) {
      debug('clearing group "' + target + '"')

      group.forEach(function(key) {
        debug('clearing cached entry for "' + key + '"')
        clearLongTimeout(timers[key])
        delete timers[key]
        memCache.delete(key)

        index.all = index.all.filter(doesntMatch(key))
      })

      delete index.groups[target]
    } else if (target || target === '') {
      debug('clearing ' + (isAutomatic ? 'expired' : 'cached') + ' entry for "' + target + '"')
      clearLongTimeout(timers[target])
      delete timers[target]
      // clear actual cached entry
      memCache.delete(target)

      // remove from global index
      index.all = index.all.filter(doesntMatch(target))

      // remove target from each group that it may exist in
      Object.keys(index.groups).forEach(function(groupName) {
        index.groups[groupName] = index.groups[groupName].filter(doesntMatch(target))

        var isGroupEmpty = !index.groups[groupName].length
        // delete group if now empty
        if (isGroupEmpty) {
          delete index.groups[groupName]
        }
      })
    } else {
      debug('clearing entire index')

      memCache.clear()

      this.resetIndex()
    }

    return this.getIndex()
  }

  function parseDuration(duration, defaultDuration) {
    if (typeof duration === 'number') return duration

    if (typeof duration === 'string') {
      var split = duration.match(/^([\d.,]+)\s?(\w+)$/)

      if (split.length === 3) {
        var len = parseFloat(split[1])
        var unit = split[2].replace(/s$/i, '').toLowerCase()
        if (unit === 'm') {
          unit = 'ms'
        }

        return (len || 1) * (t[unit] || 0)
      }
    }

    return defaultDuration
  }

  this.getDuration = function(duration) {
    return parseDuration(duration, globalOptions.defaultDuration)
  }

  /**
   * Return cache performance statistics (hit rate).  Suitable for putting into a route:
   * <code>
   * app.get('/api/cache/performance', (req, res) => {
   *    res.json(apicache.getPerformance())
   * })
   * </code>
   */
  this.getPerformance = function() {
    return performanceArray.map(function(p) {
      return p.report()
    })
  }

  this.getIndex = function(group) {
    if (redisCache) return redisCache.getIndex(group)
    if (group) {
      return index.groups[group]
    } else {
      return index
    }
  }

  function isLocalOptions(value) {
    return value !== null && typeof value === 'object'
  }
  function isMiddlewareToggle(value) {
    return typeof value === 'function'
  }
  this.middleware = function cache(strDuration, middlewareToggle, localOptions) {
    // Apicache#middleware(localOptions)
    if (isLocalOptions(strDuration)) {
      localOptions = strDuration
      middlewareToggle = null
      strDuration = null
      // Apicache#middleware(middlewareToggle[, localOptions])
    } else if (isMiddlewareToggle(strDuration)) {
      localOptions = middlewareToggle
      middlewareToggle = strDuration
      strDuration = null
      // Apicache#middleware([strDuration[, middlewareToggle[, localOptions]]])
    } else if (isLocalOptions(middlewareToggle)) {
      localOptions = middlewareToggle
      middlewareToggle = null
    }

    if (!localOptions) localOptions = {}
    var duration = parseDuration(strDuration)
    var opt = {}

    var middlewareOptionsIndex = middlewareOptions.length
    middlewareOptions.push({
      options: opt,
    })

    var options = function(localOptions) {
      if (localOptions) {
        if (localOptions.defaultDuration) {
          localOptions.defaultDuration = parseDuration(localOptions.defaultDuration)
          if ([null, undefined].indexOf(strDuration) !== -1) duration = localOptions.defaultDuration
        }
        middlewareOptions[middlewareOptionsIndex].localOptions = localOptions
        syncOptions(middlewareOptionsIndex)
      }
      return opt
    }

    options(localOptions)

    /**
     * A Function for non tracking performance
     */
    function NOOPCachePerformance() {
      this.report = this.hit = this.miss = function() {} // noop;
    }

    /**
     * A function for tracking and reporting hit rate.  These statistics are returned by the getPerformance() call above.
     */
    function CachePerformance() {
      /**
       * Tracks the hit rate for the last 100 requests.
       * If there have been fewer than 100 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast100 = new Uint8Array(100 / 4) // each hit is 2 bits

      /**
       * Tracks the hit rate for the last 1000 requests.
       * If there have been fewer than 1000 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast1000 = new Uint8Array(1000 / 4) // each hit is 2 bits

      /**
       * Tracks the hit rate for the last 10000 requests.
       * If there have been fewer than 10000 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast10000 = new Uint8Array(10000 / 4) // each hit is 2 bits

      /**
       * Tracks the hit rate for the last 100000 requests.
       * If there have been fewer than 100000 requests, the hit rate just considers the requests that have happened.
       */
      this.hitsLast100000 = new Uint8Array(100000 / 4) // each hit is 2 bits

      /**
       * The number of calls that have passed through the middleware since the server started.
       */
      this.callCount = 0

      /**
       * The total number of hits since the server started
       */
      this.hitCount = 0

      /**
       * The key from the last cache hit.  This is useful in identifying which route these statistics apply to.
       */
      this.lastCacheHit = null

      /**
       * The key from the last cache miss.  This is useful in identifying which route these statistics apply to.
       */
      this.lastCacheMiss = null

      /**
       * Return performance statistics
       */
      this.report = function() {
        return {
          lastCacheHit: this.lastCacheHit,
          lastCacheMiss: this.lastCacheMiss,
          callCount: this.callCount,
          hitCount: this.hitCount,
          missCount: this.callCount - this.hitCount,
          hitRate: this.callCount === 0 ? null : this.hitCount / this.callCount,
          hitRateLast100: this.hitRate(this.hitsLast100),
          hitRateLast1000: this.hitRate(this.hitsLast1000),
          hitRateLast10000: this.hitRate(this.hitsLast10000),
          hitRateLast100000: this.hitRate(this.hitsLast100000),
        }
      }

      /**
       * Computes a cache hit rate from an array of hits and misses.
       * @param {Uint8Array} array An array representing hits and misses.
       * @returns a number between 0 and 1, or null if the array has no hits or misses
       */
      this.hitRate = function(array) {
        var hits = 0
        var misses = 0
        for (var i = 0; i < array.length; i++) {
          var n8 = array[i]
          for (var j = 0; j < 4; j++) {
            switch (n8 & 3) {
              case 1:
                hits++
                break
              case 2:
                misses++
                break
            }
            n8 >>= 2
          }
        }
        var total = hits + misses
        if (total === 0) return null
        return hits / total
      }

      /**
       * Record a hit or miss in the given array.  It will be recorded at a position determined
       * by the current value of the callCount variable.
       * @param {Uint8Array} array An array representing hits and misses.
       * @param {boolean} hit true for a hit, false for a miss
       * Each element in the array is 8 bits, and encodes 4 hit/miss records.
       * Each hit or miss is encoded as to bits as follows:
       * 00 means no hit or miss has been recorded in these bits
       * 01 encodes a hit
       * 10 encodes a miss
       */
      this.recordHitInArray = function(array, hit) {
        var arrayIndex = ~~(this.callCount / 4) % array.length
        var bitOffset = (this.callCount % 4) * 2 // 2 bits per record, 4 records per uint8 array element
        var clearMask = ~(3 << bitOffset)
        var record = (hit ? 1 : 2) << bitOffset
        array[arrayIndex] = (array[arrayIndex] & clearMask) | record
      }

      /**
       * Records the hit or miss in the tracking arrays and increments the call count.
       * @param {boolean} hit true records a hit, false records a miss
       */
      this.recordHit = function(hit) {
        this.recordHitInArray(this.hitsLast100, hit)
        this.recordHitInArray(this.hitsLast1000, hit)
        this.recordHitInArray(this.hitsLast10000, hit)
        this.recordHitInArray(this.hitsLast100000, hit)
        if (hit) this.hitCount++
        this.callCount++
      }

      /**
       * Records a hit event, setting lastCacheMiss to the given key
       * @param {string} key The key that had the cache hit
       */
      this.hit = function(key) {
        this.recordHit(true)
        this.lastCacheHit = key
      }

      /**
       * Records a miss event, setting lastCacheMiss to the given key
       * @param {string} key The key that had the cache miss
       */
      this.miss = function(key) {
        this.recordHit(false)
        this.lastCacheMiss = key
      }
    }

    var perf = globalOptions.trackPerformance ? new CachePerformance() : new NOOPCachePerformance()

    performanceArray.push(perf)

    var cache = function(req, res, next) {
      if (isKoa(req)) {
        var ctx = req
        next = res
        res = ctx.res

        if (req.apicacheIsFrameworkAdapted) {
          req = ctx.req
        } else {
          req.apicacheIsFrameworkAdapted = true
          ;[ctx, ctx.req, ctx.request, ctx.res, ctx.response].forEach(function(obj) {
            if ('apicacheGroup' in obj && !('apicacheGroup' in ctx.state)) {
              ctx.state.apicacheGroup = obj.apicacheGroup
            }
            Object.defineProperty(obj, 'apicacheGroup', {
              get() {
                return ctx.state.apicacheGroup
              },
              set(v) {
                ctx.state.apicacheGroup = v
              },
            })
          })

          // It will e.g. delegate req.query to ctx.query which delegates to ctx.request.query
          // And make it work as ctx for getting it's future props at options.append, for instance
          // at a downstream apicache middleware
          req = delegateLazily(ctx.req, ctx)
        }
      }

      function bypass() {
        debug('bypass detected, skipping cache.')
        return next()
      }

      // initial bypass chances
      if (!opt.enabled) return bypass()
      if (
        opt.isBypassable &&
        (req.headers['cache-control'] === 'no-store' ||
          ['1', 'true'].indexOf(req.headers['x-apicache-bypass']) !== -1 ||
          ['1', 'true'].indexOf(req.headers['x-apicache-force-fetch']) !== -1)
      ) {
        return bypass()
      }

      // this can change at runtime
      duration = instance.getDuration(duration)
      if (opt.optimizeDuration && opt.append && duration > FIVE_MINUTES) {
        duration = FIVE_MINUTES
      }

      // embed timer
      req.apicacheTimer = new Date()

      var keyParts = getKeyParts(req, res, opt)
      var key = instance.getKey(keyParts)
      var cache = redisCache || memCache

      // can have different keys e.g. one middleware has appendice while the other one doesn't
      var makeResponseCacheableCount = `makeResponseCacheableCount${key}`
      function _makeResponseCacheable() {
        try {
          perf.miss(key)
          req[makeResponseCacheableCount] = (req[makeResponseCacheableCount] || 0) + 1
          return makeResponseCacheable(
            req,
            res,
            next,
            key,
            duration,
            strDuration,
            middlewareToggle,
            opt,
            function() {
              if (--req[makeResponseCacheableCount] > 0) return Promise.resolve()
              return cache.releaseLockWithId(
                'make-cacheable:' + key,
                typeof req.id === 'function' ? req.id() : req.id
              )
            }
          )
        } catch (err) {
          debug(err)
          return next()
        }
      }

      function isSameRequestStackAllowedToMakeResponseCacheable() {
        return cache.acquireLockWithId(
          'make-cacheable:' + key,
          typeof req.id === 'function' ? req.id() : req.id
        )
      }

      function maybeMakeResponseCacheable() {
        if (!req.id) {
          req.id = generateUuidV4()
        }

        return isSameRequestStackAllowedToMakeResponseCacheable().then(function(isAllowed) {
          if (isAllowed) return Promise.resolve(_makeResponseCacheable())
          else {
            // don't wait for first concurrent request finish its response
            // (e.g. don't wait for a full download of a large file),
            // but also don't let this one add to cache
            if (SAFE_HTTP_METHODS.indexOf(req.method) !== -1) return next()

            // give time to prior request finish caching
            return new Promise(function(resolve) {
              setLongTimeout(function() {
                resolve(attemptCacheHit())
              }, 10)
            })
          }
        })
      }

      function getCached(key, withFallback) {
        if (withFallback === undefined) withFallback = true
        return Promise.resolve(cache.getValue(key)).then(function(cached) {
          if (cached) {
            cached.key = key
          } else if (req.method === 'HEAD' && withFallback) {
            var getMethodKey = getSimilarKeyFromOtherMethod(key, 'head', 'get')
            return getCached(getMethodKey, false)
          }

          return cached
        })
      }

      function attemptCacheHit() {
        return getCached(key)
          .then(function(cached) {
            if (cached) {
              perf.hit(key)
              try {
                return sendCachedResponse(req, res, cached, middlewareToggle, next, duration, opt)
              } catch (err) {
                debug(err)
                if (res.headersSent) {
                  perf.miss(key)
                  if (isKoa(req)) req.respond = false
                  return res.end()
                }

                return maybeMakeResponseCacheable()
              }
            } else {
              return maybeMakeResponseCacheable()
            }
          })
          .catch(function(err) {
            debug(err)
            perf.miss(key)
            if (res.headersSent) {
              if (isKoa(req)) req.respond = false
              res.end()
            } else return next()
          })
      }

      return attemptCacheHit()
    }

    cache.options = options

    return cache
  }

  this.options = function(options) {
    if (options) {
      var redisConnectionChanged =
        (options.redisClient !== undefined && globalOptions.redisClient !== options.redisClient) ||
        (options.redisPrefix !== undefined && globalOptions.redisPrefix !== options.redisPrefix)
      Object.assign(globalOptions, options)
      if ('defaultDuration' in options) {
        // Convert the default duration to a number in milliseconds (if needed)
        globalOptions.defaultDuration = parseDuration(globalOptions.defaultDuration, 3600000)
      }
      syncOptions()

      if (globalOptions.trackPerformance) {
        debug('WARNING: using trackPerformance flag can cause high memory usage!')
      }

      if (redisConnectionChanged) this.initRedis()
      return this
    } else {
      return globalOptions
    }
  }

  this.resetIndex = function() {
    index = {
      all: [],
      groups: {},
    }
  }

  this.initRedis = function() {
    if (!globalOptions.redisClient) redisCache = null
    else redisCache = new RedisCache(globalOptions, debug)
  }

  this.newInstance = function(config) {
    var instance = new ApiCache()

    if (config) {
      instance.options(config)
    }

    return instance
  }

  this.clone = function() {
    return this.newInstance(this.options())
  }

  // initialize index
  this.resetIndex()
  this.initRedis()

  function _this() {
    return this.middleware.apply(this, arguments)
  }
  return Object.assign(_this.bind(this), this)
}

module.exports = new ApiCache()
