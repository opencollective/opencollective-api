import { expect } from 'chai';
import express from 'express';
import sinon from 'sinon';
import request from 'supertest';

import { Service } from '../../../../../server/constants/connected-account';
import { FEATURE } from '../../../../../server/lib/allowed-features';
import { crypto } from '../../../../../server/lib/encryption';
import setupExpress from '../../../../../server/lib/express';
import { KYCProviderName } from '../../../../../server/lib/kyc/providers';
import { personaKycProvider } from '../../../../../server/lib/kyc/providers/persona';
import { PersonaClient, PersonaInquiry } from '../../../../../server/lib/kyc/providers/persona/client';
import { Collective, ConnectedAccount } from '../../../../../server/models';
import { KYCVerificationStatus } from '../../../../../server/models/KYCVerification';
import { fakeActiveHost, fakeKYCVerification, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

async function setupOrg() {
  return await fakeActiveHost({
    data: {
      isFirstPartyHost: true,
      features: { [FEATURE.PERSONA_KYC]: true },
    },
  });
}

async function setupPersonaAccount(org: Collective): Promise<ConnectedAccount> {
  return await ConnectedAccount.create({
    CollectiveId: org.id,
    service: Service.PERSONA,
    token: randStr('persona-token-'),
    clientId: randStr('persona-client-id-'),
    CreatedByUserId: org.CreatedByUserId,
    data: {
      webhook: {
        secret: crypto.encrypt(randStr('persona-webhook-secret-')),
      },
    },
  });
}

const fakeInquiry = {
  type: 'inquiry',
  id: 'inquiry-id',
  attributes: {
    status: 'completed',
    fields: {
      // eslint-disable-next-line camelcase
      name_first: {
        type: 'string',
        value: 'Homer',
      },
      // eslint-disable-next-line camelcase
      name_last: {
        type: 'string',
        value: 'Simpson',
      },
      // eslint-disable-next-line camelcase
      name_middle: {
        type: 'string',
        value: 'Jay',
      },
      // eslint-disable-next-line camelcase
      address_street_1: {
        type: 'string',
        value: '742 Evergreen Terrace',
      },
      // eslint-disable-next-line camelcase
      address_city: {
        type: 'string',
        value: 'Springfield',
      },
    },
  },
};

describe('server/lib/kyc/persona', () => {
  let sandbox: sinon.SinonSandbox;
  describe('request', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(PersonaClient.prototype, 'apiRequest').callsFake((method, path) => {
        return Promise.reject(new Error(`Unexpected API call in test: ${method} ${path}`));
      });
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('throws if account does not have PERSONA_KYC feature', async () => {
      const org = await fakeActiveHost();
      const user = await fakeUser();
      await fakeKYCVerification({
        provider: KYCProviderName.PERSONA,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      await expect(
        personaKycProvider.request(
          {
            CollectiveId: user.collective.id,
            RequestedByCollectiveId: org.id,
            CreatedByUserId: user.id,
            UserTokenId: null,
          },
          {
            importInquiryId: 'inquiry-id',
          },
        ),
      ).to.eventually.be.rejectedWith('This feature is not supported for your account');
    });

    it('throws if persona account is not setup', async () => {
      const org = await setupOrg();
      const user = await fakeUser();
      await fakeKYCVerification({
        provider: KYCProviderName.PERSONA,
        CollectiveId: user.collective.id,
        RequestedByCollectiveId: org.id,
        status: KYCVerificationStatus.VERIFIED,
      });

      await expect(
        personaKycProvider.request(
          {
            CollectiveId: user.collective.id,
            RequestedByCollectiveId: org.id,
            CreatedByUserId: user.id,
            UserTokenId: null,
          },
          {
            importInquiryId: 'inquiry-id',
          },
        ),
      ).to.eventually.be.rejectedWith('Persona connected account not found');
    });

    describe('import inquiry', () => {
      it('throws if inquiry not found', async () => {
        sandbox.stub(PersonaClient.prototype, 'retrieveInquiry').rejects(new Error('Inquiry not found'));

        const org = await setupOrg();
        await setupPersonaAccount(org);
        const user = await fakeUser();
        await expect(
          personaKycProvider.request(
            {
              CollectiveId: user.collective.id,
              RequestedByCollectiveId: org.id,
              CreatedByUserId: user.id,
              UserTokenId: null,
            },
            {
              importInquiryId: 'inquiry-id',
            },
          ),
        ).to.eventually.be.rejectedWith('Inquiry not found');
      });

      it('imports inquiry if it exists', async () => {
        sandbox.stub(PersonaClient.prototype, 'retrieveInquiry').resolves({ data: fakeInquiry });

        const org = await setupOrg();
        await setupPersonaAccount(org);
        const user = await fakeUser();
        const verification = await personaKycProvider.request(
          {
            CollectiveId: user.collective.id,
            RequestedByCollectiveId: org.id,
            CreatedByUserId: user.id,
            UserTokenId: null,
          },
          {
            importInquiryId: 'inquiry-id',
          },
        );

        expect(verification.providerData.inquiry.id).to.equal('inquiry-id');
        expect(verification.status).to.equal(KYCVerificationStatus.PENDING);
        expect(verification.data.legalName).to.equal('Homer Jay Simpson');
        expect(verification.data.legalAddress).to.equal('742 Evergreen Terrace');
      });

      it('updates existing verification if it exists', async () => {
        const newInquiry = {
          ...fakeInquiry,
          attributes: {
            ...fakeInquiry.attributes,
            status: 'approved',
          },
        };
        sandbox.stub(PersonaClient.prototype, 'retrieveInquiry').resolves({ data: newInquiry });

        const org = await setupOrg();
        await setupPersonaAccount(org);
        const user = await fakeUser();

        await fakeKYCVerification({
          provider: KYCProviderName.PERSONA,
          CollectiveId: user.collective.id,
          RequestedByCollectiveId: org.id,
          status: KYCVerificationStatus.PENDING,
          providerData: {
            inquiry: fakeInquiry as Partial<PersonaInquiry>,
          },
        });

        const verification = await personaKycProvider.request(
          {
            CollectiveId: user.collective.id,
            RequestedByCollectiveId: org.id,
            CreatedByUserId: user.id,
            UserTokenId: null,
          },
          {
            importInquiryId: 'inquiry-id',
          },
        );

        expect(verification.providerData.inquiry.id).to.equal('inquiry-id');
        expect(verification.status).to.equal(KYCVerificationStatus.VERIFIED);
      });
    });
  });

  describe('provisionProvider', () => {
    it('throws if org does not have PERSONA_KYC feature', async () => {
      const org = await fakeActiveHost();
      await expect(
        personaKycProvider.provisionProvider({
          CollectiveId: org.id,
          CreatedByUserId: org.CreatedByUserId,
          apiKey: 'valid-api-key',
          apiKeyId: 'valid-api-key-id',
          inquiryTemplateId: 'inquiry-template-id',
        }),
      ).to.eventually.be.rejectedWith('This feature is not supported for your account');
    });

    it('throws if api key is invalid', async () => {
      sandbox.stub(PersonaClient.prototype, 'apiRequest').rejects(new Error('Invalid API key'));

      const org = await setupOrg();
      await expect(
        personaKycProvider.provisionProvider({
          CollectiveId: org.id,
          CreatedByUserId: org.CreatedByUserId,
          apiKey: 'invalid-api-key',
          apiKeyId: 'invalid-api-key-id',
          inquiryTemplateId: 'inquiry-template-id',
        }),
      ).to.eventually.be.rejectedWith('Invalid API key');
    });

    it("provisions new persona account if it doesn't exist", async () => {
      sandbox.stub(PersonaClient.prototype, 'listWebhooks').resolves({ data: [] });
      sandbox
        .stub(PersonaClient.prototype, 'createWebhook')
        .resolves({ data: { id: 'webhook-id', attributes: { secret: 'webhook-secret' } } });
      sandbox
        .stub(PersonaClient.prototype, 'enableWebhook')
        .resolves({ data: { id: 'webhook-id', attributes: { secret: 'webhook-secret' } } });

      const org = await setupOrg();
      await expect(
        personaKycProvider.provisionProvider({
          CollectiveId: org.id,
          CreatedByUserId: org.CreatedByUserId,
          apiKey: 'valid-api-key',
          apiKeyId: 'valid-api-key-id',
          inquiryTemplateId: 'inquiry-template-id',
        }),
      ).to.eventually.be.fulfilled;

      const connectedAccount = await ConnectedAccount.findOne({
        where: {
          CollectiveId: org.id,
          service: Service.PERSONA,
        },
      });
      expect(connectedAccount).to.exist;
    });
  });

  describe('webhooks', () => {
    beforeEach(async () => {
      sandbox.stub(PersonaClient.prototype, 'validateWebhook').resolves();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns 404 if connected account not found', async () => {
      const app = express();
      setupExpress(app);
      app.use(personaKycProvider.webhookRoutes);

      const response = await request(app)
        .post(`/1234567890`)
        .send({
          data: {
            type: 'event',
            id: 'event-id',
            attributes: {
              name: 'inquiry.approved',
              payload: { data: { ...fakeInquiry, attributes: { ...fakeInquiry.attributes, status: 'approved' } } },
            },
          },
        });
      expect(response.status).to.equal(404);
    });

    describe('inquiry.approved', () => {
      it('updates verification status to verified', async () => {
        const org = await setupOrg();
        const connectedAccount = await setupPersonaAccount(org);
        const user = await fakeUser();
        const verification = await fakeKYCVerification({
          provider: KYCProviderName.PERSONA,
          CollectiveId: user.collective.id,
          RequestedByCollectiveId: org.id,
          status: KYCVerificationStatus.PENDING,
          providerData: {
            inquiry: fakeInquiry as Partial<PersonaInquiry>,
          },
        });

        const app = express();
        setupExpress(app);
        app.use(personaKycProvider.webhookRoutes);

        const response = await request(app)
          .post(`/${connectedAccount.id}`)
          .send({
            data: {
              type: 'event',
              id: 'event-id',
              attributes: {
                name: 'inquiry.approved',
                payload: { data: { ...fakeInquiry, attributes: { ...fakeInquiry.attributes, status: 'approved' } } },
              },
            },
          });
        expect(response.status).to.equal(200);
        await verification.reload();
        expect(verification.status).to.equal(KYCVerificationStatus.VERIFIED);
      });
    });

    describe('inquiry.declined', () => {
      it('updates verification status to failed when declined', async () => {
        const org = await setupOrg();
        const connectedAccount = await setupPersonaAccount(org);
        const user = await fakeUser();
        const verification = await fakeKYCVerification({
          provider: KYCProviderName.PERSONA,
          CollectiveId: user.collective.id,
          RequestedByCollectiveId: org.id,
          status: KYCVerificationStatus.PENDING,
          providerData: {
            inquiry: fakeInquiry as Partial<PersonaInquiry>,
          },
        });

        const app = express();
        setupExpress(app);
        app.use(personaKycProvider.webhookRoutes);

        const response = await request(app)
          .post(`/${connectedAccount.id}`)
          .send({
            data: {
              type: 'event',
              id: 'event-id',
              attributes: {
                name: 'inquiry.declined',
                payload: {
                  data: {
                    ...fakeInquiry,
                    attributes: { ...fakeInquiry.attributes, status: 'declined' },
                  },
                },
              },
            },
          });
        expect(response.status).to.equal(200);
        await verification.reload();
        expect(verification.status).to.equal(KYCVerificationStatus.FAILED);
      });
    });

    describe('inquiry.expired', () => {
      it('updates verification status to expired when expired', async () => {
        const org = await setupOrg();
        const connectedAccount = await setupPersonaAccount(org);
        const user = await fakeUser();
        const verification = await fakeKYCVerification({
          provider: KYCProviderName.PERSONA,
          CollectiveId: user.collective.id,
          RequestedByCollectiveId: org.id,
          status: KYCVerificationStatus.PENDING,
          providerData: {
            inquiry: fakeInquiry as Partial<PersonaInquiry>,
          },
        });

        const app = express();
        setupExpress(app);
        app.use(personaKycProvider.webhookRoutes);

        const response = await request(app)
          .post(`/${connectedAccount.id}`)
          .send({
            data: {
              type: 'event',
              id: 'event-id',
              attributes: {
                name: 'inquiry.expired',
                payload: {
                  data: {
                    ...fakeInquiry,
                    attributes: { ...fakeInquiry.attributes, status: 'expired' },
                  },
                },
              },
            },
          });
        expect(response.status).to.equal(200);
        await verification.reload();
        expect(verification.status).to.equal(KYCVerificationStatus.EXPIRED);
      });
    });

    describe('inquiry.failed', () => {
      it('updates verification status to failed when failed', async () => {
        const org = await setupOrg();
        const connectedAccount = await setupPersonaAccount(org);
        const user = await fakeUser();
        const verification = await fakeKYCVerification({
          provider: KYCProviderName.PERSONA,
          CollectiveId: user.collective.id,
          RequestedByCollectiveId: org.id,
          status: KYCVerificationStatus.PENDING,
          providerData: {
            inquiry: fakeInquiry as Partial<PersonaInquiry>,
          },
        });

        const app = express();
        setupExpress(app);
        app.use(personaKycProvider.webhookRoutes);

        const response = await request(app)
          .post(`/${connectedAccount.id}`)
          .send({
            data: {
              type: 'event',
              id: 'event-id',
              attributes: {
                name: 'inquiry.failed',
                payload: {
                  data: {
                    ...fakeInquiry,
                    attributes: { ...fakeInquiry.attributes, status: 'failed' },
                  },
                },
              },
            },
          });
        expect(response.status).to.equal(200);
        await verification.reload();
        expect(verification.status).to.equal(KYCVerificationStatus.FAILED);
      });
    });
  });
});
