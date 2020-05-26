var stream = require('stream')
var helpers = require('./helpers')
var setLongTimeout = helpers.setLongTimeout
var clearLongTimeout = helpers.clearLongTimeout

function MemoryCache() {
  this.cache = {}
  this.size = 0
  this.lock = {}
  this.lockWithId = {}
}

var DEFAULT_LOCK_PTTL = 60 * 1000 // 60s will be the response init limit
MemoryCache.prototype.acquireLockWithId = function(key, id, pttl) {
  var that = this
  var lock = that.lockWithId[key]
  if (!pttl) pttl = DEFAULT_LOCK_PTTL

  return new Promise(function(resolve) {
    if (lock) {
      if (lock.heldBy === id) return resolve(true)
      else return resolve(false)
    }

    var timeout = setLongTimeout(function() {
      delete that.lockWithId[key]
    }, pttl)

    that.lockWithId[key] = {
      heldBy: id,
      timeout: timeout,
    }

    resolve(true)
  })
}

MemoryCache.prototype.releaseLockWithId = function(key, id) {
  var that = this

  return new Promise(function(resolve) {
    var lock = that.lockWithId[key]

    if (!lock) return resolve(true)
    else if (lock.heldBy === id) {
      clearLongTimeout(lock.timeout)
      delete that.lockWithId[key]
      return resolve(true)
    } else resolve(false)
  })
}

var DEFAULT_HIGH_WATER_MARK = 16384
MemoryCache.prototype.createWriteStream = function(
  key,
  getValue,
  _time,
  _timeoutCallback,
  _getGroup,
  highWaterMark,
  add
) {
  if (key in this.lock) {
    var wstream = new stream.Writable({
      write(_c, _e, cb) {
        cb()
      },
    })
    wstream.isLocked = true
    return Promise.resolve(wstream)
  }

  this.lock[key] = null
  if (!highWaterMark) highWaterMark = DEFAULT_HIGH_WATER_MARK

  var data
  var cacheEncoding
  var hasErrored = false
  var isBuffer = (function(isIt) {
    return function(chunk) {
      if (isIt !== undefined) return isIt
      return (isIt = Buffer.isBuffer(chunk))
    }
  })()
  var releaseLock = function() {
    delete this.lock[key]
  }.bind(this)

  var final = function(cb) {
    if (hasErrored) return cb()
    try {
      var value = getValue()
      if (cacheEncoding === 'buffer') {
        if ((value.headers['content-encoding'] || 'identity') === 'identity') {
          value.encoding = 'utf8'
        } else value.encoding = 'binary' // 'alias to latin1 from node >= v6.4.0'
      } else {
        value.encoding = cacheEncoding || 'utf8'
      }

      add(value.status, value.headers, data, value.encoding)
      cb()
    } catch (err) {
      cb(err)
    }
  }

  return Promise.resolve(
    new stream.Writable({
      highWaterMark: highWaterMark,
      write(chunk, encoding, cb) {
        if (hasErrored) return cb()
        try {
          if (data === undefined) {
            if (isBuffer(chunk)) data = Buffer.alloc(0)
            else data = ''
          }

          if (isBuffer(chunk)) data = Buffer.concat([data, chunk])
          else data += chunk
          cb()
        } catch (err) {
          cb(err)
        }
      },
      final: final,
    })
      .on('error', function() {
        hasErrored = true
        data = undefined
        releaseLock()
      })
      .on('finish', function() {
        // if node >= 8
        if (typeof this._final === 'function') return setImmediate(releaseLock)

        new Promise(function(resolve) {
          final(resolve)
        }).then(function() {
          setImmediate(releaseLock)
        })
      })
  )
}

MemoryCache.prototype.createReadStream = function(_key, data, encoding, highWaterMark) {
  if (!highWaterMark) highWaterMark = DEFAULT_HIGH_WATER_MARK
  if (!data) data = Buffer.alloc(0)
  var chunk
  var start = 0
  var end = highWaterMark
  var pushChunk = function(push) {
    chunk = data.slice(start, end)
    if (Buffer.byteLength(chunk, encoding) === 0) {
      chunk = null
    } else {
      start = end
      end = end + highWaterMark
    }
    var shouldPush = push(chunk)
    if (shouldPush) return pushChunk(push)
  }

  return new stream.Readable({
    highWaterMark: highWaterMark,
    read() {
      try {
        pushChunk(this.push.bind(this))
      } catch (err) {
        this.emit('error', err)
      }
    },
  }).on('error', function() {
    this.unpipe()
    // if node < 8
    if (!this.destroy) return this.pause()
    this.destroy()
  })
}

MemoryCache.prototype.add = function(key, value, time, timeoutCallback) {
  var instance = this

  var entry = {
    value: value,
    expire: time + Date.now(),
    timeout: setLongTimeout(function() {
      instance.delete(key)
      return timeoutCallback && typeof timeoutCallback === 'function' && timeoutCallback(value, key)
    }, time),
  }

  this.cache[key] = entry
  this.size = Object.keys(this.cache).length

  return entry
}

MemoryCache.prototype.delete = function(key) {
  var entry = this.cache[key]

  if (entry) {
    clearLongTimeout(entry.timeout)
    delete this.cache[key]
  }

  this.size = Object.keys(this.cache).length

  return null
}

MemoryCache.prototype.has = function(key) {
  return Promise.resolve(key in this.cache)
}

MemoryCache.prototype.get = function(key) {
  var entry = this.cache[key]

  return entry
}

MemoryCache.prototype.getValue = function(key) {
  var entry = this.get(key)

  return entry && entry.value
}

MemoryCache.prototype.clear = function() {
  Object.keys(this.cache).forEach(function(key) {
    this.delete(key)
  }, this)

  return true
}

module.exports = MemoryCache
