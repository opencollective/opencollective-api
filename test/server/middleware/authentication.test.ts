/* eslint-disable camelcase */

import { expect } from 'chai';

import { authenticateUser } from '../../../server/middleware/authentication';
import { fakeUser } from '../../test-helpers/fake-data';

describe('server/middleware/authentication', () => {
  it('updates user lastLoginAt if scope = login', async () => {
    const user = await fakeUser();
    const jwt = user.jwt({ scope: 'login' });
    const req = { path: '/users/exchange-login-token', params: { access_token: jwt }, header: () => 'Test' };

    await new Promise(resolve => {
      authenticateUser(req, {}, resolve);
    });

    expect(req).to.have.property('remoteUser');
    expect(req).to.have.nested.property('remoteUser.lastLoginAt').to.be.a('date');
  });

  it('does not updates user lastLoginAt if scope = login and traceless = true', async () => {
    const user = await fakeUser();
    const jwt = user.jwt({ scope: 'login', traceless: true });
    const req = { path: '/users/exchange-login-token', params: { access_token: jwt }, header: () => 'Test' };

    await new Promise(resolve => {
      authenticateUser(req, {}, resolve);
    });

    expect(req).to.have.property('remoteUser');
    expect(req).to.have.nested.property('remoteUser.lastLoginAt').to.be.a('null');
  });
});
