var helpers = require('../../src/helpers')
var delegate = helpers.delegate
var delegateLazily = helpers.delegateLazily

describe('Object helpers', function() {
  describe('delegate', function() {
    beforeEach(function() {
      this.from = { a: 'prop A' }
      this.to = {
        a: 'not A',
        b: 'prop B',
        get c() {
          return (this._c || 'prop C') + ' plus it'
        },
        set c(v) {
          this._c = v
        },
        d(arg) {
          return arg ? 'prop ' + arg : this.b
        },
      }
    })

    it('delegate all current missing props to other object', function() {
      delegate(this.from, this.to)

      expect(this.from.a).to.equal('prop A')
      expect(this.from.b).to.equal('prop B')
      expect(this.from.c).to.equal('prop C plus it')
      expect(this.from.d()).to.equal('prop B')
      expect(this.from.d('D')).to.equal('prop D')

      this.to.c = 'prop C2'
      expect(this.from.c).to.equal('prop C2 plus it')

      this.from.c = 'prop C3'
      expect(this.from.c).to.equal('prop C3 plus it')
      expect(this.to.c).to.equal('prop C3 plus it')
    })
  })

  describe('delegateLazily', function() {
    beforeEach(function() {
      this.from = { a: 'prop A' }
      this.to = {
        a: 'not A',
        b: 'prop B',
        get c() {
          return (this._c || 'prop C') + ' plus it'
        },
        set c(v) {
          this._c = v
        },
        d(arg) {
          return arg ? 'prop ' + arg : this.b
        },
      }
    })

    it('delegate all current missing props to other object', function() {
      delegateLazily(this.from, this.to)

      expect(this.from.a).to.equal('prop A')
      expect(this.from.b).to.equal('prop B')
      expect(this.from.c).to.equal('prop C plus it')
      expect(this.from.d()).to.equal('prop B')
      expect(this.from.d('D')).to.equal('prop D')

      this.to.c = 'prop C2'
      expect(this.from.c).to.equal('prop C2 plus it')

      this.from.c = 'prop C3'
      expect(this.from.c).to.equal('prop C3 plus it')
      expect(this.to.c).to.equal('prop C3 plus it')
    })

    it('delegate all future missing props to other object', function() {
      this.from.e = 7
      this.to.e = 8
      this.from.f = 9
      Object.defineProperty(this.to, 'newG', {
        set(v) {
          this._newG = v + this.e
        },
        get() {
          return this._newG
        },
      })
      Object.defineProperty(this.to, 'newH', {
        get() {
          return this._newH + this.e
        },
      })
      delegateLazily(this.from, this.to)

      this.from.newA = function() {
        return this.a
      }
      expect(this.from.newA()).to.equal(this.to.a)
      expect(this.to.newA()).to.equal(this.to.a)

      this.from.newE = function() {
        return this.e
      }
      expect(this.to.newE()).to.equal(this.to.e)
      expect(this.from.newE()).to.equal(this.to.e)

      this.from.newF = function() {
        return this.f
      }
      expect(this.from.newF()).to.equal(this.from.f)
      expect(this.to.newF()).to.equal(this.from.f)

      // eslint-disable-next-line no-unused-expressions
      expect(this.from.newG).to.be.undefined
      this.from.newG = 10
      expect(this.from.newG).to.equal(10 + this.to.e)
      expect(this.to.newG).to.equal(10 + this.to.e)

      this.from._newH = 100
      expect(this.from.newH).to.equal(100 + this.to.e)
    })
  })
})
