var helpers = require('../../src/helpers')
var setLongTimeout = helpers.setLongTimeout
var clearLongTimeout = helpers.clearLongTimeout

describe('Timer helpers', function() {
  describe('setLongTimeout', function() {
    beforeEach(function() {
      this.setTimeoutCallCount = 0
      this._setTimeout = global.setTimeout
      global.setTimeout = function() {
        this.setTimeoutCallCount++
        return this._setTimeout.apply(null, arguments)
      }.bind(this)

      this.cbCallCount = 0
      this.incrementCallCount = function() {
        this.cbCallCount++
      }.bind(this)
    })

    afterEach(function() {
      global.setTimeout = this._setTimeout
    })

    describe('when below max delay', function() {
      it('set regular timer', function(done) {
        setLongTimeout(this.incrementCallCount, 5)
        setTimeout(
          function() {
            // minus this one right above
            expect(this.setTimeoutCallCount - 1).to.equal(1)
            expect(this.cbCallCount).to.equal(1)
            done()
          }.bind(this),
          20
        )
      })

      it('set regular timer with custom max delay', function(done) {
        var options = { _maxDelay: 10 }
        setLongTimeout(this.incrementCallCount, 5, options)
        setTimeout(
          function() {
            // minus this one right above
            expect(this.setTimeoutCallCount - 1).to.equal(1)
            expect(this.cbCallCount).to.equal(1)
            done()
          }.bind(this),
          20
        )
      })
    })

    describe('when above max delay', function() {
      it('set recursive timer', function(done) {
        var options = { _maxDelay: 5 }
        setLongTimeout(this.incrementCallCount, 15, options)
        setTimeout(
          function() {
            // minus this one right above
            expect(this.setTimeoutCallCount - 1).to.equal(3)
            expect(this.cbCallCount).to.equal(1)
            done()
          }.bind(this),
          25
        )
      })
    })
  })

  describe('clearLongTimeout', function() {
    it('clear regular timer', function(done) {
      var callCount = 0
      var timer = setTimeout(function() {
        callCount++
      }, 5)
      clearLongTimeout(timer)
      setTimeout(function() {
        expect(callCount).to.equal(0)
        done()
      }, 20)
    })

    it('clear long timer below max delay', function(done) {
      var callCount = 0
      var options = { _maxDelay: 10 }
      var timer = setLongTimeout(
        function() {
          callCount++
        },
        5,
        options
      )
      clearLongTimeout(timer)
      setTimeout(function() {
        expect(callCount).to.equal(0)
        done()
      }, 20)
    })

    it('clear long timer above max delay', function(done) {
      var callCount = 0
      var options = { _maxDelay: 7 }
      var timer = setLongTimeout(
        function() {
          callCount++
        },
        21,
        options
      )
      setTimeout(function() {
        clearLongTimeout(timer)
      }, 16)
      setTimeout(function() {
        expect(callCount).to.equal(0)
        done()
      }, 35)
    })
  })
})
