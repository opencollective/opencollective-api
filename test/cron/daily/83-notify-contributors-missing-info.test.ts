import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { run } from '../../../cron/daily/83-notify-contributors-missing-info';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import emailLib from '../../../server/lib/email';
import { sequelize } from '../../../server/models';
import { fakeActiveHost, fakeCollective, fakeTransaction, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/daily/83-notify-contributors-missing-info', () => {
  const sandbox = createSandbox();
  let sendMessage, users;

  before(async () => {
    await resetTestDB();
    const host = await fakeActiveHost({ currency: 'USD' }); // Default USD thresholds: $250 legal name, $5K address
    const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
    users = await Promise.all([fakeUser(), fakeUser()]);
    for (const user of users) {
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        FromCollectiveId: user.collective.id,
        HostCollectiveId: host.id,
        amount: 300e2,
        amountInHostCurrency: 300e2,
        currency: 'USD',
        hostCurrency: 'USD',
      });
    }
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityTransactionSummary"');
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"');
  });

  beforeEach(() => {
    sendMessage = sandbox.stub(emailLib, 'sendMessage').resolves();
  });

  afterEach(() => {
    sandbox.restore();
    delete process.env.CONTRIBUTOR_MISSING_INFO_DAILY_EMAIL_LIMIT;
  });

  it('does nothing while the daily limit is not set', async () => {
    expect(await run()).to.be.undefined;
    process.env.CONTRIBUTOR_MISSING_INFO_DAILY_EMAIL_LIMIT = 'invalid';
    expect(await run()).to.be.undefined;
    expect(sendMessage.called).to.be.false;
  });

  it('emails up to the daily limit, then the rest on the next run', async () => {
    process.env.CONTRIBUTOR_MISSING_INFO_DAILY_EMAIL_LIMIT = '1';
    const firstReport = await run();
    expect(firstReport.recipients).to.equal(1);
    expect(firstReport.profiles.map(p => p.status)).to.have.members(['sent', 'leftOver']);

    const secondReport = await run();
    expect(secondReport.recipients).to.equal(1);
    expect(secondReport.profiles.map(p => p.status)).to.have.members(['deduped', 'sent']);
    expect(sendMessage.args.map(args => args[0])).to.have.members(users.map(u => u.email));
  });
});
