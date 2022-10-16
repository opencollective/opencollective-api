import { expect } from 'chai';

import { checkScope, enforceScope } from '../../../../server/graphql/common/scope-check';
import { fakeApplication, fakeUser, fakeUserToken } from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let req, userToken , application, userOwningTheToken;

  before(async () => {
    await resetTestDB();
    application = await fakeApplication({ type: 'oAuth' });
    userOwningTheToken = await fakeUser();
    userToken = await fakeUserToken({ type: 'OAUTH', ApplicationId: application.id, UserId: userOwningTheToken.id });
    console.log("🚀 ~ file: scope-check.test.ts ~ line 15 ~ before ~ userToken", userToken)
  });

  beforeEach(async () => {
    req = makeRequest();
    req.userToken = userToken;
  });

  describe('checkScope', () => {
    it(`Returns true if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(checkScope(req, 'account')).to.be.true;
    });
    it(`Returns true if user token has scope`, async () => {
      expect(checkScope(req, 'account')).to.be.true;
    });
    it(`Returns false if doesn't have the scope`, async () => {
      expect(checkScope(req, 'root')).to.be.false;
    });
  });
  describe('enforceScope', () => {
    it(`Doesn't throw error if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(enforceScope(req, 'account')).to.not.throw();
    });
    it(`Doesn't throw error if true if user token has scope`, async () => {
      expect(enforceScope(req, 'account')).to.not.throw();
    });
    it(`Throw errorif doesn't have the scope`, async () => {
      expect(enforceScope(req, 'root')).to.throw(`The User Token is not allowed for operations in scope "root".`);
    });
  });
});
