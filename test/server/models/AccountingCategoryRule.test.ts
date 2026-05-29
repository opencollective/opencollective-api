import { expect } from 'chai';

import {
  ContributionAccountingCategoryRuleOperator,
  ContributionAccountingCategoryRuleSubject,
} from '../../../server/lib/accounting/categorization/types';
import models from '../../../server/models';
import { fakeAccountingCategory, fakeActiveHost, fakeCollective } from '../../test-helpers/fake-data';

describe('server/models/AccountingCategoryRule', () => {
  it('validates and normalizes predicates on create', async () => {
    const host = await fakeActiveHost();
    const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id });
    const account = await fakeCollective();

    const rule = await models.AccountingCategoryRule.create({
      CollectiveId: host.id,
      AccountingCategoryId: accountingCategory.id,
      type: 'CONTRIBUTION',
      name: 'Valid normalized rule',
      enabled: true,
      order: 0,
      predicates: [
        {
          subject: ContributionAccountingCategoryRuleSubject.toAccount,
          operator: ContributionAccountingCategoryRuleOperator.eq,
          value: account.slug,
        },
      ],
    });

    expect(rule.predicates).to.deep.equal([
      {
        subject: 'toAccount',
        operator: 'eq',
        value: account.slug,
      },
    ]);
  });

  it('rejects invalid predicates', async () => {
    const host = await fakeActiveHost();
    const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id });

    await expect(
      models.AccountingCategoryRule.create({
        CollectiveId: host.id,
        AccountingCategoryId: accountingCategory.id,
        type: 'CONTRIBUTION',
        name: 'Invalid rule',
        enabled: true,
        order: 0,
        predicates: [
          {
            subject: ContributionAccountingCategoryRuleSubject.description,
            operator: ContributionAccountingCategoryRuleOperator.eq,
            value: 'invalid operator',
          },
        ],
      }),
    ).to.be.rejectedWith('Invalid operator: eq');
  });

  it('rejects predicates when value is not an array', async () => {
    const host = await fakeActiveHost();
    const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id });

    await expect(
      models.AccountingCategoryRule.create({
        CollectiveId: host.id,
        AccountingCategoryId: accountingCategory.id,
        type: 'CONTRIBUTION',
        name: 'Invalid predicates shape',
        enabled: true,
        order: 0,
        predicates: {} as unknown as [],
      }),
    ).to.be.rejectedWith('Predicates must be an array');
  });
});
