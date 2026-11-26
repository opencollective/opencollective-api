/* eslint-disable camelcase */
import { expect } from 'chai';
import moment from 'moment';
import { createSandbox, SinonStub } from 'sinon';

import { Service } from '../../../../server/constants/connected-account';
import { sessionCache } from '../../../../server/lib/cache';
import * as GoCardlessClient from '../../../../server/lib/gocardless/client';
import {
  connectGoCardlessAccount,
  createGoCardlessLink,
  getGoCardlessAuthorizationExpiresAt,
  getGoCardlessLinkSessionCacheKey,
  reconnectGoCardlessAccount,
} from '../../../../server/lib/gocardless/connect';
import { GoCardlessRequisitionStatus } from '../../../../server/lib/gocardless/types';
import { Collective, ConnectedAccount, User } from '../../../../server/models';
import {
  fakeActiveHost,
  fakeConnectedAccount,
  fakeTransactionsImport,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const institution = {
  id: 'BOURSORAMA_BOUSFRPP',
  max_access_valid_for_days: '180',
  transaction_total_days: '90',
  name: 'Boursorama',
};

const requisition = {
  id: '317b7c95-xxxx-xxxx-xxxx-4233xxxxxxxx',
  status: GoCardlessRequisitionStatus.LN,
  institution_id: 'BOURSORAMA_BOUSFRPP',
  created: '2025-07-10T14:11:27.521655Z',
  accounts: ['28ccfcf2-xxxx-xxxx-xxxx-4a27xxxxxxxx'],
};

const accountsMetadata = [
  {
    id: '28ccfcf2-xxxx-xxxx-xxxx-4a27xxxxxxxx',
    iban: 'FR76300010079412345678xxxxxxxx',
    name: 'Test Account',
    institution_id: 'BOURSORAMA_BOUSFRPP',
  },
];

describe('server/lib/gocardless/connect', () => {
  const sandbox = createSandbox();

  /**
   * Simulates `createGoCardlessLink` having been called by `remoteUser` for `host`: the requisition
   * is bound to its initiator in the session cache.
   */
  const recordLinkSession = (requisitionId: string, remoteUser: User, host: Collective) =>
    sessionCache.set(
      getGoCardlessLinkSessionCacheKey(requisitionId),
      { CollectiveId: host.id, UserId: remoteUser.id },
      3600,
    );

  beforeEach(async () => {
    await resetTestDB();
    // Redis is not reset by `resetTestDB`, make sure no link session leaks between tests
    await sessionCache.delete(getGoCardlessLinkSessionCacheKey(requisition.id));
    await sessionCache.delete(getGoCardlessLinkSessionCacheKey('new-requisition-id'));
    sandbox.stub(GoCardlessClient, 'getGoCardlessClient').returns({
      agreement: {
        createAgreement: sandbox.stub().resolves({ id: 'agreement-id' }),
      },
      requisition: {
        createRequisition: sandbox.stub().resolves(requisition),
        getRequisitionById: sandbox.stub().resolves(requisition),
      },
      institution: {
        getInstitutionById: sandbox.stub().resolves(institution),
      },
      account: sandbox.stub().callsFake(() => ({
        getMetadata: sandbox.stub().resolves(accountsMetadata[0]),
      })),
    } as never);
    sandbox.stub(GoCardlessClient, 'getOrRefreshGoCardlessToken').resolves();
  });

  afterEach(() => sandbox.restore());

  describe('getGoCardlessAuthorizationExpiresAt', () => {
    it('returns requisition created date plus max_access_valid_for_days', () => {
      const expiresAt = getGoCardlessAuthorizationExpiresAt({ institution, requisition });

      expect(expiresAt).to.not.be.null;
      expect(expiresAt).to.deep.equal(moment('2025-07-10T14:11:27.521655Z').add(180, 'days').toDate());
    });

    it('returns null when max_access_valid_for_days is missing', () => {
      expect(
        getGoCardlessAuthorizationExpiresAt({
          institution: {} as { max_access_valid_for_days?: string },
          requisition,
        }),
      ).to.be.null;
    });

    it('returns null when requisition created date is missing', () => {
      expect(
        getGoCardlessAuthorizationExpiresAt({
          institution,
          requisition: {} as { created?: string },
        }),
      ).to.be.null;
    });

    it('returns null when max_access_valid_for_days is invalid', () => {
      expect(
        getGoCardlessAuthorizationExpiresAt({
          institution: { max_access_valid_for_days: 'invalid' },
          requisition,
        }),
      ).to.be.null;
    });

    it('returns null when requisition created date is invalid', () => {
      expect(
        getGoCardlessAuthorizationExpiresAt({
          institution,
          requisition: { created: 'not-a-date' },
        }),
      ).to.be.null;
    });
  });

  describe('createGoCardlessLink', () => {
    it('binds the requisition to the initiating user and host', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });

      const link = await createGoCardlessLink(remoteUser, host, institution.id, {
        maxHistoricalDays: 90,
        accessValidForDays: 180,
        userLanguage: 'en',
        accountSelection: false,
      });

      expect(link.id).to.equal(requisition.id);
      expect(await sessionCache.get(getGoCardlessLinkSessionCacheKey(link.id))).to.deep.equal({
        CollectiveId: host.id,
        UserId: remoteUser.id,
      });
    });
  });

  describe('connectGoCardlessAccount', () => {
    it('sets authorizationExpiresAt when connecting for the first time', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      await recordLinkSession(requisition.id, remoteUser, host);

      const { connectedAccount } = await connectGoCardlessAccount(remoteUser, host, requisition.id);

      expect(connectedAccount.authorizationExpiresAt).to.not.be.null;
      expect(connectedAccount.authorizationExpiresAt).to.deep.equal(
        moment('2025-07-10T14:11:27.521655Z').add(180, 'days').toDate(),
      );
    });

    it('rejects a requisition that was initiated by an admin of another host', async () => {
      const victimAdmin = await fakeUser();
      const victimHost = await fakeActiveHost({ admin: victimAdmin });
      await recordLinkSession(requisition.id, victimAdmin, victimHost);

      // The attacker is a legitimate admin of their own host, but did not initiate this requisition
      const attackerAdmin = await fakeUser();
      const attackerHost = await fakeActiveHost({ admin: attackerAdmin });

      await expect(connectGoCardlessAccount(attackerAdmin, attackerHost, requisition.id)).to.be.rejectedWith(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );

      expect(await ConnectedAccount.count()).to.equal(0);

      // The legitimate initiator must still be able to connect
      const { connectedAccount } = await connectGoCardlessAccount(victimAdmin, victimHost, requisition.id);
      expect(connectedAccount.CollectiveId).to.equal(victimHost.id);
      expect(connectedAccount.CreatedByUserId).to.equal(victimAdmin.id);
    });

    it('rejects a requisition that was initiated by another admin of the same host', async () => {
      const initiator = await fakeUser();
      const host = await fakeActiveHost({ admin: initiator });
      const otherAdmin = await fakeUser();
      await host.addUserWithRole(otherAdmin, 'ADMIN');
      await recordLinkSession(requisition.id, initiator, host);

      await expect(connectGoCardlessAccount(otherAdmin, host, requisition.id)).to.be.rejectedWith(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );
      expect(await ConnectedAccount.count()).to.equal(0);
    });

    it('fails closed when the link session is missing (expired, evicted or created before this check)', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });

      // No session recorded for this requisition
      await expect(connectGoCardlessAccount(remoteUser, host, requisition.id)).to.be.rejectedWith(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );
      expect(await ConnectedAccount.count()).to.equal(0);
    });

    it('consumes the link session once the account is connected', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      await recordLinkSession(requisition.id, remoteUser, host);

      await connectGoCardlessAccount(remoteUser, host, requisition.id);

      expect(await sessionCache.get(getGoCardlessLinkSessionCacheKey(requisition.id))).to.not.exist;
    });
  });

  describe('reconnectGoCardlessAccount', () => {
    it('updates authorizationExpiresAt when reconnecting', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const connectedAccount = await fakeConnectedAccount({
        CollectiveId: host.id,
        service: Service.GOCARDLESS,
        clientId: 'old-requisition-id',
        authorizationExpiresAt: moment('2025-01-01').toDate(),
        data: {
          gocardless: {
            institution,
            requisition: { ...requisition, id: 'old-requisition-id' },
            accountsMetadata,
          },
        },
      });
      const transactionsImport = await fakeTransactionsImport({
        CollectiveId: host.id,
        ConnectedAccountId: connectedAccount.id,
        type: 'GOCARDLESS',
        data: connectedAccount.data as Record<string, unknown>,
      });

      const newRequisition = {
        ...requisition,
        id: 'new-requisition-id',
        created: '2026-06-01T10:00:00.000Z',
      };
      const client = GoCardlessClient.getGoCardlessClient() as {
        requisition: { getRequisitionById: SinonStub };
      };
      client.requisition.getRequisitionById.resolves(newRequisition);
      await recordLinkSession(newRequisition.id, remoteUser, host);

      const { connectedAccount: updatedConnectedAccount } = await reconnectGoCardlessAccount(
        remoteUser,
        connectedAccount,
        transactionsImport,
        newRequisition.id,
      );

      expect(updatedConnectedAccount.authorizationExpiresAt).to.deep.equal(
        moment('2026-06-01T10:00:00.000Z').add(180, 'days').toDate(),
      );
    });

    it('nullifies authorizationExpiresAt when it cannot be recomputed', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const connectedAccount = await fakeConnectedAccount({
        CollectiveId: host.id,
        service: Service.GOCARDLESS,
        clientId: 'old-requisition-id',
        authorizationExpiresAt: moment('2025-01-01').toDate(),
        data: {
          gocardless: {
            institution: { id: 'BOURSORAMA_BOUSFRPP', name: 'Boursorama' },
            requisition: { ...requisition, id: 'old-requisition-id' },
            accountsMetadata,
          },
        },
      });
      const transactionsImport = await fakeTransactionsImport({
        CollectiveId: host.id,
        ConnectedAccountId: connectedAccount.id,
        type: 'GOCARDLESS',
        data: connectedAccount.data as Record<string, unknown>,
      });

      const newRequisition = {
        ...requisition,
        id: 'new-requisition-id',
        created: '2026-06-01T10:00:00.000Z',
      };
      const client = GoCardlessClient.getGoCardlessClient() as {
        requisition: { getRequisitionById: SinonStub };
      };
      client.requisition.getRequisitionById.resolves(newRequisition);
      await recordLinkSession(newRequisition.id, remoteUser, host);

      const { connectedAccount: updatedConnectedAccount } = await reconnectGoCardlessAccount(
        remoteUser,
        connectedAccount,
        transactionsImport,
        newRequisition.id,
      );

      expect(updatedConnectedAccount.authorizationExpiresAt).to.be.null;
    });

    it('rejects a requisition that was initiated for another host', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const connectedAccount = await fakeConnectedAccount({
        CollectiveId: host.id,
        service: Service.GOCARDLESS,
        clientId: 'old-requisition-id',
        data: {
          gocardless: {
            institution,
            requisition: { ...requisition, id: 'old-requisition-id' },
            accountsMetadata,
          },
        },
      });
      const transactionsImport = await fakeTransactionsImport({
        CollectiveId: host.id,
        ConnectedAccountId: connectedAccount.id,
        type: 'GOCARDLESS',
        data: connectedAccount.data as Record<string, unknown>,
      });

      const newRequisition = { ...requisition, id: 'new-requisition-id', created: '2026-06-01T10:00:00.000Z' };
      const client = GoCardlessClient.getGoCardlessClient() as {
        requisition: { getRequisitionById: SinonStub };
      };
      client.requisition.getRequisitionById.resolves(newRequisition);

      // The requisition was initiated by somebody else, for another host
      const otherAdmin = await fakeUser();
      const otherHost = await fakeActiveHost({ admin: otherAdmin });
      await recordLinkSession(newRequisition.id, otherAdmin, otherHost);

      await expect(
        reconnectGoCardlessAccount(remoteUser, connectedAccount, transactionsImport, newRequisition.id),
      ).to.be.rejectedWith(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );

      await connectedAccount.reload();
      expect(connectedAccount.data.gocardless.requisition.id).to.equal('old-requisition-id');
    });
  });
});
