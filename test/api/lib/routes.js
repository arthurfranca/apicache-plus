var movies = require('./data.json')

module.exports = function(app) {
  app.requestsProcessed = 0

  app.get('/api/movies', function(req, res) {
    app.requestsProcessed++

    res.json(movies)
  })

  app.get('/api/params/:where', function(req, res) {
    app.requestsProcessed++

    res.json(movies)
  })

  app.get('/api/writeandend', function(req, res) {
    app.requestsProcessed++

    res.setHeader('Content-Type', 'text/plain')
    res.write('a')
    res.write('b')
    res.write('c')

    res.end()
  })

  app.get('/api/writebufferandend', function(req, res) {
    app.requestsProcessed++

    res.setHeader('Content-Type', 'text/plain')
    res.write(Buffer.from('a'))
    res.write(Buffer.from('b'))
    res.write(Buffer.from('c'))

    res.end()
  })

  app.get('/api/testheaderblacklist', function(req, res) {
    app.requestsProcessed++
    res.set('x-blacklisted', app.requestsProcessed)
    res.set('x-notblacklisted', app.requestsProcessed)

    res.json(movies)
  })

  app.get('/api/testcachegroup', function(req, res) {
    app.requestsProcessed++
    req.apicacheGroup = 'cachegroup'

    res.json(movies)
  })

  app.get('/api/text', function(req, res) {
    app.requestsProcessed++
    res.setHeader('Content-Type', 'text/plain')

    res.send('plaintext')
  })

  app.get('/api/html', function(req, res) {
    app.requestsProcessed++
    res.setHeader('Content-Type', 'text/html')

    res.send('<html>')
  })

  app.get('/api/missing', function(req, res) {
    app.requestsProcessed++

    res.status(Number(req.headers['status-code']) || 404)
    res.json({ success: false, message: 'Resource not found' })
  })

  app.get('/api/movies/:index', function(req, res) {
    app.requestsProcessed++

    res.json(movies[req.params.index])
  })

  function bigResponseHandler(req, res) {
    app.requestsProcessed++
    req.apicacheGroup = 'bigresponsegroup'

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

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    rstream.pipe(res)
  }
  app.get('/api/bigresponse', bigResponseHandler)
  app.post('/api/bigresponse', bigResponseHandler)

  app.get('/api/slowresponse', function(req, res) {
    app.requestsProcessed++

    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('hello ')
    setTimeout(function() {
      res.write('world')
      res.end()
    }, 100)
  })

  app.get('/api/ifmodifiedsince', function(req, res) {
    app.requestsProcessed++

    var _setHeader = res.setHeader
    res.setHeader = function(name) {
      if (name === 'etag') return res
      return _setHeader.apply(res, arguments)
    }
    res.writeHead(200, { 'Last-Modified': new Date().toUTCString() })
    res.write('hi')
    res.end()
  })

  app.get('/api/notransform', function(req, res) {
    app.requestsProcessed++

    res.writeHead(200, { 'Cache-Control': 'no-transform' })
    res.write('hi')
    res.end()
  })

  app.get('/api/afterhit', function(req, res) {
    app.requestsProcessed++

    res.writeHead(200, { 'Response-After-Hit': '1' })
    res.write('after hit')
    res.end()
  })

  return app
}
