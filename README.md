# Effortless api request caching for Express/Node using plain-english durations.

#### Supports Redis or built-in memory engine with auto-clearing.

[![npm version](https://badge.fury.io/js/apicache-plus.svg)](https://www.npmjs.com/package/apicache-plus)
[![node version support](https://img.shields.io/node/v/apicache-plus.svg)](https://www.npmjs.com/package/apicache-plus)
[![Build Status via Travis CI](https://travis-ci.org/arthurfranca/apicache-plus.svg?branch=master)](https://travis-ci.org/arthurfranca/apicache-plus)
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
app.use(apicache('5 minutes'))

app.get('/will-be-cached', (req, res) => {
  res.json({ success: true })
})
```

#### Use with Redis for multiple benefits

```js
import express from 'express'
import apicache from 'apicache-plus'
import redis from 'redis'

const app = express()

// if redisClient option is defined, apicache will use redis client
// instead of built-in memory store
const cacheWithRedis = apicache.options({
  redisClient: redis.createClient({ detect_buffers: true }),
})

app.get('/will-be-cached', cacheWithRedis('5 minutes'), (req, res) => {
  res.json({ success: true })
})
```

**Note:** If using node-redis client, it is important to set `detect_buffers: true` option.
ioredis client is also supported.

#### Works great with compression middleware for lightning fast responses

```js
import express from 'express'
import compression from 'compression'
import apicache from 'apicache-plus'

const app = express()

app.use(compression()).use(apicache)
```

#### Cache grouping and manual controls

```js
import apicache from 'apicache-plus'

// add route to display cache index
app.get('/api/cache/index', (req, res) => {
  res.json(apicache.getIndex())
})

// add route to manually clear target/group
app.delete('/api/cache/clear/:target?', (req, res) => {
  res.json(apicache.clear(req.params.target))
})

// add route to display cache performance
app.get('/api/cache/performance', (req, res) => {
  res.json(apicache.getPerformance())
})

app.use(apicache('5 minutes'))

// routes are automatically added to index, but may be further added
// to groups for quick deleting of collections
app.get('/api/:collection/:item?', (req, res) => {
  req.apicacheGroup = req.params.collection
  res.json({ success: true })
})

/*

GET /api/foo/bar --> caches entry at /api/foo/bar and adds a group called 'foo' to index
GET /api/cache/index --> displays index
DELETE /api/cache/clear/foo --> clears all cached entries for 'foo' group/collection

*/
```

#### Use with middleware toggle for fine control

```js
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

## API

- `apicache.options([globalOptions])` - getter/setter for global options. If used as a setter, this function is chainable, allowing you to do things such as... say... return the middleware.
- `apicache.middleware([duration], [toggleMiddleware], [localOptions])` - the actual middleware that will be used in your routes. `duration` is in the following format "[length][unit]", as in `"10 minutes"` or `"1 day"`. A second param is a middleware toggle function, accepting request and response params, and must return truthy to enable cache for the request. Third param is the options that will override global ones and affect this middleware only.
- `apicache([duration], [toggleMiddleware], [localOptions])` is a shortcut to `apicache.middleware([duration], [toggleMiddleware], [localOptions])`
- `middleware.options([localOptions])` - getter/setter for middleware-specific options that will override global ones.
- `apicache.getPerformance()` - returns current cache performance (cache hit rate)
- `apicache.getIndex()` - returns current cache index [of keys]
- `apicache.clear([target])` - clears cache target (key or group), or entire cache if no value passed, returns new index.
- `apicache.set(key, value, [duration], [group], [expirationCallback])` - manually store anything you want (async)
- `apicache.get()` - get stored value by key (async)
- `apicache.has(key)` - check if key exists (async)
- `apicache.getKey(keyParts)` - useful for getting key name from auto caching middleware. Usage: `const key = await apicache.getKey({ method: 'GET', url: '/api/users/15', params: {}, appendice: '' })` then `await apicache.get(key)`
- `apicache.newInstance([options])` - used to create a new ApiCache instance (by default, simply requiring this library shares a common instance)
- `apicache.clone()` - used to create a new ApiCache instance with the same options as the current one

#### Available Options (first value is default)

```js
{
  debug:                false|true,         // if true, enables console output
  defaultDuration:      '1 hour',           // should be either a number (in ms) or a string, defaults to 1 hour
  enabled:              true|false,         // if false, turns off caching globally (useful on dev)
  isBypassable:         false|true,         // if true, bypasses cache by requesting with Cache-Control: no-store header
  redisClient:          client,             // if provided, uses the [node-redis](https://github.com/NodeRedis/node_redis) client instead of [memory-cache](https://github.com/ptarjan/node-cache)
  appendKey:           fn(req, res),       // appendKey takes the req/res objects and returns a custom value to extend the cache key
  interceptKeyParts:    fn(req, res, parts) // change url key name. For instance, if you want to cache with same key all requests to an url with any method (GET, POST etc), function(req, res, parts) { parts.method = ''; return parts }
  headerBlacklist:      [],                 // list of headers that should never be cached
  statusCodes: {                         // in most cases there is no need to set it as the default config will be enough
    exclude:            [],                 // list status codes to specifically exclude (e.g. [404, 403] cache all responses unless they had a 404 or 403 status)
    include:            [],                 // list status codes to require (e.g. [200] caches ONLY responses with a success/200 code)
  },
  trackPerformance:     false|true,         // enable/disable performance tracking... WARNING: super cool feature, but may cause memory overhead issues
  headers: {
    // 'cache-control':  'no-cache'         // example of header overwrite
  },
  afterHit:             fn(req, res),       // run function after cache hits
  shouldSyncExpiration: false|true          // force max-age to sync with internal cache expiration
}
```

##### \*Optional: Typescript Types (courtesy of [@danielsogl](https://github.com/danielsogl))

```bash
$ npm install -D @types/apicache
```

## Custom Cache Keys

Sometimes you need custom keys (e.g. save routes per-session / user).
We've made it easy!

**Note:** All req/res attributes used in the generation of the key must have been set
previously (upstream). The entire route logic block is skipped on future cache hits
so it can't rely on those params.

```js
apicache.options({
  appendKey: (req, res) => res.session.id,
})
```

## Cache Key Groups

Oftentimes it benefits us to group cache entries, for example, by collection (in an API). This
would enable us to clear all cached "post" requests if we updated something in the "post" collection
for instance. Adding a simple `req.apicacheGroup = [somevalue];` to your route enables this. See example below:

```js
import apicache from 'apicache-plus'

// GET collection/id
app.get('/api/:collection/:id?', apicache('1 hour'), function(req, res, next) {
  req.apicacheGroup = req.params.collection
  // do some work
  res.send({ foo: 'bar' })
})

// POST collection/id
app.post('/api/:collection/:id?', function(req, res, next) {
  // update model
  apicache.clear(req.params.collection)
  res.send('added a new item, so the cache has been cleared')
})
```

Additionally, you could add manual cache control to the previous project with routes such as these:

```js
// GET apicache index (for the curious)
app.get('/api/cache/index', function(req, res, next) {
  res.send(apicache.getIndex())
})

// GET apicache index (for the curious)
app.get('/api/cache/clear/:key?', function(req, res, next) {
  res.send(200, apicache.clear(req.params.key || req.query.key))
})
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

### Changelog

- **v2.0.0** - major launch with better defaults for easier usage, manual caching (.get, .set, .has), new options and improved compatibility with third-party compression middlewares
- **v1.8.0** - add isBypassable and afterHit options and extra 304 condition checks
- **v1.7.0** - enforce request idempotence by cache key when not cached yet
- **v1.6.0** - cache is always stored compressed, can attach multiple apicache middlewares to same route for conditional use, increase third-party compression middleware compatibility and some minor bugfixes
- **v1.5.5** - self package import fix (thanks [@robbinjanssen](https://github.com/robbinjanssen))
- **v1.5.4** - created apicache-plus from apicache v1.5.3 with backward compatibility (thanks [@kwhitley](https://github.com/kwhitley) and [all original library contributors](https://github.com/kwhitley/apicache#contributors))
