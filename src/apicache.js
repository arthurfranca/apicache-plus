var url = require('url')
var zlib = require('zlib')
var accepts = require('accepts')
var stream = require('stream')
var generateUuidV4 = require('uuid').v4
var MemoryCache = require('./memory-cache')
var RedisCache = require('./redis-cache')
var Compressor = require('./compressor')
var pkg = require('../package.json')

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
    isBypassable: true,
    appendKey: null,
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
    afterHit: null,
    trackPerformance: false,
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

  function filterBlacklistedHeaders(headers) {
    return Object.keys(headers)
      .filter(function(key) {
        return globalOptions.headerBlacklist.indexOf(key) === -1
      })
      .reduce(function(acc, header) {
        acc[header] = headers[header]
        return acc
      }, {})
  }

  function createCacheObject(status, headers, data, encoding) {
    return {
      status: status,
      headers: filterBlacklistedHeaders(headers),
      data: data,
      encoding: encoding,
      timestamp: new Date().getTime() / 1000, // seconds since epoch.  This is used to properly decrement max-age headers in cached responses.
    }
  }

  function cacheResponse(key, value, duration) {
    var expireCallback = globalOptions.events.expire
    memCache.add(key, value, duration, expireCallback)

    // add automatic cache clearing from duration, includes max limit on setTimeout
    timers[key] = setTimeout(function() {
      instance.clear(key, true)
    }, Math.min(duration, 2147483647))
  }

  function debugCacheAddition(cache, key, strDuration, req, res) {
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
            cached.encoding
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

  function getCurrentResponseHeaders(res, statusMsgOrHeaders, maybeHeaders) {
    if (statusMsgOrHeaders && typeof statusMsgOrHeaders !== 'string') {
      maybeHeaders = statusMsgOrHeaders
    }
    if (!maybeHeaders) maybeHeaders = {}

    var currentResponseHeaders = getSafeHeaders(res)
    Object.keys(maybeHeaders).forEach(function(name) {
      currentResponseHeaders[name.toLowerCase()] = maybeHeaders[name]
    })

    return currentResponseHeaders
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

    function customWriteHead(statusCode, statusMsgOrHeaders, maybeHeaders) {
      res.statusCode = statusCode

      // add cache control headers
      if (!options.headers['cache-control']) {
        if (
          SAFE_HTTP_METHODS.indexOf(req.method) !== -1 &&
          shouldCacheRes(req, res, toggle, options)
        ) {
          res.setHeader(
            'cache-control',
            'max-age=' +
              (req.apicacheGroup ? 3 : (duration / 1000).toFixed(0)) +
              ', must-revalidate'
          )
        } else {
          res.setHeader('cache-control', 'no-store')
        }
      }

      if (shouldCacheRes(req, res, toggle, options)) {
        // append header overwrites if applicable
        Object.keys(options.headers).forEach(function(name) {
          res.setHeader(name, options.headers[name])
        })
        res._currentResponseHeaders = getCurrentResponseHeaders(
          res,
          statusMsgOrHeaders,
          maybeHeaders
        )
        res._shouldCacheResWriteHeadVersionAlreadyRun = true
      }
    }

    res.writeHead = function(statusCode, statusMsgOrHeaders, maybeHeaders) {
      if (res._shouldCacheResWriteHeadVersionAlreadyRun) {
        return apicacheResPatches.writeHead.apply(this, arguments)
      }

      customWriteHead(statusCode, statusMsgOrHeaders, maybeHeaders)

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
          return createCacheObject(res.statusCode, res._currentResponseHeaders || {})
        }
        var getGroup = function() {
          return req.apicacheGroup
        }
        var expireCallback = globalOptions.events.expire
        var cache = redisCache || memCache
        var chunkSize =
          // if res.end was called first (without calling write), it will have only one chunk
          method === 'end'
            ? Buffer.byteLength(chunk || '', encoding)
            : res.socket.writableHighWaterMark

        var cacheWstream = cache
          .createWriteStream(
            key,
            getCacheObject,
            duration,
            expireCallback,
            getGroup,
            chunkSize,
            // this is needed while memCache index/groups are still handled externally
            !redisCache &&
              function(statusCode, headers, data, encoding) {
                addIndexEntries(key, req)
                var cacheObject = createCacheObject(statusCode, headers, data, encoding)
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
                debugCacheAddition(cache, key, strDuration, req, res)
              })
              .on('unpipe', afterTryingToCache)
          })

        return (wstream = cacheWstream.then(function(wstream) {
          if (wstream.isLocked) return wstream

          // some middlewares will preset content-encoding to e.g. gzip too early
          // even if apicache is about to receive uncompressed response stream (middleware attached before apicache's one)
          fixEncodingHeaders(chunk, res._currentResponseHeaders)

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
          customWriteHead(res.statusCode, res.statusMsgOrHeaders, getSafeHeaders(res))
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

    if (options.afterHit) {
      response.on('finish', function() {
        options.afterHit(request, response)
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
    var updatedMaxAge = parseInt(
      duration / 1000 - (new Date().getTime() / 1000 - cacheObject.timestamp),
      10
    )

    Object.assign(headers, filterBlacklistedHeaders(cacheObjectHeaders), {
      // set properly-decremented max-age header.  This ensures that max-age is in sync with the cache expiration.
      'cache-control': (
        cacheObjectHeaders['cache-control'] ||
        (SAFE_HTTP_METHODS.indexOf(request.method) !== -1
          ? 'max-age=' + updatedMaxAge + ', must-revalidate'
          : 'no-store')
      ).replace(/max-age=\s*([+-]?\d+)/, function(_match, cachedMaxAge) {
        return 'max-age=' + Math.max(0, Math.min(parseInt(cachedMaxAge, 10), updatedMaxAge))
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
          response.socket.writableHighWaterMark
        )
        .on('error', function() {
          debug('error in sendCachedResponse function')
          response.end()
        })
    }

    // dont use headers['content-encoding'] as it may be already changed to gzip by some middleware
    var cachedEncoding = (cacheObjectHeaders['content-encoding'] || 'identity').split(',')[0]
    var requestAccepts = accepts(request)
    if (
      (cachedEncoding === 'identity' ||
        !CACHE_CONTROL_NO_TRANSFORM_REGEX.test(headers['cache-control'] || '')) &&
      requestAccepts.encodings(cachedEncoding)
    ) {
      // Doing response.writeHead(cacheObject.status || 200, headers)
      // can make writeHead patch from some compression middlewares fail
      // Using res.writeHead with headers that don't mess with content-length / content-encoding
      // would mostly be ok
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

  function syncOptions() {
    for (var i in middlewareOptions) {
      Object.assign(middlewareOptions[i].options, globalOptions, middlewareOptions[i].localOptions)
    }
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
        clearTimeout(timers[key])
        delete timers[key]
        memCache.delete(key)

        index.all = index.all.filter(doesntMatch(key))
      })

      delete index.groups[target]
    } else if (target) {
      debug('clearing ' + (isAutomatic ? 'expired' : 'cached') + ' entry for "' + target + '"')
      clearTimeout(timers[target])
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

  this.middleware = function cache(strDuration, middlewareToggle, localOptions) {
    var duration = instance.getDuration(strDuration)
    var opt = {}

    middlewareOptions.push({
      options: opt,
    })

    var options = function(localOptions) {
      if (localOptions) {
        middlewareOptions.find(function(middleware) {
          return middleware.options === opt
        }).localOptions = localOptions
      }

      syncOptions()

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

      // REMOVED IN 0.11.1 TO CORRECT MIDDLEWARE TOGGLE EXECUTE ORDER
      // if (typeof middlewareToggle === 'function') {
      //   if (!middlewareToggle(req, res)) return bypass()
      // } else if (middlewareToggle !== undefined && !middlewareToggle) {
      //   return bypass()
      // }

      // embed timer
      req.apicacheTimer = new Date()

      // In Express 4.x the url is ambigious based on where a router is mounted.  originalUrl will give the full Url
      var key = req.originalUrl || req.url

      // Remove querystring from key if jsonp option is enabled
      if (opt.jsonp) {
        // eslint-disable-next-line node/no-deprecated-api
        key = url.URL ? new url.URL(key).pathname : url.parse(key).pathname
      }

      // add appendKey (either custom function or response path)
      if (opt.appendKey) {
        var appendKey

        if (typeof opt.appendKey === 'function') {
          appendKey = opt.appendKey(req, res)
        } else if (opt.appendKey.length > 0) {
          appendKey = req
          for (var i = 0; i < opt.appendKey.length; i++) {
            if (!appendKey) break
            appendKey = appendKey[opt.appendKey[i]]
          }
        }
        if (appendKey) key += '$$appendKey=' + appendKey
      }

      var cache = redisCache || memCache
      var _makeResponseCacheable = function() {
        try {
          perf.miss(key)
          req.makeResponseCacheableCount = (req.makeResponseCacheableCount || 0) + 1
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
              if (--req.makeResponseCacheableCount > 0) return Promise.resolve()
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

      var isSameRequestStackAllowedToMakeResponseCacheable = function() {
        return cache.acquireLockWithId(
          'make-cacheable:' + key,
          typeof req.id === 'function' ? req.id() : req.id
        )
      }
      var maybeMakeResponseCacheable = function() {
        if (!req.id) req.id = generateUuidV4()

        return isSameRequestStackAllowedToMakeResponseCacheable().then(function(isAllowed) {
          if (isAllowed) return Promise.resolve(_makeResponseCacheable())
          else {
            // give time to prior request finish caching
            return new Promise(function(resolve) {
              setTimeout(function() {
                resolve(attemptCacheHit())
              }, 10)
            })
          }
        })
      }

      function attemptCacheHit() {
        var cachedPromise = Promise.resolve(cache.getValue(key))

        return cachedPromise
          .then(function(cached) {
            if (cached) {
              perf.hit(key)
              try {
                return sendCachedResponse(req, res, cached, middlewareToggle, next, duration, opt)
              } catch (err) {
                debug(err)
                if (res.headersSent) {
                  perf.miss(key)
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
            if (res.headersSent) res.end()
            else next()
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
      syncOptions()

      if ('defaultDuration' in options) {
        // Convert the default duration to a number in milliseconds (if needed)
        globalOptions.defaultDuration = parseDuration(globalOptions.defaultDuration, 3600000)
      }

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
}

module.exports = new ApiCache()
