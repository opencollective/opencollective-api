import { URL } from 'url';

import { expect } from 'chai';
import config from 'config';
import { SequelizeValidationError } from 'sequelize';
import { stub, useFakeTimers } from 'sinon';

import { Service } from '../../../server/constants/connected-account';
import * as auth from '../../../server/lib/auth';
import models from '../../../server/models';
import { randEmail } from '../../stores';
import { fakeCollective, fakeConnectedAccount, fakeEvent, fakeUser, multiple } from '../../test-helpers/fake-data';
import * as utils from '../../utils';
const userData = utils.data('user1');

const { User } = models;

describe('server/models/User', () => {
  beforeEach(() => utils.resetTestDB());

  /**
   * Create a user.
   */
  describe('#create', () => {
    it('fails without email', () => {
      return expect(User.create({})).to.be.rejectedWith(
        SequelizeValidationError,
        'notNull Violation: User.email cannot be null',
      );
    });

    it('fails if invalid email', () => {
      User.create({ email: 'johndoe' }).catch(err => expect(err).to.exist);
    });

    it('successfully creates a user and lowercase email', async () => {
      const user = await User.create({ email: userData.email });
      expect(user).to.have.property('email', userData.email.toLowerCase());
      expect(user).to.have.property('createdAt');
      expect(user).to.have.property('updatedAt');
    });
  });

  describe('#createUserWithCollective', () => {
    it('uses "incognito" slug if name is not provided', () => {
      const userParams = { email: 'frank@zappa.com' };
      return User.createUserWithCollective(userParams).then(user => {
        expect(user.collective.slug.startsWith('incognito')).to.equal(true);
      });
    });

    it('uses "user" slug if name is not sluggifyable', () => {
      return User.createUserWithCollective({ email: randEmail('user@domain.com'), name: '????...' }).then(user => {
        expect(user.collective.slug.startsWith('user')).to.equal(true);
      });
    });

    it('knows how to deal with special characters', () => {
      return User.createUserWithCollective({
        email: randEmail('user@domain.com'),
        name: '很棒的用户 awesome',
      }).then(user => {
        expect(user.collective.slug).to.equal('hen3-bang4-de-yong4-hu4-awesome');
      });
    });
  });

  /**
   * Get a user.
   */
  describe('#get', () => {
    beforeEach(() => User.create(userData));

    it('successfully get a user, user.info and user.public return correct information', done => {
      User.findOne({}).then(user => {
        expect(user.info).to.have.property('email');
        expect(user.public).to.not.have.property('email');
        done();
      });
    });
  });

  describe('#jwt', () => {
    // Ensure the date will start at 0 instead of starting at epoch so
    // date related things can be tested
    let clock;
    beforeEach(() => (clock = useFakeTimers()));
    afterEach(() => clock.restore());

    it('should generate valid JWTokens with user data', async () => {
      // Given a user instance
      const user = await User.create({
        email: 'foo@oc.com',
        password: '123456',
      });

      // When the token is generated
      const token = user.jwt();

      // Then the token should be valid
      const decoded = auth.verifyJwt(token);

      // And then the decoded token should contain the user data
      expect(Number(decoded.sub)).to.equal(user.id);

      // And then the default expiration of the token should have a
      // short life time
      expect(decoded.exp).to.equal(auth.TOKEN_EXPIRATION_LOGIN);
    });
  });

  describe('permissions', () => {
    describe('isAdminOfCollective', () => {
      it('returns true if user is a direct admin of the collective', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective({ admin: user });
        await user.populateRoles();
        expect(user.isAdminOfCollective(collective)).to.be.true;
      });

      it('returns true if user is an admin of the parent', async () => {
        const user = await fakeUser();
        const parent = await fakeCollective({ admin: user });
        const collective = await fakeEvent({ ParentCollectiveId: parent.id });
        await user.populateRoles();
        expect(user.isAdminOfCollective(collective)).to.be.true;
      });

      it('returns false if user is not an admin of the collective', async () => {
        const collective = await fakeCollective();

        const randomUser = await fakeUser();
        await randomUser.populateRoles();
        expect(randomUser.isAdminOfCollective(collective)).to.be.false;

        const hostAdmin = await fakeUser();
        await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
        await hostAdmin.populateRoles();
        expect(hostAdmin.isAdminOfCollective(collective)).to.be.false;
      });
    });

    describe('hasRoleInCollectiveOrHost', () => {
      it('returns true if user has any of the roles in the collective', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective({ admin: user });
        await user.populateRoles();
        expect(user.hasRoleInCollectiveOrHost(['ADMIN', 'ACCOUNTANT'], collective)).to.be.true;
      });

      it('returns true if user has any of the roles on the parent collective', async () => {
        const user = await fakeUser();
        const parent = await fakeCollective({ admin: user });
        const collective = await fakeEvent({ ParentCollectiveId: parent.id });
        await user.populateRoles();
        expect(user.hasRoleInCollectiveOrHost('ADMIN', collective)).to.be.true;
      });

      it('returns true if user has any of the roles in the host', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective();
        await collective.host.addUserWithRole(user, 'ADMIN');
        await user.populateRoles();
        expect(user.hasRoleInCollectiveOrHost(['ADMIN', 'ACCOUNTANT'], collective)).to.be.true;
      });

      it('returns false if user does not have any of the roles in the collective or host', async () => {
        const user = await fakeUser();
        const collective = await fakeCollective();
        await user.populateRoles();
        expect(user.hasRoleInCollectiveOrHost(['ADMIN', 'ACCOUNTANT'], collective)).to.be.false;

        await collective.addUserWithRole(user, 'ADMIN');
        expect(user.hasRoleInCollectiveOrHost(['BACKER'], collective)).to.be.false;
      });
    });
  });

  describe('#generateLoginLink', () => {
    it('contains the right base URL from config and the right query parameter', async () => {
      // Given a user instance with a mocked `jwt` method
      const user = await User.create({
        email: 'foo@oc.com',
        password: '123456',
      });
      const mockUser = stub(user, 'jwt').callsFake(() => 'foo');

      // When a login link is created
      const link = user.generateLoginLink('/path/to/redirect');

      // Then the link should contain the right url
      const parsedUrl = new URL(link);
      expect(`${parsedUrl.protocol}//${parsedUrl.host}`).to.equal(config.host.website);
      expect(parsedUrl.search).to.equal('?next=/path/to/redirect');
      expect(parsedUrl.pathname).to.equal('/signin/foo');

      // And Then restore the mock
      mockUser.restore();
    });
  });

  describe('#generateConnectedAccountVerifiedToken', () => {
    it('generates a valid token with right expiration time', async () => {
      // Given a user instance with a mocked `jwt` method
      const user = await User.create({
        email: 'foo@oc.com',
        password: '123456',
      });
      const mockUser = stub(user, 'jwt').callsFake((payload, expiration) => ({ payload, expiration }));

      // When an account verification link is created
      const output = user.generateConnectedAccountVerifiedToken(1, 'user');

      // Then the expiration time should match with a constant
      expect(output.expiration).to.equal(auth.TOKEN_EXPIRATION_CONNECTED_ACCOUNT);

      // And then restore the mocked object
      mockUser.restore();
    });
  });

  describe('class methods', () => {
    beforeEach(() => utils.resetTestDB());
    beforeEach(() => User.createUserWithCollective(utils.data('user1')));

    it('creates a new user collective and generates a unique slug', () => {
      const email = 'xavier.damman@email.com';
      return User.createUserWithCollective({
        email,
        name: 'Xavier Damman',
      })
        .then(user => {
          expect(user.email).to.equal(email);
          expect(user.collective.slug).to.equal('xavier-damman');
          expect(user.collective.type).to.equal('USER');
          return User.createUserWithCollective({
            name: 'Xavier Damman',
            email: 'xavierdamman+test@mail.com',
          });
        })
        .then(user2 => {
          expect(user2.collective.slug).to.equal('xavier-damman1');
          expect(user2.collective.name).to.equal('Xavier Damman');
        });
    });
  });

  describe('findRelatedUsersByIp', () => {
    it('returns empty list if there are no other useres sharing the same IP', async () => {
      await fakeUser({ data: { lastSignInRequest: { ip: '201.32.14.2' }, creationRequest: { ip: '201.32.14.2' } } });
      const user = await fakeUser({ data: { creationRequest: { ip: '143.23.13.2' } } });

      const relatedUsers = await user.findRelatedUsersByIp();
      expect(relatedUsers).to.have.length(0);
    });

    it('returns list of users that are using the same IP address', async () => {
      const ip = '192.168.0.27';

      await fakeUser({ data: { lastSignInRequest: { ip: '201.32.14.2' }, creationRequest: { ip: '201.32.14.2' } } });
      const otherUser = await fakeUser({ data: { lastSignInRequest: { ip } } });
      const user = await fakeUser({ data: { creationRequest: { ip } } });

      const relatedUsers = await user.findRelatedUsersByIp();
      expect(relatedUsers).to.have.length(1);
      expect(relatedUsers).to.have.nested.property('[0].id', otherUser.id);
    });
  });

  describe('findRelatedUsersByConnectedAccounts', () => {
    let user1, user2, user3, user4;
    beforeEach(async () => {
      [user1, user2, user3, user4] = await multiple(fakeUser, 10, {});
      await fakeConnectedAccount({ CollectiveId: user1.CollectiveId, service: Service.GITHUB, username: 'bob' });
      await fakeConnectedAccount({ CollectiveId: user2.CollectiveId, service: Service.GITHUB, username: 'bob' });
      await fakeConnectedAccount({ CollectiveId: user1.CollectiveId, service: Service.STRIPE, username: 'bob' });
      await fakeConnectedAccount({ CollectiveId: user3.CollectiveId, service: Service.STRIPE, username: 'bob' });
      await fakeConnectedAccount({
        CollectiveId: user1.CollectiveId,
        service: Service.PAYPAL,
        username: 'bob@hotmail.com',
      });
      await fakeConnectedAccount({
        CollectiveId: user4.CollectiveId,
        service: Service.PAYPAL,
        username: 'bob@hotmail.com',
      });
    });

    it('should return related users if another user has the same username', async () => {
      let relatedUsers = await user1.findRelatedUsersByConnectedAccounts();

      expect(relatedUsers).to.containSubset([{ id: user2.id }, { id: user4.id }]);

      relatedUsers = await user4.findRelatedUsersByConnectedAccounts();
      expect(relatedUsers).to.containSubset([{ id: user1.id }]);
    });

    it('should not include irrelevant services', async () => {
      const relatedUsers = await user1.findRelatedUsersByConnectedAccounts();

      expect(relatedUsers).to.not.containSubset([{ id: user3.id }]);
    });
  });
});
