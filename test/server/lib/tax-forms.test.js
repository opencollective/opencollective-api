import { expect } from 'chai';
import HelloWorks from 'helloworks-sdk';
import moment from 'moment';
import sinon from 'sinon';

import expenseTypes from '../../../server/constants/expense_type';
import { US_TAX_FORM_THRESHOLD } from '../../../server/constants/tax-form';
import { findAccountsThatNeedToBeSentTaxForm, sendHelloWorksUsTaxForm } from '../../../server/lib/tax-forms';
import models from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeLegalDocument,
  fakePayoutMethod,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';
const { RECEIPT, INVOICE } = expenseTypes;

const { RequiredLegalDocument, LegalDocument, Collective, User, Expense } = models;
const {
  documentType: { US_TAX_FORM },
} = RequiredLegalDocument;
const {
  requestStatus: { REQUESTED, ERROR },
} = LegalDocument;

const HELLO_WORKS_KEY = '123';
const HELLO_WORKS_SECRET = 'ABC';

const client = new HelloWorks({
  apiKeyId: HELLO_WORKS_KEY,
  apiKeySecret: HELLO_WORKS_SECRET,
});

const callbackUrl = 'https://opencollective/api/taxForm/callback';
const workflowId = 'scuttlebutt';
const year = moment().year();

