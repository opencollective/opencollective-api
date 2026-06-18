/* eslint-disable camelcase */
import { expect } from 'chai';
import moment from 'moment';
import { createSandbox, SinonStub } from 'sinon';

import { Service } from '../../../../server/constants/connected-account';
import * as GoCardlessClient from '../../../../server/lib/gocardless/client';
import {
  connectGoCardlessAccount,
  getGoCardlessAuthorizationExpiresAt,
  reconnectGoCardlessAccount,
} from '../../../../server/lib/gocardless/connect';
import { GoCardlessRequisitionStatus } from '../../../../server/lib/gocardless/types';
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

  beforeEach(async () => {
    await resetTestDB();
    sandbox.stub(GoCardlessClient, 'getGoCardlessClient').returns({
      requisition: {
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

  describe('connectGoCardlessAccount', () => {
    it('sets authorizationExpiresAt when connecting for the first time', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });

      const { connectedAccount } = await connectGoCardlessAccount(remoteUser, host, requisition.id);

      expect(connectedAccount.authorizationExpiresAt).to.not.be.null;
      expect(connectedAccount.authorizationExpiresAt).to.deep.equal(
        moment('2025-07-10T14:11:27.521655Z').add(180, 'days').toDate(),
      );
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

      const { connectedAccount: updatedConnectedAccount } = await reconnectGoCardlessAccount(
        remoteUser,
        connectedAccount,
        transactionsImport,
        newRequisition.id,
      );

      expect(updatedConnectedAccount.authorizationExpiresAt).to.be.null;
    });
  });
});
