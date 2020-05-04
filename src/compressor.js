module.exports = Compressor

var compressible = require('compressible')
var zlib = require('zlib')
var stream = require('stream')
var THRESHOLD = 1024
var NO_CONTENT_AND_NOT_MODIFIED_STATUS_CODES = [204, 304]
var CACHE_CONTROL_NO_TRANSFORM_REGEX = /(?:^|,)\s*?no-transform\s*?(?:,|$)/
var MIN_CHUNK_SIZE = 64
var DEFAULT_HIGH_WATER_MARK = 16384

function Compressor(options, debug) {
  Object.assign(this, options)
  this.debug = debug || function() {}
}

// options { chunkSize, responseStatusCode, requestMehod, responseMethod, responseHeaders }
Compressor.run = function(options, debug) {
  return new Compressor(options, debug).run()
}

Compressor.prototype.clientDoesntWantContent = function() {
  return (
    this.requestMehod === 'HEAD' ||
    NO_CONTENT_AND_NOT_MODIFIED_STATUS_CODES.indexOf(this.responseStatusCode) !== -1
  )
}

Compressor.prototype.isAlreadyCompressed = function() {
  return (this.responseHeaders['content-encoding'] || 'identity') !== 'identity'
}

Compressor.prototype.isContentLengthBellowThreshold = function() {
  if (
    [null, undefined, ''].indexOf(this.responseHeaders['content-length']) !== -1 &&
    // if res.end wasnt called first, content length can't be inferred from chunk size
    this.responseMethod !== 'end'
  ) {
    return false
  }

  var contentLength = Number(this.responseHeaders['content-length']) || this.chunkSize
  return contentLength < THRESHOLD
}

Compressor.prototype.isContentUncompressible = function() {
  return (
    !this.responseHeaders['content-type'] || !compressible(this.responseHeaders['content-type'])
  )
}

Compressor.prototype.shouldntTransform = function() {
  return CACHE_CONTROL_NO_TRANSFORM_REGEX.test(this.responseHeaders['cache-control'] || '')
}

Compressor.prototype.shouldCompress = function() {
  if (
    this.clientDoesntWantContent() ||
    this.isAlreadyCompressed() ||
    this.isContentLengthBellowThreshold() ||
    this.isContentUncompressible() ||
    this.shouldntTransform()
  ) {
    return false
  } else return true
}

Compressor.prototype.updateVaryHeader = function() {
  if (this.responseHeaders['vary'] === '*') return

  if (!/Accept-Encoding/.test(this.responseHeaders['vary'] || '')) {
    this.responseHeaders['vary'] = [this.responseHeaders['vary'], 'Accept-Encoding']
      .filter(Boolean)
      .join(', ')
  }
}

Compressor.prototype.updateHeaders = function(encoding) {
  this.updateVaryHeader()
  this.responseHeaders['content-encoding'] = encoding
  delete this.responseHeaders['content-length']
}

Compressor.prototype.run = function() {
  try {
    if (!this.shouldCompress()) return new stream.PassThrough()

    var encoding
    var tstream
    var chunkSize = Math.max(MIN_CHUNK_SIZE, this.chunkSize || DEFAULT_HIGH_WATER_MARK)

    // choose best compression method available
    // (don't care about what request accepts, as cache will be reused by many different clients)
    if (zlib.createBrotliCompress) {
      encoding = 'br'
      tstream = zlib.createBrotliCompress({
        chunkSize,
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
        },
      })
    } else {
      encoding = 'gzip'
      tstream = zlib.createGzip({
        chunkSize,
        params: {
          level: (zlib.constants && zlib.constants.Z_BEST_COMPRESSION) || 9,
        },
      })
    }
    this.updateHeaders(encoding)

    return tstream.on('error', function() {
      this.unpipe()
      // if node < 8
      if (!this.destroy) return this.pause()
      this.destroy()
    })
  } catch (err) {
    this.debug(err)
    return new stream.PassThrough()
  }
}
