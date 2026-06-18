/* eslint-disable camelcase */
import { expect } from 'chai';
import moment from 'moment';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260617120000-backfill-gocardless-authorization-expires-at'; // eslint-disable-line import/default
import { sequelize } from '../../server/models';
import { fakeConnectedAccount } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('migrations/20260617120000-backfill-gocardless-authorization-expires-at', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('up', () => {
    it('backfills authorizationExpiresAt for GoCardless connected accounts', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'gocardless',
        authorizationExpiresAt: null,
        data: {
          gocardless: {
            institution: {
              id: 'BOURSORAMA_BOUSFRPP',
              max_access_valid_for_days: '180',
            },
            requisition: {
              id: 'req-1',
              created: '2025-07-10T14:11:27.521655Z',
            },
          },
        },
      });

      await migration.up(sequelize.getQueryInterface());

      await connectedAccount.reload();
      expect(connectedAccount.authorizationExpiresAt).to.deep.equal(
        moment('2025-07-10T14:11:27.521655Z').add(180, 'days').toDate(),
      );
    });

    it('leaves authorizationExpiresAt null when it cannot be computed', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'gocardless',
        authorizationExpiresAt: null,
        data: {
          gocardless: {
            institution: { id: 'BOURSORAMA_BOUSFRPP' },
            requisition: { id: 'req-1', created: '2025-07-10T14:11:27.521655Z' },
          },
        },
      });

      await migration.up(sequelize.getQueryInterface());

      await connectedAccount.reload();
      expect(connectedAccount.authorizationExpiresAt).to.be.null;
    });

    it('does not update non-GoCardless connected accounts', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'stripe',
        authorizationExpiresAt: null,
      });

      await migration.up(sequelize.getQueryInterface());

      await connectedAccount.reload();
      expect(connectedAccount.authorizationExpiresAt).to.be.null;
    });
  });

  describe('down', () => {
    it('nullifies authorizationExpiresAt for GoCardless connected accounts', async () => {
      const connectedAccount = await fakeConnectedAccount({
        service: 'gocardless',
        authorizationExpiresAt: moment('2026-01-01').toDate(),
        data: {
          gocardless: {
            institution: {
              id: 'BOURSORAMA_BOUSFRPP',
              max_access_valid_for_days: '180',
            },
            requisition: {
              id: 'req-1',
              created: '2025-07-10T14:11:27.521655Z',
            },
          },
        },
      });

      await migration.down(sequelize.getQueryInterface());

      await connectedAccount.reload();
      expect(connectedAccount.authorizationExpiresAt).to.be.null;
    });
  });
});
