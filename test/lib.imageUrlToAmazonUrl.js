var app = require('../index');
var config = require('config');
var imageUrlToAmazonUrl = require('../server/lib/imageUrlToAmazonUrl');
var expect = require('chai').expect;

var SAMPLE = 'https://d1ts43dypk8bqh.cloudfront.net/v1/avatars/1dca3d82-9c91-4d2a-8fc9-4a565c531764'

describe('lib.imageUrlToAmazonUrl.js', () => {
  describe('#Convert an external image url to a Amazon url', () => {
    it('successfully converts cloudfront.net url to amazon aws url', done => {
      imageUrlToAmazonUrl(
        app.knox,
        SAMPLE,
        (e, aws_src) => {
          expect(e).to.not.exist;
          expect(aws_src).to.contain('.amazonaws.com/');
          expect(aws_src).to.contain(config.aws.s3.bucket);
          done();
        }
      );
    });
  });
});
