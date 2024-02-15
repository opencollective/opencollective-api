import { expect } from 'chai';
import { findLast, pick, set } from 'lodash';
import sinon from 'sinon';

import {
  getRecentMisclassifiedExpenses,
  groupMisclassifiedExpensesByAccount,
  run as runCron,
} from '../../../cron/weekly/send-accounting-category-educational-emails';
import ActivityTypes from '../../../server/constants/activities';
import POLICIES from '../../../server/constants/policies';
import emailLib from '../../../server/lib/email';
import { AccountingCategory, Collective, User } from '../../../server/models';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/weekly/send-accounting-category-educational-emails', () => {
  const expensesWithWrongPicks = [];
  const sandbox = sinon.createSandbox();
  let host: Collective,
    collective: Collective,
    submitter: User,
    hostAdmin: User,
    collectiveAdmin: User,
    anotherCollectiveAdmin: User,
    collectiveAdminThatIsAlsoHostAdmin: User,
    accountingCategoryGeneric1: AccountingCategory,
    accountingCategoryGeneric2: AccountingCategory;

  const fakeExpenseWithAccountingCategories = async ({
    editors = [] as Array<{
      role: 'collectiveAdmin' | 'submitter' | 'hostAdmin';
      user: User;
      category: AccountingCategory | null;
    }>,
    ...fields
  }) => {
    const data = fields.data || {};
    const submitterCategory = findLast(editors, e => e.role === 'submitter')?.category;
    const collectiveAdminCategory = findLast(editors, e => e.role === 'collectiveAdmin')?.category;
    const hostAdminCategory = findLast(editors, e => e.role === 'hostAdmin')?.category;
    if (submitterCategory) {
      set(data, 'valuesByRole.submitter.accountingCategory', submitterCategory.publicInfo);
    }
    if (collectiveAdminCategory) {
      set(data, 'valuesByRole.collectiveAdmin.accountingCategory', collectiveAdminCategory.publicInfo);
    }
    if (hostAdminCategory) {
      set(data, 'valuesByRole.hostAdmin.accountingCategory', hostAdminCategory.publicInfo);
    }

    const expense = await fakeExpense({
      HostCollectiveId: host?.id,
      CollectiveId: collective?.id,
      ...fields,
      data,
    });

    await expense.createActivity(ActivityTypes.COLLECTIVE_EXPENSE_CREATED, expense.User);

    // Create some edit activities for realistic setup
    for (const { user, category } of editors) {
      await expense.update({ AccountingCategoryId: category ? category.id : null });
      await expense.createActivity(ActivityTypes.COLLECTIVE_EXPENSE_UPDATED, user);
    }

    // Restore requested category, if set
    if (fields.AccountingCategoryId !== undefined && fields.AccountingCategoryId !== expense.AccountingCategoryId) {
      await expense.update({ AccountingCategoryId: fields.AccountingCategoryId });
    }

    return expense;
  };

  before(async () => {
    await resetTestDB();

    // Setup test data
    submitter = await fakeUser();
    hostAdmin = await fakeUser();
    collectiveAdmin = await fakeUser();
    anotherCollectiveAdmin = await fakeUser();
    collectiveAdminThatIsAlsoHostAdmin = await fakeUser();
    const hostPolicies = {
      [POLICIES.EXPENSE_CATEGORIZATION]: { requiredForExpenseSubmitters: true, requiredForCollectiveAdmins: true },
    };
    host = await fakeActiveHost({ admin: hostAdmin, data: { policies: hostPolicies } });
    collective = await fakeCollective({ isActive: true, HostCollectiveId: host.id });
    await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
    await collective.addUserWithRole(anotherCollectiveAdmin, 'ADMIN');
    await collective.addUserWithRole(collectiveAdminThatIsAlsoHostAdmin, 'ADMIN');
    await host.addUserWithRole(collectiveAdminThatIsAlsoHostAdmin, 'ADMIN');

    accountingCategoryGeneric1 = await fakeAccountingCategory({
      code: 'GENERIC1',
      hostOnly: false,
      kind: 'EXPENSE',
      CollectiveId: collective.HostCollectiveId,
      name: 'Generic Category 1',
      friendlyName: 'Generic Category 1 friendly name',
    });
    accountingCategoryGeneric2 = await fakeAccountingCategory({
      code: 'GENERIC2',
      hostOnly: false,
      kind: 'EXPENSE',
      CollectiveId: collective.HostCollectiveId,
      name: 'Generic Category 2',
      friendlyName: 'Generic Category 2 friendly name',
    });
    const accountingCategoryHostOnly = await fakeAccountingCategory({
      code: 'HOSTONLY',
      hostOnly: true,
      kind: 'EXPENSE',
      CollectiveId: collective.HostCollectiveId,
    });
    const accountingCategoryInvoice = await fakeAccountingCategory({
      code: 'INVOICE',
      kind: 'EXPENSE',
      hostOnly: false,
      expensesTypes: ['INVOICE'],
      CollectiveId: collective.HostCollectiveId,
    });
    const accountingCategoryContribution = await fakeAccountingCategory({
      code: 'CONTRIBUTIONS',
      kind: 'CONTRIBUTION',
      hostOnly: false,
      CollectiveId: collective.HostCollectiveId,
    });

    // ==== Expenses that should be ignored ====
    await Promise.all([
      // Only expenses with an accounting category
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        status: 'PAID',
        AccountingCategoryId: null,
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: null },
        ],
      }),
      // Only paid expenses
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        status: 'PENDING',
        AccountingCategoryId: accountingCategoryGeneric2.id,
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
        ],
      }),
      // Only expenses with a non-host-only accounting category
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        status: 'PENDING',
        AccountingCategoryId: accountingCategoryHostOnly.id,
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryHostOnly },
        ],
      }),
      // Only expenses with a compatible kind
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        status: 'PENDING',
        AccountingCategoryId: accountingCategoryContribution.id,
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryContribution },
        ],
      }),
      // Only expenses with an expense type compatible with the user pick
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        status: 'PAID',
        type: 'RECEIPT',
        AccountingCategoryId: accountingCategoryInvoice.id,
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryInvoice },
        ],
      }),
      // Only expenses created in the last 7 day s
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        status: 'PAID',
        type: 'RECEIPT',
        AccountingCategoryId: accountingCategoryGeneric2.id,
        createdAt: new Date('2020-01-01'),
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
        ],
      }),
      // Emails already sent
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        UserId: submitter.id,
        status: 'PAID',
        description: 'Expense with a different category picked by the submitter',
        AccountingCategoryId: accountingCategoryGeneric2.id,
        data: { sentEmails: { 'expense-accounting-category-educational': true } },
        editors: [
          { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
        ],
      }),
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        UserId: submitter.id,
        status: 'PAID',
        description: 'Expense with a different category picked by the collective admin',
        AccountingCategoryId: accountingCategoryGeneric2.id,
        data: { sentEmails: { 'expense-accounting-category-educational': true } },
        editors: [
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
        ],
      }),
      // Get only the latest activity: if user sets category A then B, only notify about B even if A was wrong
      fakeExpenseWithAccountingCategories({
        CollectiveId: collective.id,
        FromCollectiveId: submitter.CollectiveId,
        UserId: submitter.id,
        status: 'PAID',
        description: 'Expense with a different category picked by the collective admin',
        AccountingCategoryId: accountingCategoryGeneric2.id,
        editors: [
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
          { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric2 },
          { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
        ],
      }),
    ]);

    // ==== Expenses that should be reported to the submitter ====
    expensesWithWrongPicks.push(
      ...(await Promise.all([
        fakeExpenseWithAccountingCategories({
          CollectiveId: collective.id,
          FromCollectiveId: submitter.CollectiveId,
          UserId: submitter.id,
          status: 'PAID',
          description: 'Expense with a different category picked by the submitter',
          AccountingCategoryId: accountingCategoryGeneric2.id,
          editors: [
            { role: 'submitter', user: submitter, category: accountingCategoryGeneric1 },
            { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
          ],
        }),
        fakeExpenseWithAccountingCategories({
          CollectiveId: collective.id,
          FromCollectiveId: submitter.CollectiveId,
          UserId: submitter.id,
          status: 'PAID',
          description: 'Expense n.2 with a different category picked by the submitter',
          AccountingCategoryId: accountingCategoryGeneric1.id,
          editors: [
            { role: 'submitter', user: submitter, category: accountingCategoryGeneric2 },
            { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric1 },
          ],
        }),
        fakeExpenseWithAccountingCategories({
          CollectiveId: collective.id,
          FromCollectiveId: submitter.CollectiveId,
          UserId: submitter.id,
          status: 'PAID',
          description: 'Expense with a different category picked by the collective admin',
          AccountingCategoryId: accountingCategoryGeneric2.id,
          editors: [
            { role: 'collectiveAdmin', user: collectiveAdmin, category: accountingCategoryGeneric1 },
            { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
          ],
        }),
        // This one will be returned as misclassified, but no email will be sent since the collective admin is also a host admin
        fakeExpenseWithAccountingCategories({
          CollectiveId: collective.id,
          status: 'PAID',
          description: 'Expense with a different category picked by the collective admin that is also a host admin',
          AccountingCategoryId: accountingCategoryGeneric2.id,
          UserId: collectiveAdminThatIsAlsoHostAdmin.id,
          editors: [
            { role: 'collectiveAdmin', user: collectiveAdminThatIsAlsoHostAdmin, category: accountingCategoryGeneric1 },
            { role: 'hostAdmin', user: hostAdmin, category: accountingCategoryGeneric2 },
          ],
        }),
      ])),
    );
  });

  after(() => {
    sandbox.restore();
  });

  describe('getRecentMisclassifiedExpenses', async () => {
    it('should return the expenses that should be reported', async () => {
      const sanitizeExpense = e => pick(e.dataValues, ['id', 'description', 'accountingCategory.code', 'data']);
      const misclassifiedExpenses = await getRecentMisclassifiedExpenses();
      expect(misclassifiedExpenses).to.have.length(4);
      expect(misclassifiedExpenses.map(sanitizeExpense)).to.containSubset([
        {
          description: 'Expense with a different category picked by the submitter',
          accountingCategory: { code: 'GENERIC2' },
          data: { valuesByRole: { submitter: { accountingCategory: { code: 'GENERIC1' } } } },
        },
        {
          description: 'Expense n.2 with a different category picked by the submitter',
          accountingCategory: { code: 'GENERIC1' },
          data: { valuesByRole: { submitter: { accountingCategory: { code: 'GENERIC2' } } } },
        },
        {
          description: 'Expense with a different category picked by the collective admin',
          accountingCategory: { code: 'GENERIC2' },
          data: { valuesByRole: { collectiveAdmin: { accountingCategory: { code: 'GENERIC1' } } } },
        },
        // This one is misclassified, but no email will be sent out as the collective admin is also a host admin
        {
          description: 'Expense with a different category picked by the collective admin that is also a host admin',
          accountingCategory: { code: 'GENERIC2' },
          data: { valuesByRole: { collectiveAdmin: { accountingCategory: { code: 'GENERIC1' } } } },
        },
      ]);
    });
  });

  describe('groupMisclassifiedExpensesByAccount', () => {
    it('should group the expenses by the accounting category picked', async () => {
      const misclassified = await getRecentMisclassifiedExpenses();
      const grouped = await groupMisclassifiedExpensesByAccount(misclassified);
      const sanitizeExpense = e => pick(e.dataValues, ['id', 'description']);

      // In case of mismatch, chaisubset will produce an infinite loop trying to serialize the model if we pass it entirely
      const sanitizedGrouped = Object.fromEntries(
        Array.from(grouped.entries()).map(([user, mistakes]) => [
          user.id,
          mistakes.map(mistake => ({
            ...mistake,
            expense: sanitizeExpense(mistake.expense),
          })),
        ]),
      );

      expect(sanitizedGrouped).to.containSubset({
        [submitter.id]: [
          {
            expense: sanitizeExpense(expensesWithWrongPicks[0]),
            selectedCategoryId: accountingCategoryGeneric1.id,
            role: 'submitter',
          },
          {
            expense: sanitizeExpense(expensesWithWrongPicks[1]),
            selectedCategoryId: accountingCategoryGeneric2.id,
            role: 'submitter',
          },
        ],
        [collectiveAdmin.id]: [
          {
            expense: sanitizeExpense(expensesWithWrongPicks[2]),
            selectedCategoryId: accountingCategoryGeneric1.id,
            role: 'collectiveAdmin',
          },
        ],
      });
    });
  });

  describe('run', () => {
    it('should send bundled emails and mark them sent', async () => {
      const sendMessageStub = sandbox.stub(emailLib, 'sendMessage');
      await runCron();
      expect(sendMessageStub.callCount).to.equal(2);

      // Make sure the emails are marked as sent
      await Promise.all(expensesWithWrongPicks.map(expense => expense.reload()));
      expect(expensesWithWrongPicks[0]).to.have.nested.property(
        'data.sentEmails.expense-accounting-category-educational',
        true,
      );
      expect(expensesWithWrongPicks[1]).to.have.nested.property(
        'data.sentEmails.expense-accounting-category-educational',
        true,
      );

      // First email
      const [firstEmailTo, firstEmailSubject, firstEmailBody] = sendMessageStub.firstCall.args;
      expect(firstEmailTo).to.eq(submitter.email);
      expect(firstEmailSubject).to.eq('Some of your expenses have been re-categorized');
      expect(firstEmailBody).to.contain(`Hi ${submitter.collective.name}`);
      expect(firstEmailBody).to.match(
        /some of the expenses you submitted were reviewed by the fiscal host(.+)Test Host(.+)and in the process/,
      );
      expect(firstEmailBody).to.contain(
        `http://localhost:3000/${collective.slug}/expenses/${expensesWithWrongPicks[0].id}`,
      );
      expect(firstEmailBody).to.contain('Expense with a different category picked by the submitter');
      expect(firstEmailBody).to.match(/you selected:(.+)GENERIC1 - Generic Category 1/);
      expect(firstEmailBody).to.match(/category selected by the fiscal host:(.+)GENERIC2 - Generic Category 2/);
      expect(firstEmailBody).to.match(new RegExp(`Sincerely,[\\S\\s]+The(.+)${host.name}(.+)team`));

      // Second email
      const [secondEmailTo, secondEmailSubject, secondEmailBody] = sendMessageStub.secondCall.args;
      expect(secondEmailTo).to.eq(collectiveAdmin.email);
      expect(secondEmailSubject).to.eq(
        `An expense you approved on behalf of ${collective.name} has been re-categorized`,
      );

      expect(secondEmailBody).to.contain(`Hi ${collectiveAdmin.collective.name}`);
      expect(secondEmailBody).to.match(/an expense you approved on behalf of your collective(.+)Test Collective(.+)/);
      expect(secondEmailBody).to.match(/was reviewed by\s+your fiscal host(.+)Test Host(.+)and in the process/);
      expect(secondEmailBody).to.contain(
        `http://localhost:3000/${collective.slug}/expenses/${expensesWithWrongPicks[2].id}`,
      );
      expect(secondEmailBody).to.contain('Expense with a different category picked by the collective admin');
      expect(secondEmailBody).to.match(/you selected:(.+)GENERIC1 - Generic Category 1/);
      expect(secondEmailBody).to.match(/category selected by the fiscal host:(.+)GENERIC2 - Generic Category 2/);
      expect(secondEmailBody).to.match(new RegExp(`Sincerely,[\\S\\s]+The(.+)${host.name}(.+)team`));
    });
  });
});
