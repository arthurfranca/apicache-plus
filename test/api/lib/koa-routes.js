var movies = require('./data.json')

module.exports = function(app) {
  app.requestsProcessed = 0

  app.get('/api/movies', function(ctx) {
    app.requestsProcessed++

    ctx.body = movies
  })

  app.get('/api/params/:where', function(ctx) {
    app.requestsProcessed++

    ctx.body = movies
  })

  app.get('/api/writeandend', function(ctx) {
    app.requestsProcessed++

    ctx.respond = false
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'text/plain')
    ctx.res.write('a')
    ctx.res.write('b')
    ctx.res.write('c')

    ctx.res.end()
  })

  app.get('/api/writebufferandend', function(ctx) {
    app.requestsProcessed++

    ctx.respond = false
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'text/plain')
    ctx.res.write(Buffer.from('a'))
    ctx.res.write(Buffer.from('b'))
    ctx.res.write(Buffer.from('c'))

    ctx.res.end()
  })

  app.get('/api/testheaderblacklist', function(ctx) {
    app.requestsProcessed++
    ctx.set('x-blacklisted', app.requestsProcessed)
    ctx.set('x-notblacklisted', app.requestsProcessed)

    ctx.body = movies
  })

  app.get('/api/testcachegroup', function(ctx) {
    app.requestsProcessed++
    ctx.state.apicacheGroup = 'cachegroup'

    ctx.body = movies
  })

  app.get('/api/text', function(ctx) {
    app.requestsProcessed++
    ctx.set('Content-Type', 'text/plain')

    ctx.body = 'plaintext'
  })

  app.get('/api/html', function(ctx) {
    app.requestsProcessed++
    ctx.set('Content-Type', 'text/html')

    ctx.body = '<html>'
  })

  app.get('/api/missing', function(ctx) {
    app.requestsProcessed++

    ctx.status = Number(ctx.headers['status-code']) || 404
    ctx.body = { success: false, message: 'Resource not found' }
  })

  app.get('/api/movies/:index', function(ctx) {
    app.requestsProcessed++

    ctx.body = movies[ctx.params.index]
  })

  function bigResponseHandler(ctx) {
    app.requestsProcessed++
    ctx.state.apicacheGroup = 'bigresponsegroup'

    var chunkCount = 50
    var chunkLength = 16384
    var chunk = new Array(16384).fill('a').join('')
    var rstream = require('stream').Readable({
      highWaterMark: chunkLength,
      read() {
        if (chunkCount-- === 0) {
          this.push('final')
          this.push(null)
        } else this.push(chunk)
      },
    })

    ctx.set('Content-Type', 'text/plain')
    ctx.body = rstream
  }
  app.get('/api/bigresponse', bigResponseHandler)
  app.post('/api/bigresponse', bigResponseHandler)

  app.get('/api/slowresponse', function(ctx) {
    app.requestsProcessed++

    ctx.respond = false
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain' })
    ctx.res.write('hello ')
    setTimeout(function() {
      ctx.res.write('world')
      ctx.res.end()
    }, 100)
  })

  app.get('/api/ifmodifiedsince', function(ctx) {
    app.requestsProcessed++

    ctx.respond = false
    var _setHeader = ctx.res.setHeader
    ctx.res.setHeader = function(name) {
      if (name === 'etag') return ctx.res
      return _setHeader.apply(ctx.res, arguments)
    }
    ctx.res.writeHead(200, { 'Last-Modified': new Date().toUTCString() })
    ctx.res.write('hi')
    ctx.res.end()
  })

  app.get('/api/notransform', function(ctx) {
    app.requestsProcessed++

    ctx.set('Cache-Control', 'no-transform')
    ctx.body = 'hi'
  })

  app.get('/api/afterhit', function(ctx) {
    app.requestsProcessed++

    ctx.set('Response-After-Hit', '1')
    ctx.body = 'after hit'
  })

  return app
}
