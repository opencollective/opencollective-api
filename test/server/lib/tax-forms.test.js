import { expect } from 'chai';
import moment from 'moment';

import expenseTypes from '../../../server/constants/expense-type';
import { US_TAX_FORM_THRESHOLD } from '../../../server/constants/tax-form';
import SQLQueries from '../../../server/lib/queries';
import models from '../../../server/models';
import {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
} from '../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeCurrencyExchangeRate,
  fakeExpense,
  fakeHost,
  fakeLegalDocument,
  fakePayoutMethod,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';
const { RECEIPT, INVOICE } = expenseTypes;

const { RequiredLegalDocument, LegalDocument, Collective, User, Expense } = models;

const YEAR = moment().year();

describe('server/lib/tax-forms', () => {
  // globals to be set in the before hooks.
  // need:
  // - some users who are over the threshold for this year _and_ last year
  // - some users who are not over the threshold
  // - some users who are over the threshold for this year _and_ that belong to multiple collectives that need a US_TAX_FORM
  // - one host collective that needs legal docs
  // - two hosted collectives that have invoices to them.
  // - a user that has a document with Error status
  let users,
    hostCollective,
    collectives,
    organizationWithTaxForm,
    accountAlreadyNotified,
    accountWithOnlyADraft,
    accountWithTaxFormFromLastYear,
    accountWithTaxFormFrom4YearsAgo,
    accountWithTaxFormSubmittedByHost,
    accountWithPaypalBelowThreshold,
    accountWithPaypalOverThreshold,
    accountWithINRBelowThreshold,
    accountWithINROverThreshold;

  const documentData = { year: YEAR };

  function ExpenseOverThreshold({
    incurredAt,
    UserId,
    CollectiveId,
    amount,
    type,
    FromCollectiveId,
    PayoutMethodId,
    status,
  }) {
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
      status,
    };
  }

  const usersData = [
    {
      name: 'Xavier Damman',
      email: 'xdamman@opencollective.com',
      legalName: 'Mr. Legal Name',
    },
    {
      name: 'Pia Mancini',
      email: 'pia@opencollective.com',
    },
    {
      name: 'Piet Geursen',
      email: 'piet@opencollective.com',
    },
    {
      name: 'Mix Irving',
      email: 'mix@opencollective.com',
    },
    {
      email: 'randzzz@opencollective.com',
    },
    {
      email: 'using-inr-currency@opencollective.com',
      name: 'INR tester',
    },
  ];

  beforeEach(async () => {
    await utils.resetTestDB();
    users = await Promise.all(usersData.map(userData => User.createUserWithCollective(userData)));
    hostCollective = await fakeHost();
    organizationWithTaxForm = await fakeCollective({ type: 'ORGANIZATION' });
    accountAlreadyNotified = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithTaxFormFromLastYear = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithTaxFormSubmittedByHost = await fakeCollective();
    accountWithOnlyADraft = (await fakeUser()).collective;
    accountWithTaxFormFrom4YearsAgo = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithPaypalBelowThreshold = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithPaypalOverThreshold = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithINRBelowThreshold = await fakeCollective({ type: 'ORGANIZATION' });
    accountWithINROverThreshold = await fakeCollective({ type: 'ORGANIZATION' });
    collectives = await Promise.all([
      fakeCollective({ HostCollectiveId: hostCollective.id }),
      fakeCollective({ HostCollectiveId: hostCollective.id }),
    ]);

    const mixCollective = await Collective.findByPk(users[3].CollectiveId);

    const otherPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
    const paypalPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.PAYPAL });

    // Fake currency exchange rates
    await fakeCurrencyExchangeRate({ from: 'INR', to: 'USD', rate: 0.01 });

    // Create legal document for accountAlreadyNotified
    await fakeLegalDocument({
      CollectiveId: accountAlreadyNotified.id,
      requestStatus: 'REQUESTED',
    });

    // Create legal document for accountWithTaxFormFromLastYear
    await fakeLegalDocument({
      CollectiveId: accountWithTaxFormFromLastYear.id,
      requestStatus: 'RECEIVED',
      year: YEAR - 1,
    });

    // Create legal document for accountWithTaxFormSubmittedByHost (no tax form should be required in this case)
    await fakeLegalDocument({
      CollectiveId: accountWithTaxFormSubmittedByHost.HostCollectiveId,
      requestStatus: 'RECEIVED',
      year: YEAR,
    });

    // Create legal document for accountWithTaxFormFrom4YearsAgo
    await fakeLegalDocument({
      CollectiveId: accountWithTaxFormFrom4YearsAgo.id,
      requestStatus: 'RECEIVED',
      year: YEAR - 4,
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

    // An expense from this year below the threshold (but in a different currency)
    await fakeExpense({
      FromCollectiveId: accountWithINRBelowThreshold.id,
      CollectiveId: collectives[0].id,
      PayoutMethodId: otherPayoutMethod.id,
      amount: Math.round(US_TAX_FORM_THRESHOLD * (1 / 0.01) - 1),
      currency: 'INR',
    });

    // An expense from this year over the threshold (but in a different currency)
    await fakeExpense({
      FromCollectiveId: accountWithINROverThreshold.id,
      CollectiveId: collectives[0].id,
      PayoutMethodId: otherPayoutMethod.id,
      amount: Math.round(US_TAX_FORM_THRESHOLD * (1 / 0.01)),
      currency: 'INR',
    });

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
    // An expense from this year over the threshold BUT it's a draft should not be counted
    await Expense.create(
      ExpenseOverThreshold({
        UserId: accountWithOnlyADraft.CreatedByUserId,
        FromCollectiveId: accountWithOnlyADraft.id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
        status: 'DRAFT',
      }),
    );
    // An expense from this year over the threshold BUT its fiscal host already submitted a tax form
    await Expense.create(
      ExpenseOverThreshold({
        UserId: users[2].id,
        FromCollectiveId: accountWithTaxFormSubmittedByHost.id,
        CollectiveId: collectives[0].id,
        incurredAt: moment(),
        PayoutMethodId: otherPayoutMethod.id,
        type: INVOICE,
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
      documentStatus: LEGAL_DOCUMENT_REQUEST_STATUS.ERROR,
      service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
    });
    await LegalDocument.create(legalDoc);

    const requiredDoc = {
      HostCollectiveId: hostCollective.id,
      documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
    };

    await RequiredLegalDocument.create(requiredDoc);
  });

  describe('SQLQueries', () => {
    describe('getTaxFormsRequiredForAccounts', () => {
      it('returns the right profiles for pending tax forms', async () => {
        const accounts = await SQLQueries.getTaxFormsRequiredForAccounts({ year: YEAR, ignoreReceived: true });
        expect(accounts.size).to.be.eq(8); // 7 legit + 1 "error" document
        expect(accounts.has(organizationWithTaxForm.id)).to.be.true;
        expect(accounts.has(accountWithTaxFormFromLastYear.id)).to.be.false;
        expect(accounts.has(accountWithTaxFormFrom4YearsAgo.id)).to.be.true;
        expect(accounts.has(accountAlreadyNotified.id)).to.be.true;
        expect(accounts.has(hostCollective.id)).to.be.false;
        expect(accounts.has(users[4].CollectiveId)).to.be.false;
        expect(accounts.has(accountWithPaypalOverThreshold.id)).to.be.true;
        expect(accounts.has(accountWithPaypalBelowThreshold.id)).to.be.false;
        expect(accounts.has(accountWithOnlyADraft.id)).to.be.false;
        expect(accounts.has(accountWithINROverThreshold.id)).to.be.true;
        expect(accounts.has(accountWithINRBelowThreshold.id)).to.be.false;
      });
    });
  });
});
