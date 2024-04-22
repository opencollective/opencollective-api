import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { run as runCronJob } from '../../../cron/hourly/40-send-tax-form-requests';
import emailLib from '../../../server/lib/email';
import LegalDocument, { LEGAL_DOCUMENT_TYPE } from '../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import { fakeActiveHost, fakeExpense, fakePayoutMethod, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

const createExpenseSubjectToTaxForm = async (payee, host) => {
  const payoutMethod = await fakePayoutMethod({
    CollectiveId: payee.id,
    type: PayoutMethodTypes.OTHER,
    data: { content: 'Send cash' },
  });

  return fakeExpense({
    type: 'INVOICE',
    FromCollectiveId: payee.id,
    CollectiveId: host.id,
    amount: 600e2,
    currency: 'USD',
    PayoutMethodId: payoutMethod.id,
  });
};

// Need a helper cause Sequelize doesn't allow to set createdAt directly
const updateLegalDocCreatedAt = async (legalDocument, date) => {
  legalDocument.set('createdAt', date, { raw: true });
  legalDocument.changed('createdAt', true);
  return legalDocument.save({ fields: ['createdAt'] });
};

describe('cron/hourly/40-send-tax-form-requests', () => {
  let sandbox, host, emailSendMessageSpy;

  before(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
    host = await fakeActiveHost();
    await host.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(async () => {
    emailSendMessageSpy.resetHistory();
    await LegalDocument.destroy({ truncate: true }); // Delete all legal docs to make sure we start fresh
  });

  after(() => {
    sandbox.restore();
  });

  it('sends a reminder after 48h if not completed yet', async () => {
    const payeeUser = await fakeUser();
    await createExpenseSubjectToTaxForm(payeeUser.collective, host);

    const legalDocument = await LegalDocument.sendTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
    await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());

    await runCronJob();
    await legalDocument.reload();
    expect(legalDocument.data?.reminderSentAt).to.exist;

    // Check sent email
    await waitForCondition(() => emailSendMessageSpy.callCount > 0);
    expect(emailSendMessageSpy.callCount).to.equal(1);
    const expectedSubject = `Action required: Submit tax form for ${payeeUser.collective.name}`;
    const email = await waitForCondition(() => emailSendMessageSpy.args.find(args => args[1] === expectedSubject));
    expect(email).to.exist;
    expect(email[0]).to.equal(payeeUser.email);
    expect(email[1]).to.equal(expectedSubject);
    expect(email[2]).to.contain(`The button below will take you to your dashboard`);
    expect(email[2]).to.match(new RegExp(`href=".+/dashboard/${payeeUser.collective.slug}/tax-information"`));
    expect(email[3].isTransactional).to.be.true;
    expect(email[3].listId).to.equal(`${payeeUser.collective.slug}::taxform.request`);
    expect(email[3].accountSlug).to.equal(payeeUser.collective.slug);
  });

  it('skips reminder if the legal document has just been created', async () => {
    const payeeUser = await fakeUser();
    await createExpenseSubjectToTaxForm(payeeUser.collective, host);
    const legalDocument = await LegalDocument.sendTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
    await runCronJob();
    await legalDocument.reload();
    expect(legalDocument.data?.reminderSentAt).to.not.exist;
    expect(emailSendMessageSpy.callCount).to.equal(0);
  });

  it('skips reminder if the legal document is too old', async () => {
    const payeeUser = await fakeUser();
    await createExpenseSubjectToTaxForm(payeeUser.collective, host);
    const legalDocument = await LegalDocument.sendTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
    await updateLegalDocCreatedAt(legalDocument, moment().subtract(10, 'days').toDate());
    await runCronJob();
    await legalDocument.reload();
    expect(legalDocument.data?.reminderSentAt).to.not.exist;
    expect(emailSendMessageSpy.callCount).to.equal(0);
  });

  it('skips reminder if the legal document is not required anymore', async () => {
    const payeeUser = await fakeUser();
    const expense = await createExpenseSubjectToTaxForm(payeeUser.collective, host);
    const legalDocument = await LegalDocument.sendTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
    await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());
    await expense.destroy();
    await runCronJob();
    await legalDocument.reload();
    expect(legalDocument.data?.reminderSentAt).to.not.exist;
    expect(emailSendMessageSpy.callCount).to.equal(0);
  });

  it('skips reminder if the legal document has been completed since', async () => {
    const payeeUser = await fakeUser();
    await createExpenseSubjectToTaxForm(payeeUser.collective, host);
    const legalDocument = await LegalDocument.sendTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
    await legalDocument.update({ requestStatus: 'RECEIVED' });
    await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());
    await runCronJob();
    await legalDocument.reload();
    expect(legalDocument.data?.reminderSentAt).to.not.exist;
    expect(emailSendMessageSpy.callCount).to.equal(0);
  });

  it('skips reminder if already sent', async () => {
    const payeeUser = await fakeUser();
    await createExpenseSubjectToTaxForm(payeeUser.collective, host);
    const legalDocument = await LegalDocument.sendTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
    const reminderSentAt = new Date();
    await legalDocument.update({ data: { reminderSentAt } });
    await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());
    await runCronJob();
    await legalDocument.reload();
    expect(emailSendMessageSpy.callCount).to.equal(0);
    expect(legalDocument.data.reminderSentAt).to.equal(reminderSentAt.toISOString());
  });
});
