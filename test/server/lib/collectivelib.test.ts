import { expect } from 'chai';
import config from 'config';

import OrderStatuses from '../../../server/constants/order-status';
import { isCollectiveDeletable, parseImageServiceUrl } from '../../../server/lib/collectivelib';
import {
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeHost,
  fakeOrder,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';

describe('server/lib/collectivelib', () => {
  describe('isCollectiveDeletable', () => {
    it('returns true for a collective that can be deleted', async () => {
      const collective = await fakeCollective();
      expect(await isCollectiveDeletable(collective)).to.be.true;
    });

    it('returns true for a user that can be deleted', async () => {
      const user = await fakeUser();
      expect(await isCollectiveDeletable(user.collective)).to.be.true;
    });

    it('returns false for fiscal hosts', async () => {
      const host = await fakeHost();
      expect(await isCollectiveDeletable(host)).to.be.false;
    });

    it('returns false if the user is the last admin on an account', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      expect(await isCollectiveDeletable(user.collective)).to.be.false;

      // If we delete the collective, then the user should be deletable
      await collective.destroy();
      expect(await isCollectiveDeletable(user.collective)).to.be.true;
    });

    it('returns true if the user is not the last admin on an account', async () => {
      const user = await fakeUser();
      const otherUser = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      await collective.addUserWithRole(otherUser, 'ADMIN');
      expect(await isCollectiveDeletable(user.collective)).to.be.true;
    });

    it('returns false if the collective has transactions', async () => {
      const collective = await fakeCollective();
      await fakeTransaction({ CollectiveId: collective.id });
      expect(await isCollectiveDeletable(collective)).to.be.false;
    });

    it('returns false if the collective has orders associated with a payment', async () => {
      for (const status of [OrderStatuses.ACTIVE, OrderStatuses.PAID, OrderStatuses.CANCELLED]) {
        const collective = await fakeCollective();
        await fakeOrder({ CollectiveId: collective.id, status });
        expect(await isCollectiveDeletable(collective)).to.be.false;
      }
    });

    it('returns false if the collective has expenses associated with a payment', async () => {
      for (const status of ['SCHEDULED_FOR_PAYMENT', 'PROCESSING', 'PAID']) {
        // Testing FromCollective
        const fromCollective = await fakeCollective();
        await fakeExpense({ FromCollectiveId: fromCollective.id, status });
        expect(await isCollectiveDeletable(fromCollective)).to.be.false;

        // Testing Collective
        const collective = await fakeCollective();
        await fakeExpense({ CollectiveId: collective.id, status });
        expect(await isCollectiveDeletable(collective)).to.be.false;
      }
    });

    it('returns false if the collective has children', async () => {
      const parent = await fakeCollective();
      await fakeEvent({ ParentCollectiveId: parent.id });
      expect(await isCollectiveDeletable(parent)).to.be.false;
    });
  });

  describe('parseImageServiceUrl', () => {
    it('parses valid image URLs without size', () => {
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/background.jpg`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'background',
        format: 'jpg',
        height: undefined,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/avatar.jpg?foo=bar`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'avatar',
        format: 'jpg',
        height: undefined,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/logo.jpg?foo=bar`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'logo',
        format: 'jpg',
        height: undefined,
      });
    });

    it('parses valid image URLs with size', () => {
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/background/960.jpg`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'background',
        format: 'jpg',
        height: 960,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/avatar/200.jpg`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'avatar',
        format: 'jpg',
        height: 200,
      });

      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/logo/300.PNG`)).to.deep.equal({
        slug: 'babel',
        hash: '9a38a01',
        type: 'logo',
        format: 'PNG',
        height: 300,
      });
    });

    it('returns null for invalid image URLs', () => {
      expect(parseImageServiceUrl(``)).to.be.null;
      expect(parseImageServiceUrl(`https://random-domain.com/babel/9a38a01/background.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/background/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/avatar/invalid.jpg`)).to.be.null;
      expect(parseImageServiceUrl(`${config.host.images}/babel/9a38a01/logo/invalid.jpg`)).to.be.null;
    });
  });
});
