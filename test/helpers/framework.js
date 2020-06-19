var express = require('express')
var restify = require('restify')
var Koa = require('koa')
var helpers = require('../../src/helpers')
var request = require('supertest')
var isKoa = helpers.isKoa
var delegate = helpers.delegate

describe('Framework helpers', function() {
  describe('isKoa', function() {
    describe('when is Express', function() {
      before(function() {
        this.app = express()
        this.app.use(function(req, res) {
          res.send(isKoa(req))
        })
      })

      it('return false', function() {
        return request(this.app)
          .get('/any')
          .expect(200, 'false')
      })
    })

    describe('when is Restify', function() {
      before(function() {
        this.app = restify.createServer()
        this.app.get('/any', function(req, res) {
          res.end(String(isKoa(req)))
        })
      })

      it('return false', function() {
        return request(this.app)
          .get('/any')
          .expect(200, 'false')
      })
    })

    describe('when is Koa', function() {
      before(function() {
        var that = this
        this.app = new Koa()
        this.app.use(function(ctx) {
          ctx.body = isKoa(ctx)
        })
        // PREPARE FOR SUPERTEST
        this.app.address = function() {}
        var _listen = this.app.listen
        this.app.listen = function() {
          var ret = _listen.apply(this, arguments)
          delete this.address
          // don't trigger deprecated prop
          delegate(that.app, ret, { exclude: ['connections'] })

          return ret
        }
      })

      it('return true', function() {
        return request(this.app)
          .get('/any')
          .expect(200, 'true')
      })
    })
  })
})
