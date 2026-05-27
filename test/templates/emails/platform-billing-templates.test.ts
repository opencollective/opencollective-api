import { expect } from 'chai';
import config from 'config';

import { EmailTheme } from '../../../server/constants/email-theme';
import emailTemplates from '../../../server/lib/emailTemplates';
import handlebars from '../../../server/lib/handlebars';

const baseSubscriptionDetailsData = {
  collective: { name: 'Test Org', slug: 'test-org', hasHosting: false },
  bill: {
    billingPeriod: { month: 3, year: 2026 },
    dueDate: new Date('2026-04-01'),
    totalAmount: 15000,
    utilization: { expensesPaid: 20, activeCollectives: 10 },
  },
  expense: { status: 'APPROVED', currency: 'USD' as const },
};

describe('templates/emails platform billing (hosting)', () => {
  const renderSubscriptionDetails = (data: Record<string, unknown>) =>
    handlebars.compile('{{> subscription-details}}')({ ...baseSubscriptionDetailsData, ...data });

  it('subscription-details: omits Active Collectives when collective.hasHosting is false', () => {
    const html = renderSubscriptionDetails({
      collective: { name: 'Test Org', slug: 'test-org', hasHosting: false },
    });
    expect(html).to.not.include('Active Collectives');
    expect(html).to.include('Expenses Processed');
    expect(html).to.include('20');
  });

  it('subscription-details: includes Active Collectives when collective.hasHosting is true', () => {
    const html = renderSubscriptionDetails({
      collective: { name: 'Test Org', slug: 'test-org', hasHosting: true },
    });
    expect(html).to.include('Active Collectives');
    expect(html).to.include('Expenses Processed');
  });

  it('platform.billing.additional.charges.notification: omits active collectives copy when hasHosting is false', () => {
    const html = emailTemplates['platform.billing.additional.charges.notification']({
      theme: EmailTheme,
      config: { host: config.host },
      collective: { name: 'No Hosting Org', slug: 'no-hosting', hasHosting: false },
      subscription: {
        plan: {
          title: 'Standard Plan',
          pricing: {
            includedCollectives: 5,
            includedExpensesPerMonth: 10,
            pricePerAdditionalCollective: 600,
            pricePerAdditionalExpense: 200,
          },
        },
      },
      currentUtilization: { activeCollectives: 12, expensesPaid: 15 },
    });
    expect(html).to.not.match(/active monthly collectives/i);
    expect(html).to.include('paid expenses');
  });

  it('platform.billing.additional.charges.notification: includes active collectives copy when hasHosting is true', () => {
    const html = emailTemplates['platform.billing.additional.charges.notification']({
      theme: EmailTheme,
      config: { host: config.host },
      collective: { name: 'Hosting Org', slug: 'hosting', hasHosting: true },
      subscription: {
        plan: {
          title: 'Standard Plan',
          pricing: {
            includedCollectives: 5,
            includedExpensesPerMonth: 10,
            pricePerAdditionalCollective: 600,
            pricePerAdditionalExpense: 200,
          },
        },
      },
      currentUtilization: { activeCollectives: 12, expensesPaid: 15 },
    });
    expect(html).to.match(/active monthly collectives/i);
  });

  it('platform.billing.overdue.reminder: does not reference Active Collectives', () => {
    const html = emailTemplates['platform.billing.overdue.reminder']({
      theme: EmailTheme,
      config: { host: config.host },
      collective: { name: 'Org', slug: 'org', hasHosting: false },
      expenses: [{ id: 1, amount: 1000, dueDate: new Date() }],
      totalAmount: 1000,
      currency: 'USD',
    });
    expect(html).to.not.include('Active Collectives');
  });

  it('platform.billing.new.expense: omits Active Collectives when collective.hasHosting is false', () => {
    const html = emailTemplates['platform.billing.new.expense']({
      theme: EmailTheme,
      config: { host: config.host },
      collective: { name: 'Org', slug: 'org', hasHosting: false },
      bill: {
        billingPeriod: { month: 3, year: 2026 },
        dueDate: new Date('2026-04-15'),
        totalAmount: 10000,
        utilization: { expensesPaid: 12, activeCollectives: 50 },
      },
      expense: { id: 4242, currency: 'USD' as const, status: 'APPROVED' },
    });
    expect(html).to.not.include('Active Collectives');
    expect(html).to.include('Expenses Processed');
  });

  it('platform.billing.payment.confirmation: omits utilization rows (including Active Collectives) when hideUtilization is set', () => {
    const html = emailTemplates['platform.billing.payment.confirmation']({
      theme: EmailTheme,
      config: { host: config.host },
      collective: { name: 'Org', slug: 'org', hasHosting: true },
      bill: {
        billingPeriod: { month: 3, year: 2026 },
        dueDate: new Date('2026-04-15'),
        totalAmount: 10000,
        utilization: { expensesPaid: 12, activeCollectives: 50 },
      },
      expense: { id: 4242, currency: 'USD' as const, status: 'PAID', updatedAt: new Date() },
    });
    expect(html).to.not.include('Active Collectives');
    expect(html).to.not.include('Expenses Processed');
  });
});
