require('@babel/register')({
  only: [/node_modules\/koa-compress/],
})

global.expect = require('chai').expect
