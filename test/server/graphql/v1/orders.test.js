import { describe } from 'mocha';
import { createSandbox } from 'sinon';

import models from '../../../../server/models/index.js';
import { randEmail } from '../../../stores/index.js';
import * as utils from '../../../utils.js';

describe('server/graphql/v1/orders', () => {
  const backers = [],
    collectives = [],
    orders = [];
  let host, hostAdmin, sandbox;
  before('reset test db', () => utils.resetTestDB());
  before('spies', () => {
    sandbox = createSandbox();
  });
  after('cleaning', () => {
    afterEach(() => sandbox.restore());
  });
  before('build up db content', async () => {
    hostAdmin = await models.User.createUserWithCollective({
      email: 'hostAdmin@gmail.com',
    });
    backers[0] = await models.User.createUserWithCollective({
      email: 'backer1@gmail.com',
    });
    backers[1] = await models.User.createUserWithCollective({
      email: 'backer2@gmail.com',
    });
    host = await models.Collective.create({
      name: 'brusselstogetherasbl',
      currency: 'EUR',
      tags: ['brussels', 'host'],
    });
    await host.addUserWithRole(hostAdmin, 'ADMIN');
    collectives[0] = await models.Collective.create({
      name: 'veganbrussels',
      currency: 'EUR',
      tags: ['brussels', 'vegan'],
    });
    collectives[1] = await models.Collective.create({
      name: 'codenplay',
      currency: 'EUR',
      tags: ['brussels', 'coding'],
    });
    const randomUser = models.User.createUserWithCollective({ email: randEmail() });
    await Promise.all(
      collectives.map(collective => collective.addHost(host, randomUser, { shouldAutomaticallyApprove: true })),
    );
    orders[0] = await models.Order.create({
      CreatedByUserId: backers[1].id,
      CollectiveId: collectives[1].id,
      FromCollectiveId: backers[1].CollectiveId,
      totalAmount: 15000,
      currency: 'EUR',
      status: 'PENDING',
    });
    orders[1] = await models.Order.create({
      CreatedByUserId: backers[0].id,
      CollectiveId: collectives[0].id,
      FromCollectiveId: backers[0].CollectiveId,
      totalAmount: 10000,
      currency: 'EUR',
      status: 'PENDING',
    });
    orders[2] = await models.Order.create({
      CreatedByUserId: backers[1].id,
      CollectiveId: collectives[0].id,
      FromCollectiveId: backers[1].CollectiveId,
      totalAmount: 20000,
      currency: 'EUR',
      status: 'PAID',
    });
  });
});
