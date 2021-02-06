import { expect } from 'chai';
import request from 'supertest';

import app from '../../../server/index';
import * as utils from '../../utils';

const application = utils.data('application');

describe('server/routes/notFound', () => {
  describe('WHEN calling unknown route', () => {
    let req, expressApp;

    before(async () => {
      expressApp = await app();
    });

    beforeEach(() => {
      req = request(expressApp).get(`/blablabla?api_key=${application.api_key}`);
    });

    it('THEN returns 404', () => req.expect(404).then(res => expect(res.error.text).to.equal('Not Found')));
  });
});
