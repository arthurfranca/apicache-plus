var framework = require('./framework')
var object = require('./object')
var timer = require('./timer')

module.exports = {
  isKoa: framework.isKoa,
  delegate: object.delegate,
  delegateLazily: object.delegateLazily,
  setLongTimeout: timer.setLongTimeout,
  clearLongTimeout: timer.clearLongTimeout,
}
