import { expect } from 'chai';
import { describe, it } from 'mocha';

import * as utils from './utils';
import models from '../server/models';
import roles from '../server/constants/roles';

const today = new Date(new Date().setUTCHours(0, 0, 0, 0));
const dateOffset = 24 * 60 * 60 * 1000;

let user1, collective1;

describe('cron.makePrivateUpdatesPublic.test', () => {
  /* SETUP
     - collective1: user1 as admin
     - 4 updates
  */
  before(() => utils.resetTestDB());

  before(() => models.User.createUserWithCollective(utils.data('user1')).tap(u => (user1 = u)));
  before(() => models.Collective.create(utils.data('collective1')).tap(g => (collective1 = g)));
  before(() => collective1.addUserWithRole(user1, roles.ADMIN));

  before(async () => {
    await models.Update.createMany(
      [
        {
          id: 1,
          title: 'update 1',
          makePublicOn: new Date(new Date(today - new Date(dateOffset * 1)).toISOString()),
          isPrivate: true,
        },
        {
          id: 2,
          title: 'update 2',
          makePublicOn: new Date(new Date(today).toISOString()),
          isPrivate: true,
        },
        {
          id: 3,
          title: 'update 3',
          makePublicOn: new Date(new Date(today - new Date(dateOffset * -1)).toISOString()),
          isPrivate: true,
        },
        { id: 4, title: 'update 4', makePublicOn: null, isPrivate: true },
      ],
      { CreatedByUserId: user1.id, CollectiveId: collective1.id },
    );
    //run cronjob
    utils.makePublic();
  });
  describe('private update made public if update.makePublic <= today', () => {
    it('update.makePublic < today', async () => {
      const update1 = await models.Update.findByPk(1);
      expect(update1.dataValues.isPrivate).to.equal(false);
    });
    it('update.makePublic = today', async () => {
      const update2 = await models.Update.findByPk(2);
      expect(update2.dataValues.isPrivate).to.equal(false);
    });
  });

  describe('private update not made public if update.makePublic > today', () => {
    it('update.makePublic > today', async () => {
      const update3 = await models.Update.findByPk(3);
      expect(update3.dataValues.isPrivate).to.equal(true);
    });
  });

  describe('private update not made public if update.makePublic is null', () => {
    it('update.makePublic is null', async () => {
      const update4 = await models.Update.findByPk(4);
      expect(update4.dataValues.isPrivate).to.equal(true);
    });
  });
});
