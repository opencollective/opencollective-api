import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import { run as sendDailyCanary } from '../../../cron/daily/99-done';
import emailLib from '../../../server/lib/email';
import slackLib from '../../../server/lib/slack';

describe('cron/daily/done', () => {
  const sandbox = createSandbox();
  let sendMessage, postMessage;

  beforeEach(() => {
    sendMessage = sandbox.stub(emailLib, 'sendMessage').resolves();
    postMessage = sandbox.stub(slackLib, 'postMessageToOpenCollectiveSlack').resolves();
    sandbox.stub(config.slack.webhooks, 'engineeringAlerts').value('https://hooks.slack.test/alerts');
  });

  afterEach(() => {
    sandbox.restore();
    delete process.env.CRON_FAILED_JOBS;
  });

  it('sends the canary when every job succeeded', async () => {
    await sendDailyCanary();
    expect(sendMessage.calledOnce).to.be.true;
    expect(sendMessage.firstCall.args[1]).to.eq('Daily Cron Job completed');
    expect(postMessage.called).to.be.false;
  });

  it('still sends the canary, listing the failed jobs, and alerts on Slack', async () => {
    process.env.CRON_FAILED_JOBS = '90-register-currency-exchange-rates 92-refresh-daily-materialized-views';
    await sendDailyCanary();

    expect(sendMessage.calledOnce).to.be.true;
    expect(sendMessage.firstCall.args[1]).to.eq('Daily Cron Job completed, 2 failed');
    expect(sendMessage.firstCall.args[3].text).to.include('- 90-register-currency-exchange-rates');
    expect(sendMessage.firstCall.args[3].text).to.include('- 92-refresh-daily-materialized-views');
    expect(postMessage.calledOnce).to.be.true;
    expect(postMessage.firstCall.args[0]).to.include('90-register-currency-exchange-rates');
  });
});
