var MAX_DELAY = 2147483647
var MAX_EVENT_LOOP_EXIT_BLOCKING_DELAY = 5000

function setLongTimeout(fn, delay) {
  var lastArg = arguments[arguments.length - 1]
  var maxDelay
  if (
    arguments.length > 2 &&
    typeof lastArg === 'object' &&
    lastArg !== null &&
    lastArg._maxDelay
  ) {
    maxDelay = lastArg._maxDelay
  } else maxDelay = MAX_DELAY
  var timeout
  if (delay <= maxDelay) {
    if (lastArg._maxDelay) delete arguments[arguments.length - 1]
    timeout = setTimeout.apply(null, arguments)
  } else {
    var args = arguments
    args[1] -= maxDelay

    timeout = setTimeout(function() {
      timeout.next = setLongTimeout.apply(null, args)
    }, maxDelay)
  }

  return delay > MAX_EVENT_LOOP_EXIT_BLOCKING_DELAY ? (timeout = timeout.unref()) : timeout
}

function clearLongTimeout(timeout) {
  var next = (timeout || {}).next
  if (next) clearLongTimeout(next)
  else clearTimeout(timeout)
}

module.exports = {
  setLongTimeout: setLongTimeout,
  clearLongTimeout: clearLongTimeout,
}
