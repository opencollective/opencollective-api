import { expect } from 'chai';
import sinon from 'sinon';

import { ContributionRoles } from '../../../../../server/constants/contribution-roles';
import FEATURE from '../../../../../server/constants/feature';
import { TierFrequencyKey } from '../../../../../server/graphql/v2/enum/TierFrequency';
import {
  applyContributionAccountingCategoryRules,
  normalizeContributionAccountingCategoryRulePredicate,
  resolveContributionAccountingCategory,
} from '../../../../../server/lib/accounting/categorization/contribution-rules';
import {
  ContributionAccountingCategoryRuleOperator,
  ContributionAccountingCategoryRulePredicate,
  ContributionAccountingCategoryRuleSubject,
} from '../../../../../server/lib/accounting/categorization/types';
import models, { Collective, Order } from '../../../../../server/models';
import { ContributionAccountingCategoryRule } from '../../../../../server/models/ContributionAccountingCategoryRule';
import { fakeActiveHost, fakeCollective, fakeOrder } from '../../../../test-helpers/fake-data';

describe('server/lib/accounting/categorization/contribution-rules', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });
  afterEach(() => {
    sandbox.restore();
  });
  describe('normalizeContributionAccountingCategoryRulePredicate', () => {
    it('normalizes description with contains', async () => {
      const predicate = {
        subject: ContributionAccountingCategoryRuleSubject.description,
        operator: ContributionAccountingCategoryRuleOperator.contains,
        value: '  Hello world  ',
      };

      const result = await normalizeContributionAccountingCategoryRulePredicate(predicate);
      expect(result.subject).to.equal(ContributionAccountingCategoryRuleSubject.description);
      expect(result.operator).to.equal(ContributionAccountingCategoryRuleOperator.contains);
      expect(result.value).to.equal('  Hello world  ');
    });

    it('normalizes amount with numeric operators', async () => {
      const predicate = {
        subject: ContributionAccountingCategoryRuleSubject.amount,
        operator: ContributionAccountingCategoryRuleOperator.gte,
        value: 123,
      };

      const result = await normalizeContributionAccountingCategoryRulePredicate(predicate);
      expect(result.subject).to.equal(ContributionAccountingCategoryRuleSubject.amount);
      expect(result.operator).to.equal(ContributionAccountingCategoryRuleOperator.gte);
      expect(result.value).to.equal(123);
    });

    it('normalizes currency with eq', async () => {
      const predicate = {
        subject: ContributionAccountingCategoryRuleSubject.currency,
        operator: ContributionAccountingCategoryRuleOperator.eq,
        value: 'USD',
      };

      const result = await normalizeContributionAccountingCategoryRulePredicate(predicate);
      expect(result.subject).to.equal(ContributionAccountingCategoryRuleSubject.currency);
      expect(result.operator).to.equal(ContributionAccountingCategoryRuleOperator.eq);
      expect(result.value).to.equal('USD');
    });

    it('normalizes frequency with eq and in', async () => {
      const eqPredicate = {
        subject: ContributionAccountingCategoryRuleSubject.frequency,
        operator: ContributionAccountingCategoryRuleOperator.eq,
        value: TierFrequencyKey.MONTHLY,
      };

      const inPredicate = {
        subject: ContributionAccountingCategoryRuleSubject.frequency,
        operator: ContributionAccountingCategoryRuleOperator.in,
        value: [TierFrequencyKey.MONTHLY, TierFrequencyKey.YEARLY],
      };

      const eqResult = await normalizeContributionAccountingCategoryRulePredicate(eqPredicate);
      const inResult = await normalizeContributionAccountingCategoryRulePredicate(inPredicate);

      expect(eqResult.value).to.equal(TierFrequencyKey.MONTHLY);
      expect(inResult.value).to.deep.equal([TierFrequencyKey.MONTHLY, TierFrequencyKey.YEARLY]);
    });

    it('normalizes toAccount with eq and in using account reference IDs', async () => {
      const account = await fakeCollective();

      const eqPredicate = {
        subject: ContributionAccountingCategoryRuleSubject.toAccount,
        operator: ContributionAccountingCategoryRuleOperator.eq,
        value: account.slug,
      };

      const inPredicate = {
        subject: ContributionAccountingCategoryRuleSubject.toAccount,
        operator: ContributionAccountingCategoryRuleOperator.in,
        value: [account.slug],
      };

      const eqResult = await normalizeContributionAccountingCategoryRulePredicate(eqPredicate);
      const inResult = await normalizeContributionAccountingCategoryRulePredicate(inPredicate);

      expect(eqResult.value).to.equal(account.slug);
      expect(inResult.value).to.deep.equal([account.slug]);
    });

    it('throws for invalid subject', async () => {
      const predicate = {
        subject: 'invalid-subject',
        operator: ContributionAccountingCategoryRuleOperator.contains,
        value: 'test',
      } as unknown as ContributionAccountingCategoryRulePredicate;

      await expect(normalizeContributionAccountingCategoryRulePredicate(predicate)).to.be.rejectedWith(
        'Invalid subject: invalid-subject',
      );
    });

    it('throws for invalid operator for subject', async () => {
      const predicate = {
        subject: ContributionAccountingCategoryRuleSubject.description,
        operator: ContributionAccountingCategoryRuleOperator.eq,
        value: 'test',
      };

      await expect(normalizeContributionAccountingCategoryRulePredicate(predicate)).to.be.rejectedWith(
        'Invalid operator: eq',
      );
    });

    it('throws for invalid value according to subject definition', async () => {
      const predicate = {
        subject: ContributionAccountingCategoryRuleSubject.amount,
        operator: ContributionAccountingCategoryRuleOperator.eq,
        // invalid: must be a non-negative number
        value: -1,
      };

      await expect(normalizeContributionAccountingCategoryRulePredicate(predicate)).to.be.rejectedWith('Invalid value');
    });
  });

  describe('resolveContributionAccountingCategory', () => {
    it('returns null when there are no rules', async () => {
      const result = await resolveContributionAccountingCategory([], {} as never);
      expect(result).to.be.null;
    });

    it('returns the accounting category of the first matching rule', async () => {
      const accountingCategory1 = { id: 1 };
      const accountingCategory2 = { id: 2 };
      const rules = [
        {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.gte,
              value: 200,
            },
          ],
        },
        {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.gte,
              value: 100,
            },
          ],
        },
      ] as ContributionAccountingCategoryRule[];

      const order = await fakeOrder({ totalAmount: 150 });

      const result = await resolveContributionAccountingCategory(rules, order);
      expect(result?.id).to.equal(2);
    });

    it('requires all predicates on a rule to match', async () => {
      const usdOrder = await fakeOrder({ totalAmount: 150, currency: 'USD' });
      const eurOrder = await fakeOrder({ totalAmount: 150, currency: 'EUR' });
      const gbpOrder = await fakeOrder({ totalAmount: 150, currency: 'GBP' });

      const usdAccountingCategory = { id: 1 };
      const eurAccountingCategory = { id: 2 };

      const rules = [
        {
          AccountingCategoryId: 1,
          accountingCategory: usdAccountingCategory,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.gte,
              value: 100,
            },
            {
              subject: ContributionAccountingCategoryRuleSubject.currency,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: usdOrder.currency,
            },
          ],
        },
        {
          AccountingCategoryId: 2,
          accountingCategory: eurAccountingCategory,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.gte,
              value: 100,
            },
            {
              subject: ContributionAccountingCategoryRuleSubject.currency,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: eurOrder.currency,
            },
          ],
        },
      ] as ContributionAccountingCategoryRule[];

      const usdResult = await resolveContributionAccountingCategory(rules, usdOrder);
      const eurResult = await resolveContributionAccountingCategory(rules, eurOrder);
      const gbpResult = await resolveContributionAccountingCategory(rules, gbpOrder);

      expect(usdResult?.id).to.equal(1);
      expect(eurResult?.id).to.equal(2);
      expect(gbpResult).to.be.null;
    });

    it('throws for rules with invalid subjects', async () => {
      const rules = [
        {
          AccountingCategoryId: 1,
          predicates: [
            {
              subject: 'invalid-subject',
              operator: ContributionAccountingCategoryRuleOperator.contains,
              value: 'foo',
            },
          ],
        },
      ] as unknown as ContributionAccountingCategoryRule[];
      const order = (await fakeOrder({ description: 'foo' })) as Order;
      await expect(resolveContributionAccountingCategory(rules, order)).to.be.rejectedWith(
        'Invalid subject: invalid-subject',
      );
    });
  });

  describe('matches on order', () => {
    describe('description', () => {
      it('matches when description contains the value', async () => {
        const order = await fakeOrder({ description: 'This is a test description' });
        const accountingCategory = { id: 1 };
        const predicate: ContributionAccountingCategoryRulePredicate = {
          subject: ContributionAccountingCategoryRuleSubject.description,
          operator: ContributionAccountingCategoryRuleOperator.contains,
          value: 'test',
        };

        const result = await resolveContributionAccountingCategory(
          [
            {
              AccountingCategoryId: 1,
              accountingCategory,
              predicates: [predicate],
            },
          ] as ContributionAccountingCategoryRule[],
          order,
        );
        expect(result?.id).to.equal(1);
      });
    });

    describe('amount', () => {
      it('matches eq, gte, and lte properly', async () => {
        const order = (await fakeOrder({ totalAmount: 100 })) as Order;

        const accountingCategory1 = { id: 1 };
        const eqRule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 100,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const gteRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.gte,
              value: 50,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory3 = { id: 3 };
        const lteRule = {
          AccountingCategoryId: 3,
          accountingCategory: accountingCategory3,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.lte,
              value: 150,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory4 = { id: 4 };
        const noMatchRule = {
          AccountingCategoryId: 4,
          accountingCategory: accountingCategory4,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 999,
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([eqRule], order))?.id).to.equal(1);
        expect((await resolveContributionAccountingCategory([gteRule], order))?.id).to.equal(2);
        expect((await resolveContributionAccountingCategory([lteRule], order))?.id).to.equal(3);
        expect(await resolveContributionAccountingCategory([noMatchRule], order)).to.be.null;
      });
    });

    describe('currency', () => {
      it('matches on exact order currency', async () => {
        const order = await fakeOrder({ currency: 'USD' });

        const accountingCategory1 = { id: 1 };
        const rule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.currency,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 'USD',
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const noMatchRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.currency,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 'EUR',
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([rule], order))?.id).to.equal(1);
        expect(await resolveContributionAccountingCategory([noMatchRule], order)).to.be.null;
      });
    });

    describe('frequency', () => {
      it('matches eq and in based on order.interval', async () => {
        const order = await fakeOrder({ interval: 'month' });

        const accountingCategory1 = { id: 1 };
        const eqRule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.frequency,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 'MONTHLY',
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const inRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.frequency,
              operator: ContributionAccountingCategoryRuleOperator.in,
              value: ['MONTHLY', 'YEARLY'],
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory3 = { id: 3 };
        const noMatchRule = {
          AccountingCategoryId: 3,
          accountingCategory: accountingCategory3,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.frequency,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 'YEARLY',
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([eqRule], order))?.id).to.equal(1);
        expect((await resolveContributionAccountingCategory([inRule], order))?.id).to.equal(2);
        expect(await resolveContributionAccountingCategory([noMatchRule], order)).to.be.null;
      });
    });

    describe('toAccount', () => {
      it('matches eq and in based on CollectiveId', async () => {
        const order = await fakeOrder();
        const randomCol = await fakeCollective();

        const accountingCategory1 = { id: 1 };
        const eqRule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.toAccount,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: order.collective.slug,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const inRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.toAccount,
              operator: ContributionAccountingCategoryRuleOperator.in,
              value: [order.collective.slug],
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory3 = { id: 3 };
        const noMatchRule = {
          AccountingCategoryId: 3,
          accountingCategory: accountingCategory3,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.toAccount,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: randomCol.slug,
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([eqRule], order))?.id).to.equal(1);
        expect((await resolveContributionAccountingCategory([inRule], order))?.id).to.equal(2);
        expect(await resolveContributionAccountingCategory([noMatchRule], order)).to.be.null;
      });
    });

    describe('toAccountType', () => {
      it('matches eq and in based on destination collective type', async () => {
        const collective = await fakeCollective();
        const order = await fakeOrder({ CollectiveId: collective.id });
        const reloadedOrder = await models.Order.findByPk(order.id, { include: ['collective'] });

        const accountingCategory1 = { id: 1 };
        const eqRule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.toAccountType,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: collective.type,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const inRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.toAccountType,
              operator: ContributionAccountingCategoryRuleOperator.in,
              value: [collective.type],
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory3 = { id: 3 };
        const noMatchRule = {
          AccountingCategoryId: 3,
          accountingCategory: accountingCategory3,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.toAccountType,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 'VENDOR',
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([eqRule], reloadedOrder as Order))?.id).to.equal(1);
        expect((await resolveContributionAccountingCategory([inRule], reloadedOrder as Order))?.id).to.equal(2);
        expect(await resolveContributionAccountingCategory([noMatchRule], reloadedOrder as Order)).to.be.null;
      });
    });

    describe('fromAccountType', () => {
      it('matches eq and in based on source collective type', async () => {
        const fromCollective = await fakeCollective();
        const order = await fakeOrder({ FromCollectiveId: fromCollective.id });
        const reloadedOrder = await models.Order.findByPk(order.id, { include: ['fromCollective'] });

        const accountingCategory1 = { id: 1 };
        const eqRule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.fromAccountType,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: fromCollective.type,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const inRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.fromAccountType,
              operator: ContributionAccountingCategoryRuleOperator.in,
              value: [fromCollective.type],
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory3 = { id: 3 };
        const noMatchRule = {
          AccountingCategoryId: 3,
          accountingCategory: accountingCategory3,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.fromAccountType,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: 'VENDOR',
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([eqRule], reloadedOrder as Order))?.id).to.equal(1);
        expect((await resolveContributionAccountingCategory([inRule], reloadedOrder as Order))?.id).to.equal(2);
        expect(await resolveContributionAccountingCategory([noMatchRule], reloadedOrder as Order)).to.be.null;
      });
    });

    describe('tierType', () => {
      it('matches eq and in based on tier id', async () => {
        const orderWithTier = await fakeOrder({}, { withTier: true });
        const reloadedOrder = await models.Order.findByPk(orderWithTier.id, { include: ['Tier'] });

        const accountingCategory1 = { id: 1 };
        const eqRule = {
          AccountingCategoryId: 1,
          accountingCategory: accountingCategory1,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.tierType,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: reloadedOrder.TierId,
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory2 = { id: 2 };
        const inRule = {
          AccountingCategoryId: 2,
          accountingCategory: accountingCategory2,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.tierType,
              operator: ContributionAccountingCategoryRuleOperator.in,
              value: [reloadedOrder.TierId],
            },
          ],
        } as ContributionAccountingCategoryRule;

        const accountingCategory3 = { id: 3 };
        const noMatchRule = {
          AccountingCategoryId: 3,
          accountingCategory: accountingCategory3,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.tierType,
              operator: ContributionAccountingCategoryRuleOperator.eq,
              value: (reloadedOrder.TierId || 0) + 1,
            },
          ],
        } as ContributionAccountingCategoryRule;

        expect((await resolveContributionAccountingCategory([eqRule], reloadedOrder as Order))?.id).to.equal(1);
        expect((await resolveContributionAccountingCategory([inRule], reloadedOrder as Order))?.id).to.equal(2);
        expect(await resolveContributionAccountingCategory([noMatchRule], reloadedOrder as Order)).to.be.null;
      });
    });
  });

  describe('applyContributionAccountingCategoryRules', () => {
    let host: Collective;
    let collective: Collective;
    before(async () => {
      host = await fakeActiveHost();
      await host.update({
        data: { features: { [FEATURE.CONTRIBUTION_CATEGORIZATION_RULES]: true }, isFirstPartyHost: true },
      });
      collective = await fakeCollective({ HostCollectiveId: host.id });
    });

    it('does nothing if order already has an AccountingCategoryId', async () => {
      const order = await fakeOrder({
        CollectiveId: collective.id,
      });
      order.AccountingCategoryId = 123;

      const getRulesSpy = sandbox.spy(ContributionAccountingCategoryRule, 'getRulesForCollective');
      const updateSpy = sandbox.spy(order, 'update');

      await applyContributionAccountingCategoryRules(order);

      expect(getRulesSpy).to.not.have.been.called;
      expect(updateSpy).to.not.have.been.called;
    });

    it('does nothing if host admin already set an accounting category', async () => {
      const order = await fakeOrder({ CollectiveId: collective.id });
      order.AccountingCategoryId = null;
      order.data = {
        ...(order.data || {}),
        valuesByRole: {
          ...(order.data?.valuesByRole || {}),
          [ContributionRoles.hostAdmin]: { accountingCategory: { code: 'EXISTING' } },
        },
      };

      const getRulesSpy = sandbox.spy(ContributionAccountingCategoryRule, 'getRulesForCollective');
      const updateSpy = sandbox.spy(order, 'update');

      await applyContributionAccountingCategoryRules(order);

      expect(getRulesSpy).to.not.have.been.called;
      expect(updateSpy).to.not.have.been.called;
    });

    it('does nothing if there are no rules for the collective', async () => {
      const order = await fakeOrder({ CollectiveId: collective.id });
      order.AccountingCategoryId = null;
      order.data = {};

      const getRulesStub = sandbox.stub(ContributionAccountingCategoryRule, 'getRulesForCollective').resolves([]);
      const updateSpy = sandbox.spy(order, 'update');

      await applyContributionAccountingCategoryRules(order);

      expect(getRulesStub).to.have.been.calledOnceWith(order.collective.HostCollectiveId);
      expect(updateSpy).to.not.have.been.called;
    });

    it('does nothing if the host does not have the feature active', async () => {
      const hostWithoutFeature = await fakeActiveHost();
      const collectiveWithoutFeature = await fakeCollective({ HostCollectiveId: hostWithoutFeature.id });
      const order = await fakeOrder({ CollectiveId: collectiveWithoutFeature.id });
      order.AccountingCategoryId = null;
      order.data = {};

      const getRulesSpy = sandbox.spy(ContributionAccountingCategoryRule, 'getRulesForCollective');
      const updateSpy = sandbox.spy(order, 'update');

      await applyContributionAccountingCategoryRules(order);

      expect(getRulesSpy).to.not.have.been.called;
      expect(updateSpy).to.not.have.been.called;
    });

    it('applies the accounting category from the first matching rule', async () => {
      const order = await fakeOrder({ totalAmount: 150, CollectiveId: collective.id });
      order.AccountingCategoryId = null;
      order.data = {};

      const accountingCategory = { id: 42, publicInfo: { code: 'REV-001' } };

      const rules = [
        {
          AccountingCategoryId: 42,
          accountingCategory,
          predicates: [
            {
              subject: ContributionAccountingCategoryRuleSubject.amount,
              operator: ContributionAccountingCategoryRuleOperator.gte,
              value: 100,
            },
          ],
        },
      ] as ContributionAccountingCategoryRule[];

      const getRulesStub = sandbox.stub(ContributionAccountingCategoryRule, 'getRulesForCollective').resolves(rules);
      const updateStub = sandbox.stub(order, 'update').resolves(order);

      await applyContributionAccountingCategoryRules(order);

      expect(getRulesStub).to.have.been.calledOnceWith(order.collective.HostCollectiveId);
      expect(updateStub).to.have.been.calledOnce;

      const [updateArgs] = updateStub.firstCall.args;
      expect(updateArgs.AccountingCategoryId).to.equal(accountingCategory.id);
      expect(updateArgs.data).to.exist;
    });
  });
});
