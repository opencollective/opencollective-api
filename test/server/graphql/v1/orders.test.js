import Promise from 'bluebird';
import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import emailLib from '../../../../server/lib/email';
import models from '../../../../server/models';
import { randEmail } from '../../../stores';
import * as utils from '../../../utils';

describe('server/graphql/v1/orders', () => {
  const backers = [],
    collectives = [],
    orders = [];
  let host, hostAdmin, sandbox, emailSendMessageSpy;
  before('reset test db', () => utils.resetTestDB());
  before('spies', () => {
    sandbox = createSandbox();
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
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
    await Promise.map(collectives, collective =>
      collective.addHost(host, randomUser, { shouldAutomaticallyApprove: true }),
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

  describe('query', () => {
    const allOrdersQuery = gql`
      query AllOrders($collectiveSlug: String!, $status: String, $includeHostedCollectives: Boolean) {
        allOrders(
          collectiveSlug: $collectiveSlug
          status: $status
          includeHostedCollectives: $includeHostedCollectives
        ) {
          id
          collective {
            id
            slug
          }
          fromCollective {
            id
            slug
          }
          description
          totalAmount
          currency
          status
        }
      }
    `;

    it('gets all the PENDING orders for one collective', async () => {
      const result = await utils.graphqlQuery(allOrdersQuery, {
        collectiveSlug: collectives[0].slug,
        status: 'PENDING',
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const { allOrders } = result.data;
      expect(allOrders).to.have.length(1);
    });

    it('gets all the PENDING orders across all hosted collectives', async () => {
      const result = await utils.graphqlQuery(allOrdersQuery, {
        collectiveSlug: host.slug,
        status: 'PENDING',
        includeHostedCollectives: true,
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const { allOrders } = result.data;
      expect(allOrders).to.have.length(2);
      allOrders.map(order => {
        expect(order.status).to.equal('PENDING');
      });
    });
  });
});
