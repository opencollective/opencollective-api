import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { SupportedCurrency } from '../../../server/constants/currencies';
import { US_TAX_FORM_THRESHOLD_POST_2026, US_TAX_FORM_THRESHOLD_PRE_2026 } from '../../../server/constants/tax-form';
import emailLib from '../../../server/lib/email';
import {
  disableActivityDispatchTracking,
  enableActivityDispatchTracking,
} from '../../../server/lib/notifications/activity-dispatch-tracker';
import models from '../../../server/models';
import { LEGAL_DOCUMENT_REQUEST_STATUS, LEGAL_DOCUMENT_TYPE } from '../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeLegalDocument,
  fakePayoutMethod,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { LegalDocument, User, Collective } = models;

const YEAR = moment().year();
const US_TAX_FORM_THRESHOLD = YEAR >= 2026 ? US_TAX_FORM_THRESHOLD_POST_2026 : US_TAX_FORM_THRESHOLD_PRE_2026;

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
    amount: US_TAX_FORM_THRESHOLD + 100e2,
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

describe('server/models/LegalDocument', () => {
  // globals to be set in the before hooks.
  let sandbox, emailSendMessageSpy, hostCollective, user, userCollective;

  const documentData = {
    year: moment().year(),
  };

  const userData = {
    username: 'xdamman',
    email: 'xdamman@opencollective.com',
  };

  const hostCollectiveData = {
    slug: 'myhost',
    name: 'myhost',
    currency: 'USD' as SupportedCurrency,
    tags: ['#brusselstogether'],
    tiers: [
      {
        name: 'backer',
        range: [2, 100],
        interval: 'monthly',
      },
      {
        name: 'sponsor',
        range: [100, 100000],
        interval: 'yearly',
      },
    ],
  };

  before(() => {
    sandbox = sinon.createSandbox();
  });

  beforeEach(async () => {
    await utils.resetTestDB();
    hostCollective = await Collective.create(hostCollectiveData);
    user = await User.createUserWithCollective(userData);
    userCollective = await Collective.findByPk(user.CollectiveId);
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('documentLink', () => {
    it('it can set and save a new document_link', async () => {
      const expectedLink = 'https://drive.google.com/whatever';
      const doc = await LegalDocument.create({
        ...documentData,
        CollectiveId: userCollective.id,
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        documentLink: expectedLink,
      });

      expect(doc.documentLink).to.eq(expectedLink);
    });

    it('prefix the link with https:// if missing, and trims whitespace', async () => {
      const doc = await LegalDocument.create({
        ...documentData,
        CollectiveId: userCollective.id,
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        documentLink: '    drive.google.com/whatever  ',
      });

      expect(doc.documentLink).to.eq('https://drive.google.com/whatever');
    });

    it('needs to be a valid URL', async () => {
      await expect(
        LegalDocument.create({
          ...documentData,
          CollectiveId: userCollective.id,
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          documentLink: 'not a valid link',
        }),
      ).to.be.rejectedWith('The document link is invalid');
    });
  });

  // I think this is the correct behaviour. We have to keep tax records for 7 years. Maybe this clashes with GDPR? For now it's only on the Open Source Collective which is US based. So I _think_ it's ok.
  // This assumes collectives will never be force deleted. If they are then the Legal Document model will fail its foreign key constraint when you try and load it.
  it('it will not be deleted if the user collective is soft deleted', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);
    expect(doc.deletedAt).to.eq(null);

    await userCollective.destroy();

    // This would fail if the doc was deleted
    expect(doc.reload()).to.be.fulfilled;
  });

  it('it can be deleted without deleting the collectives it belongs to', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);
    // Normally docs are soft deleted. This is just checking that worst case we don't accidentally delete collectives.
    await doc.destroy({ force: true });

    await userCollective.reload();

    expect(hostCollective.id).to.not.eq(null);
    expect(userCollective.id).to.not.eq(null);
  });

  it('can set and save a valid new request status', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED);

    doc.requestStatus = LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED;
    await doc.save();
    await doc.reload();

    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED);
  });

  it('it will fail if attempting to set an invalid request status', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED);

    doc.requestStatus = 'SCUTTLEBUTT' as LEGAL_DOCUMENT_REQUEST_STATUS;
    expect(doc.save()).to.be.rejected;
  });

  it('it can be found via its collective', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    const retrievedDocs = await userCollective.getLegalDocuments();

    expect(retrievedDocs[0].id).to.eq(doc.id);
  });

  it('it can get its associated collective', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);

    const retrievedCollective = await doc.getCollective();

    expect(retrievedCollective.id).to.eq(userCollective.id);
  });

  it("it can't be created if the year is less than 2015", async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    legalDoc.year = 2014;
    expect(LegalDocument.create(legalDoc)).to.be.rejected;
  });

  it("it can't be created if the year is null", async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    delete legalDoc.year;
    expect(LegalDocument.create(legalDoc)).to.be.rejected;
  });

  it('it enforces the composite unique constraint over year, CollectiveId and documentType', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    await LegalDocument.create(legalDoc);
    expect(LegalDocument.create(legalDoc)).to.be.rejected;

    const user2 = await User.createUserWithCollective({ username: 'piet', email: 'piet@opencollective.com' });
    const user2Collective = await Collective.findByPk(user2.CollectiveId);

    const legalDoc2 = Object.assign({}, documentData, {
      CollectiveId: user2Collective.id,
    });
    expect(LegalDocument.create(legalDoc2)).to.be.fulfilled;

    const legalDoc3 = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
      year: 5000, // this test will fail in the year 5000.
    });
    expect(LegalDocument.create(legalDoc3)).to.be.fulfilled;

    // Ideally we'd test with a different documentType too but there's only one at the moment.
  });

  it("it can't be created if the CollectiveId is null", async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: null,
    });
    expect(LegalDocument.create(legalDoc)).to.be.rejected;
  });

  it('can be created and has expected values', async () => {
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: userCollective.id,
    });
    const doc = await LegalDocument.create(legalDoc);
    expect(doc.requestStatus).to.eq(LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED);
  });

  describe('sendRemindersForTaxForms', () => {
    let hostWithTaxForms;

    beforeEach(async () => {
      enableActivityDispatchTracking();
      hostWithTaxForms = await fakeActiveHost();
      await hostWithTaxForms.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
    });

    afterEach(() => {
      disableActivityDispatchTracking();
    });

    it('sends a reminder after 48h if not completed yet', async () => {
      const payeeUser = await fakeUser();
      await createExpenseSubjectToTaxForm(payeeUser.collective, hostWithTaxForms);

      const legalDocument = await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
      await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());

      await LegalDocument.sendRemindersForTaxForms();
      await legalDocument.reload();

      expect(legalDocument.data?.reminderSentAt).to.exist;

      // Check sent email
      await utils.waitForCondition(() => emailSendMessageSpy.callCount > 0);
      expect(emailSendMessageSpy.callCount).to.equal(1);
      const expectedSubject = `Action required: Submit tax form for ${payeeUser.collective.name}`;
      const email = await utils.waitForCondition(() =>
        emailSendMessageSpy.args.find(args => args[1] === expectedSubject),
      );
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
      await createExpenseSubjectToTaxForm(payeeUser.collective, hostWithTaxForms);
      const legalDocument = await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
      await LegalDocument.sendRemindersForTaxForms();
      await legalDocument.reload();
      expect(legalDocument.data?.reminderSentAt).to.not.exist;
      expect(emailSendMessageSpy.callCount).to.equal(0);
    });

    it('skips reminder if the legal document is too old', async () => {
      const payeeUser = await fakeUser();
      await createExpenseSubjectToTaxForm(payeeUser.collective, hostWithTaxForms);
      const legalDocument = await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
      await updateLegalDocCreatedAt(legalDocument, moment().subtract(10, 'days').toDate());
      await LegalDocument.sendRemindersForTaxForms();
      await legalDocument.reload();
      expect(legalDocument.data?.reminderSentAt).to.not.exist;
      expect(emailSendMessageSpy.callCount).to.equal(0);
    });

    it('skips reminder if the legal document is not required anymore', async () => {
      const payeeUser = await fakeUser();
      const expense = await createExpenseSubjectToTaxForm(payeeUser.collective, hostWithTaxForms);
      const legalDocument = await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
      await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());
      await expense.destroy();
      await LegalDocument.sendRemindersForTaxForms();
      await legalDocument.reload();
      expect(legalDocument.data?.reminderSentAt).to.not.exist;
      expect(emailSendMessageSpy.callCount).to.equal(0);
    });

    it('skips reminder if the legal document has been completed since', async () => {
      const payeeUser = await fakeUser();
      await createExpenseSubjectToTaxForm(payeeUser.collective, hostWithTaxForms);
      const legalDocument = await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
      await legalDocument.update({ requestStatus: 'RECEIVED' });
      await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());
      await LegalDocument.sendRemindersForTaxForms();
      await legalDocument.reload();
      expect(legalDocument.data?.reminderSentAt).to.not.exist;
      expect(emailSendMessageSpy.callCount).to.equal(0);
    });

    it('skips reminder if already sent', async () => {
      const payeeUser = await fakeUser();
      await createExpenseSubjectToTaxForm(payeeUser.collective, hostWithTaxForms);
      const legalDocument = await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser);
      const reminderSentAt = new Date();
      await legalDocument.update({ data: { reminderSentAt } });
      await updateLegalDocCreatedAt(legalDocument, moment().subtract(3, 'days').toDate());
      await LegalDocument.sendRemindersForTaxForms();
      await legalDocument.reload();
      expect(emailSendMessageSpy.callCount).to.equal(0);
      expect(legalDocument.data.reminderSentAt).to.equal(reminderSentAt.toISOString());
    });
  });

  describe('createExpenseActivitiesForTaxFormChange', () => {
    let hostWithTaxForms;

    beforeEach(async () => {
      enableActivityDispatchTracking();
      hostWithTaxForms = await fakeActiveHost();
      await hostWithTaxForms.createRequiredLegalDocument({ type: LEGAL_DOCUMENT_TYPE.US_TAX_FORM });
    });

    afterEach(() => {
      disableActivityDispatchTracking();
    });

    const createHostedExpense = async (payee, host) => {
      const hostedCollective = await fakeCollective({ HostCollectiveId: host.id });
      return createExpenseSubjectToTaxForm(payee, hostedCollective);
    };

    it('fans out only to expenses under hosts that require tax forms', async () => {
      const hostWithoutTaxForms = await fakeActiveHost();
      const payeeUser = await fakeUser();
      const expenseUnderTaxHost = await createHostedExpense(payeeUser.collective, hostWithTaxForms);
      const expenseUnderOtherHost = await createHostedExpense(payeeUser.collective, hostWithoutTaxForms);

      await LegalDocument.createTaxFormRequestToCollectiveIfNone(payeeUser.collective, payeeUser, {
        HostCollectiveId: hostWithTaxForms.id,
        ExpenseId: expenseUnderTaxHost.id,
      });
      await models.Activity.waitAllDispatch();

      const taxHostActivities = await models.Activity.findAll({
        where: { type: 'collective.expense.updated', ExpenseId: expenseUnderTaxHost.id },
      });
      expect(taxHostActivities.length).to.be.greaterThan(0);
      expect(taxHostActivities[0].data.newData.taxFormStatus).to.equal('REQUESTED');

      const otherHostActivities = await models.Activity.findAll({
        where: { type: 'collective.expense.updated', ExpenseId: expenseUnderOtherHost.id },
      });
      expect(otherHostActivities).to.have.length(0);
    });

    it('only fans out to expenses of the document year, with the usual activity data', async () => {
      const payeeUser = await fakeUser();
      const currentYearExpense = await createHostedExpense(payeeUser.collective, hostWithTaxForms);
      const lastYearExpense = await createHostedExpense(payeeUser.collective, hostWithTaxForms);
      await lastYearExpense.update({ status: 'PAID', paidAt: moment().subtract(1, 'year').toDate() });
      const legalDocument = await fakeLegalDocument({
        CollectiveId: payeeUser.CollectiveId,
        year: new Date().getFullYear(),
      });

      await LegalDocument.createExpenseActivitiesForTaxFormChange(payeeUser.collective, legalDocument, {
        previousStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
        newStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        user: payeeUser,
      });

      const lastYearActivities = await models.Activity.count({
        where: { type: 'collective.expense.updated', ExpenseId: lastYearExpense.id },
      });
      expect(lastYearActivities).to.equal(0);

      const activity = await models.Activity.findOne({
        where: { type: 'collective.expense.updated', ExpenseId: currentYearExpense.id },
      });
      expect(activity.UserId).to.equal(payeeUser.id);
      expect(activity.CollectiveId).to.equal(currentYearExpense.CollectiveId);
      expect(activity.FromCollectiveId).to.equal(payeeUser.CollectiveId);
      expect(activity.HostCollectiveId).to.equal(hostWithTaxForms.id);
      expect(activity.data).to.deep.include({ isSystem: true, notify: false });
      expect(activity.data.previousData).to.deep.equal({ taxFormStatus: 'REQUESTED' });
      expect(activity.data.newData).to.deep.equal({ taxFormStatus: 'RECEIVED' });
      expect(activity.data.taxForm.id).to.equal(legalDocument.id);
      expect(activity.data.expense.id).to.equal(currentYearExpense.id);
      expect(activity.data.expense.status).to.equal(currentYearExpense.status);
      expect(activity.data.collective.id).to.equal(currentYearExpense.CollectiveId);
      expect(activity.data.host.id).to.equal(hostWithTaxForms.id);
      expect(activity.data.fromCollective.id).to.equal(payeeUser.CollectiveId);
    });
  });
});
