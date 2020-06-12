// instead of from[k] = to[k].bind() do from[k] = proxyFunction(from, to, to[k])
// which will bind to 'to' while keeping fn own props
function proxyFunctionCall(from, to, toFn) {
  return new Proxy(toFn, {
    apply: function(target, that, args) {
      if (that === from) that = to
      return Reflect.apply(target, that, args)
    },
  })
}

function delegate(from, to, options) {
  if (!options) options = {}
  var keys = Object.getOwnPropertyNames(to)

  for (
    var proto = Object.getPrototypeOf(to);
    proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    keys = keys.concat(Object.getOwnPropertyNames(proto))
  }
  keys = Array.from(new Set(keys))
  keys.forEach(function(k) {
    if (options.include) {
      if (options.include.indexOf(k) === -1) return
    } else if (k in from) return
    if (options.exclude && options.exclude.indexOf(k) !== -1) return

    var descriptor = Object.getOwnPropertyDescriptor(to, k) || {
      configurable: true,
      enumerable: true,
      writable: true,
    }
    if (typeof to[k] === 'function') {
      Object.defineProperty(from, k, {
        value: proxyFunctionCall(from, to, to[k]),
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
      })
    } else {
      Object.defineProperty(from, k, {
        get() {
          return to[k]
        },
        set(v) {
          to[k] = v
        },
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
      })
    }
  })

  return from
}

function delegateLazily(from, to, options) {
  if (!options) options = {}

  // so that when assigning to it, won`t assign directly to e.g {}'s prototype
  var fromProtoCopy = Object.create(Object.getPrototypeOf(from))
  // so to not proxy fromProto which would trap other objs prop lookups that have similar prototype chain
  var emptyProto = Object.create(null)
  // so to set/get to/from 'to' but having access to 'to' (first) and 'from' props
  var toAndFrom = new Proxy(to, {
    get(target, k, that) {
      target = Reflect.has(target, k) ? target : from
      return Reflect.get(target, k, that)
    },
  })

  // trap prop lookups not on from's own props
  Object.setPrototypeOf(
    from,
    new Proxy(emptyProto, {
      // that === from always because no one can call emptyProto closure directly
      get(target, k, that) {
        if (k in fromProtoCopy) {
          return Reflect.get(fromProtoCopy, k, that)
        } else {
          var v = Reflect.get(to, k, toAndFrom)
          if (typeof v === 'function') {
            v = proxyFunctionCall(that, toAndFrom, v)
          }
          return v
        }
      },
      set(target, k, v, that) {
        if (k in fromProtoCopy) {
          return Reflect.set(fromProtoCopy, k, v, that)
        } else {
          if (typeof v === 'function') {
            return Reflect.defineProperty(to, k, {
              value: proxyFunctionCall(to, toAndFrom, v),
              configurable: true,
              enumerable: true,
              writable: true,
            })
          } else return Reflect.set(to, k, v, toAndFrom)
        }
      },
    })
  )

  return from
}

module.exports = {
  delegate: delegate,
  delegateLazily: delegateLazily,
}
