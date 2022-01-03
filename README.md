# Effortless api response caching for Express/Node using plain-english durations.

#### Supports Redis or built-in memory engine with auto-clearing.

[![npm version](https://badge.fury.io/js/apicache-plus.svg)](https://www.npmjs.com/package/apicache-plus)
[![node version support](https://img.shields.io/node/v/apicache-plus.svg)](https://www.npmjs.com/package/apicache-plus)
[![Build Status via Travis CI](https://app.travis-ci.com/arthurfranca/apicache-plus.svg?branch=master)](https://app.travis-ci.com/arthurfranca/apicache-plus)
[![Known Vulnerabilities](https://snyk.io/test/github/arthurfranca/apicache-plus/badge.svg?targetFile=package.json)](https://snyk.io/test/github/arthurfranca/apicache-plus?targetFile=package.json)
[![NPM downloads](https://img.shields.io/npm/dt/apicache-plus.svg?style=flat)](https://www.npmjs.com/package/apicache-plus)

## Why?

Because route-caching of simple data/responses should ALSO be simple.

## Usage

To use, simply inject the middleware (example: `apicache('5 minutes', [optionalMiddlewareToggle], [optionalConfig])`) into your routes. Everything else is automagic.

#### Cache a route

```js
import express from 'express'
import apicache from 'apicache-plus'

const app = express()

app.get('/api/collection/:id?', apicache('5 minutes'), (req, res) => {
  // do some work... this will only occur once per 5 minutes
  res.json({ foo: 'bar' })
})
```

#### Cache all routes

```js
import apicache from 'apicache-plus'
import express from 'express'
const app = express()

app.use(apicache('5 minutes'))

app.get('/will-be-cached', (req, res) => {
  res.json({ success: true })
})
```

#### Use with Redis for multiple benefits

```js
import apicache from 'apicache-plus'
import Redis from 'ioredis'
import express from 'express'
const app = express()

// if redisClient option is defined, apicache will use redis client
// instead of built-in memory store
const cacheWithRedis = apicache.options({
  redisClient: new Redis(),
})

app.get('/will-be-cached', cacheWithRedis('5 minutes'), (req, res) => {
  res.json({ success: true })
})
```

**Note:** We recommend ioredis for best support.
If using node-redis v3, it is important to set `detect_buffers: true`. Use `legacyMode: true` if v4+.

#### Works great with compression middleware for lightning fast responses

```js
import compression from 'compression'
import apicache from 'apicache-plus'
import express from 'express'
const app = express()

app.use(compression())
app.use(apicache('5 minutes'))
```

#### Purge cache easily whenever required

```js
import apicache from 'apicache-plus'
import express from 'express'
const app = express()

// cache all routes
app.use(apicache('1 hour'))

// show all books
app.get('/api/books', (req, res) => {
  // all GET requests to /api/books with any query/body params will be grouped for later purging
  req.apicacheGroup = 'bookList'

  res.json(Book.all(req.query))
})

// add a book, then purge related cache
app.post('/api/books', (req, res) => {
  Book.create(req.body.book)
  // purge now that book list should be updated with one more book
  apicache.clear('bookList')
  res.end()
})

// delete a book, then purge related cache
app.delete('/api/books/:id', (req, res) => {
  Book.delete(req.params.id)
  // purge now that book list should be updated with one less book
  apicache.clear('bookList')
  res.end()
})
```

**Note:** It is better to purge by apicacheGroup name as shown above instead of purging by key name so to not need to manually overwrite Cache-Control header nor mess with key name creation logic

#### Use with middleware toggle for fine control

```js
import apicache from 'apicache-plus'
import express from 'express'
const app = express()

// the default config is good enough, but if e.g you want to cache only responses of status 200
const onlyStatus200 = (req, res) => res.statusCode === 200
const cacheSuccesses = apicache('5 minutes', onlyStatus200)

app.get('/api/missing', cacheSuccesses, (req, res) => {
  res.status(404).json({ results: 'will not be cached' })
})

app.get('/api/found', cacheSuccesses, (req, res) => {
  res.json({ results: 'will be cached' })
})
```

## Custom Cache Keys

Sometimes you need custom keys (e.g. save routes per-session / user).
We've made it easy!

**Note:** All req/res attributes used in the generation of the key must have been set
previously (upstream). The entire route logic block is skipped on future cache hits
so it can't rely on those params.

```js
import apicache from 'apicache-plus'

apicache.options({
  append: (req, res) => res.session.id,
})
```

## Unleash caching power with manual control

You may want to manually cache any value to retrieve super fast later if needed (with or without using apicache as middleware, you decide).

```js
import apicache from 'apicache-plus'
import express from 'express'
const app = express()

// "authenticate" is supposed to be a middleware that would set req.userId = id
app.use(authenticate)
// Optional: use apicache to cache routes
app.use(
  apicache(
    '5 minutes',
    { append: req => req.userId } // custom option to separate cache by user
  )
)

app.get('/api/books', async function(req, res) {
  let books

  // manually check if what you want is already cached
  if (await apicache.has('books')) {
    // manually fetch from cache what you want
    books = await apicache.get('books')
  }

  if (!books) {
    books = await fetch('https://www.slow-external-api.com/all-books')
      .then(res => res.json())
      .then(async books => {
        // manually cache what you want, for how long you need
        await apicache.set('books', books, '1 hour')
        return books
      })
  }

  res.json(filterByUser(books, req.userId))
})
```

## API

- `apicache.options([globalOptions])` - getter/setter for global options. If used as a setter, this function is chainable, allowing you to do things such as... say... return the middleware.
- `apicache.middleware([duration], [toggleMiddleware], [localOptions])` - the actual middleware that will be used in your routes. `duration` is in the following format "[length][unit]", as in `"10 minutes"` or `"1 day"`. A second param is a middleware toggle function, accepting request and response params, and must return truthy to enable cache for the request. Third param is the options that will override global ones and affect this middleware only.
- `apicache([duration], [toggleMiddleware], [localOptions])` is a shortcut to `apicache.middleware([duration], [toggleMiddleware], [localOptions])`
- `middleware.options([localOptions])` - getter/setter for middleware-specific options that will override global ones.
- `apicache.getPerformance()` - returns current cache performance (cache hit rate)
- `apicache.getIndex()` - returns current cache index [of keys]
- `apicache.clear([target])` - clears cache target (key or group), or entire cache if no value passed, returns new index.
- `apicache.set(key, value, [duration[, group[, [expirationCallback]]])` - manually store anything you want (async)
- `apicache.get()` - get stored value by key (async)
- `apicache.has(key)` - check if key exists (async)
- `apicache.getKey(keyParts)` - useful for getting key name from auto caching middleware. Usage: `const key = await apicache.getKey({ method: 'GET', url: '/api/books/15', params: { aQueryParamX: 'value 1', aBodyParamY: 'value 2' }, appendice: 'userid-123-abc' })` then `await apicache.get(key)`
- `apicache.newInstance([options])` - used to create a new ApiCache instance (by default, simply requiring this library shares a common instance)
- `apicache.clone()` - used to create a new ApiCache instance with the same options as the current one

#### Available Options (first value is default)

```js
{
  debug:                false|true,          // if true, enables console output
  defaultDuration:      '1 hour',            // should be either a number (in ms) or a number with a string, defaults to 1 hour
  enabled:              true|false,          // if false, turns off caching globally (useful on dev)
  isBypassable:         false|true,          // if true, bypasses cache by requesting with Cache-Control: no-store header
  redisClient:          client,              // if provided, uses the [node-redis](https://github.com/NodeRedis/node_redis) or [ioredis](https://github.com/luin/ioredis) client instead of built-in memory cache
  append:               fn(req, res),        // append takes the req/res objects and returns a custom value to extend the cache key
  interceptKeyParts:    fn(req, res, parts), // change cache key name by altering the parts that make up key name (parts is an object auto-populated like this: { method: 'GET', url: '/api/test', params: { sort: 'desc', page: 2 }, appendice: 'userid-123-abc' }). For instance, if you want to cache with same key all requests to a specific route no matter the method (GET, POST etc): function(req, res, parts) { parts.method = ''; return parts }
  headerBlacklist:      [],                  // list of headers that should never be cached
  statusCodes: {                             // in most cases there is no need to set it as the default config will be enough
    exclude:            [],                  // list status codes to specifically exclude (e.g. [404, 403] cache all responses unless they had a 404 or 403 status)
    include:            []                   // list status codes to require (e.g. [200] caches ONLY responses with a success/200 code)
  },
  trackPerformance:     false|true,          // enable/disable performance tracking... WARNING: super cool feature, but may cause memory overhead issues
  headers: {
    // 'cache-control':  'no-cache'          // example of header overwrite
  },
  afterHit:             fn(req, res),        // run function after cache hits
  optimizeDuration:     false|true,          // it can lower memory comsumption, when not using a cache client with a max memory policy (e.g. LRU key eviction), by overwriting some cache durations
  shouldSyncExpiration: false|true           // force max-age syncing with internal cache expiration
}
```

##### \*Optional: Typescript Types (courtesy of [@danielsogl](https://github.com/danielsogl))

```bash
$ npm install -D @types/apicache
```

## Debugging/Console Out

#### Using Node environment variables (plays nicely with the hugely popular [debug](https://www.npmjs.com/package/debug) module)

```
$ export DEBUG=apicache
$ export DEBUG=apicache,othermoduleThatDebugModuleWillPickUp,etc
```

#### By setting internal option

```js
import apicache from 'apicache-plus'

apicache.options({ debug: true })
```

## Official framework support

- Express
- Restify
- Koa

**Note:** When using Koa, set `ctx.state.apicacheGroup` instead of `req.apicacheGroup`. Also, consider option values such as `(req, res) => {}` as being `(ctx) => {}`. You can use Koa style naturally e.g. set `ctx.body` instead of calling `res.send`

### Changelog

- **v2.3.1** - improve serialization when manually adding to redis cache
- **v2.3.0** - enhance concurrency behavior
- **v2.2.3** - fix fetching big cached redis response
- **v2.2.2** - fix redisCache.get method
- **v2.2.1** - fix head request handler
- **v2.2.0** - add Koa 2 support
- **v2.1.3** - fix acquireLockWithId reference (thanks [@it4mag](https://github.com/it4mag))
- **v2.1.2** - add compressible missing dependency (thanks [@rrgarciach](https://github.com/rrgarciach))
- **v2.1.1** - fix RedisCache#releaseLockWithId
- **v2.1.0** - add optimizeDuration option and set 'private' cache when fit
- **v2.0.2** - add .middleware function overloading and improve cache-control setting
- **v2.0.1** - fix cache.get(autoKeyName) when cache is compressed and make headerBlacklist case-insensitive
- **v2.0.0** - major launch with better defaults for easier usage, manual caching (.get, .set, .has), new options and improved compatibility with third-party compression middlewares
- **v1.8.0** - add isBypassable and afterHit options and extra 304 condition checks
- **v1.7.0** - enforce request idempotence by cache key when not cached yet
- **v1.6.0** - cache is always stored compressed, can attach multiple apicache middlewares to same route for conditional use, increase third-party compression middleware compatibility and some minor bugfixes
- **v1.5.5** - self package import fix (thanks [@robbinjanssen](https://github.com/robbinjanssen))
- **v1.5.4** - created apicache-plus from apicache v1.5.3 with backward compatibility (thanks [@kwhitley](https://github.com/kwhitley) and [all original library contributors](https://github.com/kwhitley/apicache#contributors))
