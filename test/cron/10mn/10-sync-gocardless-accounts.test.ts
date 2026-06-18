import { expect } from 'chai';
import moment from 'moment';

import { getGoCardlessImportsToSync } from '../../../cron/10mn/10-sync-gocardless-accounts';
import { fakeCollective, fakeConnectedAccount, fakeTransactionsImport } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/10mn/10-sync-gocardless-accounts', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  const createGoCardlessImport = async (
    authorizationExpiresAt: Date | null,
    { lastSyncAt = null }: { lastSyncAt?: Date | null } = {},
  ) => {
    const collective = await fakeCollective();
    const connectedAccount = await fakeConnectedAccount({
      CollectiveId: collective.id,
      service: 'gocardless',
      authorizationExpiresAt,
    });

    return fakeTransactionsImport({
      type: 'GOCARDLESS',
      CollectiveId: collective.id,
      ConnectedAccountId: connectedAccount.id,
      lastSyncAt,
      data: {},
    });
  };

  describe('getGoCardlessImportsToSync', () => {
    it('includes imports with a non-expired authorization', async () => {
      const now = new Date('2026-06-16T12:00:00.000Z');
      const activeImport = await createGoCardlessImport(moment(now).add(30, 'days').toDate());
      const legacyImport = await createGoCardlessImport(null);

      const importsToSync = await getGoCardlessImportsToSync(now);
      const importIds = importsToSync.map(importInstance => importInstance.id);

      expect(importIds).to.have.members([activeImport.id, legacyImport.id]);
    });

    it('excludes imports with an expired authorization', async () => {
      const now = new Date('2026-06-16T12:00:00.000Z');
      const activeImport = await createGoCardlessImport(moment(now).add(1, 'day').toDate());
      const expiredImport = await createGoCardlessImport(moment(now).subtract(1, 'day').toDate());

      const importsToSync = await getGoCardlessImportsToSync(now);
      const importIds = importsToSync.map(importInstance => importInstance.id);

      expect(importIds).to.deep.equal([activeImport.id]);
      expect(importIds).to.not.include(expiredImport.id);
    });

    it('excludes imports synced within the last 60 minutes', async () => {
      const now = new Date('2026-06-16T12:00:00.000Z');
      const recentlySyncedImport = await createGoCardlessImport(moment(now).add(30, 'days').toDate(), {
        lastSyncAt: moment(now).subtract(30, 'minutes').toDate(),
      });

      const importsToSync = await getGoCardlessImportsToSync(now);
      const importIds = importsToSync.map(importInstance => importInstance.id);

      expect(importIds).to.not.include(recentlySyncedImport.id);
    });

    it('includes imports last synced more than 60 minutes ago', async () => {
      const now = new Date('2026-06-16T12:00:00.000Z');
      const staleImport = await createGoCardlessImport(moment(now).add(30, 'days').toDate(), {
        lastSyncAt: moment(now).subtract(61, 'minutes').toDate(),
      });

      const importsToSync = await getGoCardlessImportsToSync(now);
      const importIds = importsToSync.map(importInstance => importInstance.id);

      expect(importIds).to.deep.equal([staleImport.id]);
    });
  });
});