describe('server/lib/tax-forms', () => {
  // globals to be set in the before hooks.
  // need:
  // - some users who are over the threshold for this year _and_ last year
  // - some users who are not over the threshold
  // - some users who are over the threshold for this year _and_ that belong to multiple collectives that need a US_TAX_FORM
  // - one host collective that needs legal docs
  // - two hosted collectives that have invoices to them.
  // - a user that has a document with Error status
  let user,
    users,
    userCollective,
    hostCollective,
    collectives,
    organizationWithTaxForm,
    accountAlreadyNotified,
    accountWithTaxFormFromLastYear,
    accountWithTaxFormFrom4YearsAgo,
    accountWithPaypalBelowThreshold,
    accountWithPaypalOverThreshold;

  const documentData = {
    year: moment().year(),
  };

  function ExpenseOverThreshold({ incurredAt, UserId, CollectiveId, amount, type, FromCollectiveId, PayoutMethodId }) {
    return {
      description: 'pizza',
      amount: amount || US_TAX_FORM_THRESHOLD + 100e2,
      currency: 'USD',
      UserId,
      FromCollectiveId,
      lastEditedById: UserId,
      incurredAt,
      createdAt: incurredAt,
      CollectiveId,
      type: type || INVOICE,
      PayoutMethodId,
    };
  }

  const usersData = [
    {
      firstName: 'Xavier',
      lastName: 'Damman',
      email: 'xdamman@opencollective.com',
      legalName: 'Mr. Legal Name',
    },
    {
      firstName: 'Pia',
      lastName: 'Mancini',
      email: 'pia@opencollective.com',
    },
    {
      firstName: 'Piet',
      lastName: 'Geursen',
      email: 'piet@opencollective.com',
    },
    {
      firstName: 'Mix',
      lastName: 'Irving',
      email: 'mix@opencollective.com',
    },
    {
      email: 'randzzz@opencollective.com',
    },
  ];

  beforeEach(async () => await utils.resetTestDB());
  beforeEach(async () => {
    users = await Promise.all(usersData.map(userData => User.createUserWithCollective(userData)));
    user = users[0];
    userCollective = await Collective.findByPk(user.CollectiveId);
    hostCollective = await fakeHost();
    organizationWithTaxForm = await fakeCollective({ type: 'ORGANIZATION' });
    accountAlreadyNotified = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithTaxFormFromLastYear = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithTaxFormFrom4YearsAgo = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithPaypalBelowThreshold = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithPaypalOverThreshold = await fakeCollective({ type: 'ORGANIZATION' });
    collectives = await Promise.all([
      fakeCollective({ HostCollectiveId: hostCollective.id }),
      fakeCollective({ HostCollectiveId: hostCollective.id }),
    ]);

    const mixCollective = await Collective.findByPk(users[3].CollectiveId);

    const otherPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
    const paypalPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.PAYPAL });

    // Create legal document for accountAlreadyNotified
    await fakeLegalDocument({
      CollectiveId: accountAlreadyNotified.id,
      requestStatus: 'REQUESTED',
    });

    // Create legal document for accountWithTaxFormFromLastYear
    await fakeLegalDocument({
      CollectiveId: accountWithTaxFormFromLastYear.id,
      requestStatus: 'RECEIVED',
      year: year - 1,
    });

    // Create legal document for accountWithTaxFormFrom4YearsAgo
    await fakeLegalDocument({
      CollectiveId: accountWithTaxFormFrom4YearsAgo.id,
      requestStatus: 'RECEIVED',
      year: year - 4,
    });

    // An expense from this year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[0].id,
        FromCollectiveId: users[0].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from this year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: accountAlreadyNotified.CreatedByUserId,
        FromCollectiveId: accountAlreadyNotified.id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from this year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: accountWithTaxFormFromLastYear.CreatedByUserId,
        FromCollectiveId: accountWithTaxFormFromLastYear.id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from this year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: accountWithTaxFormFrom4YearsAgo.CreatedByUserId,
        FromCollectiveId: accountWithTaxFormFrom4YearsAgo.id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from the host, should not be included
    await Expense.create(
      ExpenseOverThreshold({
        UserId: hostCollective.CreatedByUserId,
        FromCollectiveId: hostCollective.id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from this year over the threshold BUT it's of type receipt so it should not be counted
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[2].id,
        FromCollectiveId: users[2].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
        type: RECEIPT,
      }),
    );
    // An expense from this year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[1].id,
        FromCollectiveId: users[1].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from this year under the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[1].id,
        FromCollectiveId: users[1].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
        amount: US_TAX_FORM_THRESHOLD - 200e2,
      }),
    );
    // An expense from this year under the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[4].id,
        FromCollectiveId: users[4].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
        amount: US_TAX_FORM_THRESHOLD - 200e2,
      }),
    );
    // An expense from this year over the threshold on the other host collective
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[0].id,
        FromCollectiveId: users[0].CollectiveId,
        CollectiveId: collectives[1].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense from previous year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[0].id,
        FromCollectiveId: users[0].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment().set('year', 2016),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );
    // An expense submitted under the same host (should not trigger tax form)
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[0].id,
        FromCollectiveId: (await fakeCollective({ HostCollectiveId: collectives[0].HostCollectiveId })).id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );

    // Mix made an expense from this year over the threshold
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[3].id,
        FromCollectiveId: users[3].CollectiveId,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
      }),
    );

    // Organization: add expenses whose sum exceeds the threshold
    const baseParams = {
      FromCollectiveId: organizationWithTaxForm.id,
      CollectiveId: collectives[0].id,
      amount: 250e2,
      PayoutMethodId: otherPayoutMethod.id,
    };
    await fakeExpense({ ...baseParams, type: 'INVOICE' });
    await fakeExpense({ ...baseParams, type: 'UNCLASSIFIED' });
    await fakeExpense({ ...baseParams, type: 'INVOICE' });

    // Add some PayPal-specific expenses (PayPal has a higher tax form threshold)
    await fakeExpense({
      FromCollectiveId: accountWithPaypalBelowThreshold.id,
      CollectiveId: collectives[0].id,
      amount: 10000e2, // Below threshold
      PayoutMethodId: paypalPayoutMethod.id,
      type: 'INVOICE',
    });

    await fakeExpense({
      FromCollectiveId: accountWithPaypalOverThreshold.id,
      CollectiveId: collectives[0].id,
      amount: 100000e2, // Above threshold
      PayoutMethodId: paypalPayoutMethod.id,
      type: 'INVOICE',
    });

    // Mix has a document that's in the error state
    const legalDoc = Object.assign({}, documentData, {
      CollectiveId: mixCollective.id,
      documentStatus: ERROR,
    });
    await LegalDocument.create(legalDoc);

    const requiredDoc = {
      HostCollectiveId: hostCollective.id,
      documentType: US_TAX_FORM,
    };

    await RequiredLegalDocument.create(requiredDoc);
  });

  describe('findAccountsThatNeedToBeSentTaxForm', () => {
    it('returns the right profiles', async () => {
      const accounts = await findAccountsThatNeedToBeSentTaxForm(moment().year());
      expect(accounts.length).to.be.eq(6);
      expect(accounts.some(account => account.id === organizationWithTaxForm.id)).to.be.true;
      expect(accounts.some(account => account.id === accountWithTaxFormFromLastYear.id)).to.be.false;
      expect(accounts.some(account => account.id === accountWithTaxFormFrom4YearsAgo.id)).to.be.true;
      expect(accounts.some(account => account.id === accountAlreadyNotified.id)).to.be.false;
      expect(accounts.some(account => account.id === hostCollective.id)).to.be.false;
      expect(accounts.some(account => account.id === users[4].CollectiveId)).to.be.false;
      expect(accounts.some(account => account.id === accountWithPaypalOverThreshold.id)).to.be.true;
      expect(accounts.some(account => account.id === accountWithPaypalBelowThreshold.id)).to.be.false;
    });
  });

  describe('sendHelloWorksUsTaxForm', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('updates the documents status to requested when the client request succeeds', async () => {
      const legalDoc = Object.assign({}, documentData, { CollectiveId: userCollective.id });
      const doc = await LegalDocument.create(legalDoc);

      const resolves = sinon.fake.resolves(null);
      sinon.replace(client.workflowInstances, 'createInstance', resolves);

      await sendHelloWorksUsTaxForm(client, user.collective, year, callbackUrl, workflowId, user);

      await doc.reload();
      expect(client.workflowInstances.createInstance.called);
      const callArgs = client.workflowInstances.createInstance.firstCall.args;
      expect(callArgs[0].participants['participant_swVuvW'].fullName).to.eq('Mr. Legal Name');
      expect(doc.requestStatus).to.eq(REQUESTED);
    });

    it('sets updates the documents status to error when the client request fails', async () => {
      const legalDoc = Object.assign({}, documentData, { CollectiveId: userCollective.id });
      const doc = await LegalDocument.create(legalDoc);

      const rejects = sinon.fake.rejects(null);
      sinon.replace(client.workflowInstances, 'createInstance', rejects);

      await sendHelloWorksUsTaxForm(client, user.collective, year, callbackUrl, workflowId, user);

      await doc.reload();
      expect(client.workflowInstances.createInstance.called);
      expect(doc.requestStatus).to.eq(ERROR);
    });
  });
});
