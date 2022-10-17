import { expect } from 'chai';

import { checkRemoteUserCanRoot, checkScope, enforceScope } from '../../../../server/graphql/common/scope-check';
import { fakeApplication, fakeOrganization, fakeUser, fakeUserToken } from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

describe('server/graphql/v2/mutation/AccountMutations', () => {
  let req, userToken , application, userOwningTheToken;

  before(async () => {
    await resetTestDB();
    application = await fakeApplication({ type: 'oAuth' });
    userOwningTheToken = await fakeUser();
    userToken = await fakeUserToken({ type: 'OAUTH', ApplicationId: application.id, UserId: userOwningTheToken.id, scope: ['account'] });
  });

  describe('checkScope', () => {
    beforeEach(async () => {
      req = makeRequest();
      req.userToken = userToken;
    });
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
    beforeEach(async () => {
      req = makeRequest();
      req.userToken = userToken;
    });
    it(`Doesn't throw error if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => enforceScope(req, 'account')).to.not.throw();
    });
    it(`Doesn't throw error if true if user token has scope`, async () => {
      expect(() => enforceScope(req, 'account')).to.not.throw();
    });
    it(`Throw error if doesn't have the scope`, async () => {
      expect(() => enforceScope(req, 'root')).to.throw(`The User Token is not allowed for operations in scope "root".`);
    });
  });
  describe('checkRemoteUserCanRoot', () => {
    let rootUser, rootOrg;

    before(async () => {
      rootOrg = await fakeOrganization({ id: 8686, slug: 'opencollective' });
      rootUser = await fakeUser({}, { name: 'Root user' });
      await rootOrg.addUserWithRole(rootUser, 'ADMIN');
      console.log("isRoot", rootUser.isRoot());
    })
    beforeEach(async () => {
      req = makeRequest(rootUser);
      console.log("🚀 ~ file: scope-check.test.ts ~ line 59 ~ beforeEach ~ req", req.remoteUser.isRoot())
      req.userToken = userToken;
    });
    it(`Execute without errors if not using OAuth (aka. if there's no req.userToken)`, async () => {
      req.userToken = null;
      expect(() => checkRemoteUserCanRoot(req)).to.not.throw();
    });
    it(`Execute without errors if the scope is allowed by the user token`, async () => {
      const userTokenWithScopeRoot = await fakeUserToken({ scope: ['root'] });
      req.userToken = userTokenWithScopeRoot;
      expect(() => checkRemoteUserCanRoot(req)).to.not.throw();
    });
    it(`Throws when not authenticated`, async () => {
      req.remoteUser = null;
      expect(() => checkRemoteUserCanRoot(req)).to.throw(`You need to be logged in.`);
    });
    it(`Throws when not authenticated as a root user`, async () => {
      req.remoteUser = userOwningTheToken;
      expect(() => checkRemoteUserCanRoot(req)).to.throw(`You need to be logged in as root.`);
    });
    it(`Throws if the scope is not available on the token`, async () => {
      expect(() => checkRemoteUserCanRoot(req)).to.throw(`The User Token is not allowed for operations in scope "root".`);
    });
  });
});
