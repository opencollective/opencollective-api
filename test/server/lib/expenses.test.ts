import { expect } from 'chai';

import FEATURE from '../../../server/constants/feature';
import { getSupportedExpenseTypes } from '../../../server/lib/expenses';
import { fakeActiveHost, fakeCollective, fakeProject } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/expenses', () => {
  before(resetTestDB);

  describe('getSupportedExpenseTypes', () => {
    it('returns default expense types (INVOICE, RECEIPT) when no settings are configured', async () => {
      const collective = await fakeCollective();
      const result = await getSupportedExpenseTypes(collective);
      expect(result).to.deep.equal(['INVOICE', 'RECEIPT']);
    });

    it('aggregates expense types from host, parent, and collective with correct priority (collective > parent > host)', async () => {
      const host = await fakeActiveHost({
        plan: 'start-plan-2021',
        settings: {
          expenseTypes: {
            GRANT: true,
            RECEIPT: true,
            INVOICE: true,
          },
        },
      });
      const parent = await fakeCollective({
        HostCollectiveId: host.id,
        settings: {
          expenseTypes: {
            GRANT: false,
            RECEIPT: false,
          },
        },
      });
      const project = await fakeProject({
        ParentCollectiveId: parent.id,
        HostCollectiveId: host.id,
        settings: {
          expenseTypes: {
            GRANT: false,
            RECEIPT: true,
          },
        },
      });

      const hostResult = await getSupportedExpenseTypes(host);
      expect(hostResult).to.deep.equal(['GRANT', 'INVOICE', 'RECEIPT']);

      const parentResult = await getSupportedExpenseTypes(parent);
      expect(parentResult).to.deep.equal(['INVOICE']);

      const projectResult = await getSupportedExpenseTypes(project);
      expect(projectResult).to.deep.equal(['INVOICE', 'RECEIPT']);
    });

    it('filters out GRANT when host does not have FUNDS_GRANTS_MANAGEMENT feature', async () => {
      const host = await fakeActiveHost({
        data: { features: { [FEATURE.FUNDS_GRANTS_MANAGEMENT]: false } },
        settings: {
          expenseTypes: {
            GRANT: true,
            INVOICE: true,
            RECEIPT: true,
          },
        },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });

      const result = await getSupportedExpenseTypes(collective);
      expect(result).to.deep.equal(['INVOICE', 'RECEIPT']);
    });

    it('includes GRANT when host has FUNDS_GRANTS_MANAGEMENT feature', async () => {
      const host = await fakeActiveHost({
        plan: 'start-plan-2021',
        settings: {
          expenseTypes: {
            GRANT: true,
            INVOICE: true,
            RECEIPT: true,
          },
        },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });

      const result = await getSupportedExpenseTypes(collective);
      expect(result).to.deep.equal(['GRANT', 'INVOICE', 'RECEIPT']);
    });

    it('allows collective to disable expense types set by host', async () => {
      const host = await fakeActiveHost({
        plan: 'start-plan-2021',
        settings: {
          expenseTypes: {
            INVOICE: true,
            RECEIPT: true,
          },
        },
      });
      const collective = await fakeCollective({
        HostCollectiveId: host.id,
        settings: {
          expenseTypes: {
            INVOICE: false,
            RECEIPT: true,
          },
        },
      });

      const result = await getSupportedExpenseTypes(collective);
      expect(result).to.deep.equal(['RECEIPT']);
    });

    it('works without loaders (fetches from database)', async () => {
      const collective = await fakeCollective({
        settings: {
          expenseTypes: {
            INVOICE: true,
            RECEIPT: false,
          },
        },
      });

      const result = await getSupportedExpenseTypes(collective, { loaders: undefined });
      expect(result).to.deep.equal(['INVOICE']);
    });
  });
});
