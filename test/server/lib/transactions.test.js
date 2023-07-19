import { expect } from 'chai';

import * as libtransactions from '../../../server/lib/transactions.js';
import models from '../../../server/models/index.js';
import * as store from '../../stores/index.js';
import * as utils from '../../utils.js';

describe('server/lib/transactions', () => {
  beforeEach(utils.resetTestDB);

  it('exports transactions', async () => {
    // Given a host with a collective
    const currency = 'USD';
    const { collective } = await store.newCollectiveWithHost('apex', currency, currency, 10);
    const { user } = await store.newUser('a new user');
    // And given some transactions
    await store.stripeConnectedAccount(collective.HostCollectiveId);
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 100,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 200,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 300,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 400,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 500,
    });
    const transactions = await models.Transaction.findAll({
      where: { CollectiveId: collective.id },
    });
    // Expected total
    // - 5 for CONTRIBUTIONs
    // - 5 for HOST_FEEs
    expect(transactions.length).to.equal(10);
    // When the newly created transactions are exported
    const csv = libtransactions.exportTransactions(transactions);
    const lines = csv.split('\n');
    expect(lines.length).to.equal(11);
    expect(lines[0].split('","').length).to.equal(12);
  }); /* End of "exports transactions" */
}); /* End of "lib.transactions.test.js" */
