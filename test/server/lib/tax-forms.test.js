import { expect } from 'chai';
import moment from 'moment';

import expenseTypes from '../../../server/constants/expense-type';
import POLICIES from '../../../server/constants/policies';
import {
  US_TAX_FORM_THRESHOLD_FOR_PAYPAL,
  US_TAX_FORM_THRESHOLD_POST_2026,
  US_TAX_FORM_THRESHOLD_PRE_2026,
} from '../../../server/constants/tax-form';
import SQLQueries from '../../../server/lib/queries';
import { amountsRequireTaxForm } from '../../../server/lib/tax-forms';
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
const US_TAX_FORM_THRESHOLD = YEAR >= 2026 ? US_TAX_FORM_THRESHOLD_POST_2026 : US_TAX_FORM_THRESHOLD_PRE_2026;

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
      amount: Math.ceil((US_TAX_FORM_THRESHOLD + 100e2) / 3), // Split into 3 expenses that together exceed threshold
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

    await LegalDocument.expireOldDocuments();
  });

  describe('amountsRequireTaxForm', () => {
    it('uses the configured threshold for the matching entity type', () => {
      expect(
        amountsRequireTaxForm(0, 100, YEAR, {
          isUSEntity: true,
          taxFormThresholds: { US: 100, NON_US: 200 },
        }),
      ).to.be.true;
      expect(
        amountsRequireTaxForm(0, 199, YEAR, {
          isUSEntity: false,
          taxFormThresholds: { US: 100, NON_US: 200 },
        }),
      ).to.be.false;
      expect(
        amountsRequireTaxForm(0, 200, YEAR, {
          isUSEntity: false,
          taxFormThresholds: { US: 100, NON_US: 200 },
        }),
      ).to.be.true;
    });

    it('uses the configured threshold for the combined total and does not apply the PayPal threshold', () => {
      expect(
        amountsRequireTaxForm(100000e2, 0, YEAR, {
          isUSEntity: true,
          taxFormThresholds: { US: 100000e2 + 1 },
        }),
      ).to.be.false;
      expect(
        amountsRequireTaxForm(200, 50, YEAR, {
          isUSEntity: true,
          taxFormThresholds: { US: 100 },
        }),
      ).to.be.false;
    });

    it('can exclude PayPal expenses from the threshold calculation', () => {
      expect(
        amountsRequireTaxForm(100000e2, 0, YEAR, {
          isUSEntity: true,
          includePayPalExpenses: false,
        }),
      ).to.be.false;
      expect(
        amountsRequireTaxForm(100, 100, YEAR, {
          isUSEntity: true,
          includePayPalExpenses: false,
          taxFormThresholds: { US: 100 },
        }),
      ).to.be.true;
      expect(
        amountsRequireTaxForm(100, 0, YEAR, {
          isUSEntity: true,
          includePayPalExpenses: false,
          taxFormThresholds: { US: 100 },
        }),
      ).to.be.false;
    });

    it('excludes PayPal expenses from the threshold calculation by default', () => {
      // Without an explicit includePayPalExpenses flag, PayPal expenses should NOT push
      // an account over the threshold (PayPal handles its own tax form collection/reporting).
      expect(
        amountsRequireTaxForm(US_TAX_FORM_THRESHOLD_FOR_PAYPAL, 0, YEAR, {
          isUSEntity: true,
        }),
      ).to.be.false;
      expect(
        amountsRequireTaxForm(100000e2, 0, YEAR, {
          isUSEntity: true,
          includePayPalExpenses: undefined,
        }),
      ).to.be.false;
      // Non-PayPal expenses alone should still trigger a tax form when over the threshold.
      expect(
        amountsRequireTaxForm(0, US_TAX_FORM_THRESHOLD + 1, YEAR, {
          isUSEntity: true,
        }),
      ).to.be.true;
      // Hosts that want the previous behavior can opt back in with includePayPalExpenses: true.
      expect(
        amountsRequireTaxForm(US_TAX_FORM_THRESHOLD_FOR_PAYPAL, 0, YEAR, {
          isUSEntity: true,
          includePayPalExpenses: true,
        }),
      ).to.be.true;
    });
  });

  describe('SQLQueries', () => {
    describe('custom tax form thresholds', () => {
      it('applies host thresholds to US and non-US accounts and expenses', async () => {
        const customHost = await fakeHost({
          data: {
            policies: {
              [POLICIES.TAX_FORM_THRESHOLDS]: { US: 100, NON_US: 200, includePayPalExpenses: false },
            },
          },
        });
        await RequiredLegalDocument.create({
          HostCollectiveId: customHost.id,
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        });

        const usAccount = await fakeCollective({
          HostCollectiveId: null,
          countryISO: 'US',
          data: { isUSEntity: true },
        });
        const nonUsAccount = await fakeCollective({
          HostCollectiveId: null,
          countryISO: 'CA',
        });
        const paypalAccount = await fakeCollective({ HostCollectiveId: null, countryISO: 'US' });
        const hostedCollective = await fakeCollective({ HostCollectiveId: customHost.id });
        const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
        const paypalPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.PAYPAL });
        const usExpense = await fakeExpense({
          FromCollectiveId: usAccount.id,
          CollectiveId: hostedCollective.id,
          amount: 150,
          PayoutMethodId: payoutMethod.id,
        });
        const nonUsExpense = await fakeExpense({
          FromCollectiveId: nonUsAccount.id,
          CollectiveId: hostedCollective.id,
          amount: 150,
          PayoutMethodId: payoutMethod.id,
        });
        const paypalExpense = await fakeExpense({
          FromCollectiveId: paypalAccount.id,
          CollectiveId: hostedCollective.id,
          amount: 150,
          PayoutMethodId: paypalPayoutMethod.id,
        });

        const accounts = await SQLQueries.getTaxFormsRequiredForAccounts({
          HostCollectiveId: customHost.id,
          year: YEAR,
          ignoreReceived: true,
        });
        expect(accounts.has(usAccount.id)).to.be.true;
        expect(accounts.has(nonUsAccount.id)).to.be.false;
        expect(accounts.has(paypalAccount.id)).to.be.false;

        const expenses = await SQLQueries.getTaxFormsRequiredForExpenses([
          usExpense.id,
          nonUsExpense.id,
          paypalExpense.id,
        ]);
        expect(expenses.has(usExpense.id)).to.be.true;
        expect(expenses.has(nonUsExpense.id)).to.be.false;
        expect(expenses.has(paypalExpense.id)).to.be.false;
      });

      xit('evaluates totals independently for each host', async () => {
        const hostData = {
          policies: {
            [POLICIES.TAX_FORM_THRESHOLDS]: { US: 100, NON_US: 100, includePayPalExpenses: false },
          },
        };
        const firstHost = await fakeHost({ data: hostData });
        const secondHost = await fakeHost({ data: hostData });
        await RequiredLegalDocument.bulkCreate([
          { HostCollectiveId: firstHost.id, documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM },
          { HostCollectiveId: secondHost.id, documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM },
        ]);

        const account = await fakeCollective({ HostCollectiveId: null, countryISO: 'US' });
        const firstCollective = await fakeCollective({ HostCollectiveId: firstHost.id });
        const secondCollective = await fakeCollective({ HostCollectiveId: secondHost.id });
        const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
        const firstExpense = await fakeExpense({
          FromCollectiveId: account.id,
          CollectiveId: firstCollective.id,
          amount: 60,
          PayoutMethodId: payoutMethod.id,
        });
        const secondExpense = await fakeExpense({
          FromCollectiveId: account.id,
          CollectiveId: secondCollective.id,
          amount: 60,
          PayoutMethodId: payoutMethod.id,
        });
        await secondExpense.update({ HostCollectiveId: secondHost.id });

        const accounts = await SQLQueries.getTaxFormsRequiredForAccounts({ year: YEAR, ignoreReceived: true });
        const expenses = await SQLQueries.getTaxFormsRequiredForExpenses([firstExpense.id]);
        expect({ account: accounts.has(account.id), expense: expenses.has(firstExpense.id) }).to.deep.equal({
          account: false,
          expense: false,
        });
      });
    });

    describe('getTaxFormsRequiredForAccounts', () => {
      it('returns the right profiles for pending tax forms', async () => {
        const accounts = await SQLQueries.getTaxFormsRequiredForAccounts({ year: YEAR, ignoreReceived: true });
        // PayPal expenses are excluded by default, so accountWithPaypalOverThreshold is no longer required.
        // Previously: 8 (7 legit + 1 "error" document); now: 7 (6 legit + 1 "error" document).
        expect(accounts.size).to.be.eq(7);
        expect(accounts.has(organizationWithTaxForm.id)).to.be.true;
        expect(accounts.has(accountWithTaxFormFromLastYear.id)).to.be.false;
        expect(accounts.has(accountWithTaxFormFrom4YearsAgo.id)).to.be.true;
        expect(accounts.has(accountAlreadyNotified.id)).to.be.true;
        expect(accounts.has(hostCollective.id)).to.be.false;
        expect(accounts.has(users[4].CollectiveId)).to.be.false;
        // PayPal expenses are excluded from the threshold calculation by default
        // (PayPal handles its own tax form collection and reporting).
        expect(accounts.has(accountWithPaypalOverThreshold.id)).to.be.false;
        expect(accounts.has(accountWithPaypalBelowThreshold.id)).to.be.false;
        expect(accounts.has(accountWithOnlyADraft.id)).to.be.false;
        expect(accounts.has(accountWithINROverThreshold.id)).to.be.true;
        expect(accounts.has(accountWithINRBelowThreshold.id)).to.be.false;
      });
    });
  });
});
