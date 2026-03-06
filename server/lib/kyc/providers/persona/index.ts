import config from 'config';
import express from 'express';
import { pick } from 'lodash';

import { Collective, ConnectedAccount, Op } from '../../../../models';
import { KYCVerification, KYCVerificationStatus, KYCVerifiedData } from '../../../../models/KYCVerification';
import { checkFeatureAccess, FEATURE } from '../../../allowed-features';
import { crypto } from '../../../encryption';
import logger from '../../../logger';
import { KYCProvider, KYCRequest } from '../base';
import { KYCProviderName } from '..';

import { PersonaClient, PersonaEvent, PersonaInquiry, PersonaWebhookEvent, PersonaWebhookWithSecret } from './client';

const REQUIRED_WEBHOOK_EVENTS: PersonaEvent[] = [
  PersonaEvent.INQUIRY_APPROVED,
  PersonaEvent.INQUIRY_DECLINED,
  PersonaEvent.INQUIRY_CREATED,
  PersonaEvent.INQUIRY_EXPIRED,
  PersonaEvent.INQUIRY_FAILED,
];

type PersonaKYCRequest = {
  importInquiryId?: string;
};

type PersonaKYCVerification = KYCVerification<KYCProviderName.PERSONA>;

class PersonaKYCProvider extends KYCProvider<PersonaKYCRequest, PersonaKYCVerification> {
  private router: express.Router;
  constructor() {
    super(KYCProviderName.PERSONA);
    this.router = express.Router();
    this.router.post(
      '/:connectedAccountID',
      this.resolveWebhookConnectedAccount.bind(this),
      this.validateWebhook.bind(this),
      this.handleWebhook.bind(this),
    );
  }

  get webhookRoutes() {
    return this.router;
  }

  private get webhookBaseUrl() {
    let baseUrl: string = config.host.webhooks || `${config.host.api}/webhooks`;
    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.substring(0, baseUrl.length - 1);
    }
    return `${baseUrl}/persona`;
  }

  private get shouldProvisionWebhook() {
    return true;
  }

  private sanitizeInquiry(inquiry: PersonaInquiry): Partial<PersonaInquiry> {
    const inquiryFields = [
      'id',
      'type',
      'attributes.status',
      'attributes.reference-id',
      'attributes.note',
      'attributes.tags',
      'attributes.creator',
      'attributes.reviewer-comment',
      'attributes.updated-at',
      'attributes.created-at',
      'attributes.started-at',
      'attributes.expires-at',
      'attributes.completed-at',
      'attributes.failed-at',
      'attributes.marked-for-review-at',
      'attributes.decisioned-at',
      'attributes.expired-at',
      'attributes.redacted-at',
      'attributes.behaviors',
    ];

    return pick(inquiry, inquiryFields);
  }

  private inquiryStatusToKycVerificationStatus(
    inquiryStatus: PersonaInquiry['attributes']['status'],
  ): KYCVerificationStatus {
    switch (inquiryStatus) {
      case 'created':
      case 'pending':
      case 'completed':
      case 'needs_review':
        return KYCVerificationStatus.PENDING;
      case 'expired':
        return KYCVerificationStatus.EXPIRED;
      case 'failed':
      case 'declined':
        return KYCVerificationStatus.FAILED;
      case 'approved':
        return KYCVerificationStatus.VERIFIED;
      default:
        return KYCVerificationStatus.FAILED;
    }
  }

  private async getConnectedAccount(CollectiveId: number) {
    const connectedAccount = await ConnectedAccount.findOne({
      where: {
        CollectiveId,
        service: this.providerName,
      },
    });

    if (!connectedAccount) {
      throw new Error('Persona connected account not found');
    }

    return connectedAccount;
  }

  private async importInquiryId(req: KYCRequest, providerRequest: PersonaKYCRequest) {
    const connectedAccount = await this.getConnectedAccount(req.RequestedByCollectiveId);
    const client = new PersonaClient(connectedAccount.token);
    const { data: inquiry } = await client.retrieveInquiry(providerRequest.importInquiryId);

    const existingVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        CollectiveId: req.CollectiveId,
        RequestedByCollectiveId: req.RequestedByCollectiveId,
        provider: this.providerName,
        providerData: {
          inquiry: {
            id: providerRequest.importInquiryId,
          },
        },
      },
    });

    if (existingVerification) {
      return existingVerification.update({
        CreatedByUserId: req.CreatedByUserId,
        status: this.inquiryStatusToKycVerificationStatus(inquiry.attributes.status),
        providerData: {
          ...existingVerification.providerData,
          inquiry: this.sanitizeInquiry(inquiry),
        },
        data: this.verifiedDataFromInquiry(inquiry),
      });
    }

    const kycVerification = await KYCVerification.create<PersonaKYCVerification>({
      CreatedByUserId: req.CreatedByUserId,
      CollectiveId: req.CollectiveId,
      RequestedByCollectiveId: req.RequestedByCollectiveId,
      status: this.inquiryStatusToKycVerificationStatus(inquiry.attributes.status),
      providerData: {
        imported: true,
        inquiry: this.sanitizeInquiry(inquiry),
      },
      data: this.verifiedDataFromInquiry(inquiry),
      provider: this.providerName,
      verifiedAt: new Date(),
    });

    return kycVerification;
  }

  async requestVerification(params: KYCRequest, personaParams: PersonaKYCRequest): Promise<PersonaKYCVerification> {
    const requestedByCollective = await Collective.findByPk(params.RequestedByCollectiveId);
    if (!requestedByCollective) {
      throw new Error('Collective not found');
    }
    await checkFeatureAccess(requestedByCollective, FEATURE.PERSONA_KYC);

    if (personaParams?.importInquiryId) {
      return this.importInquiryId(params, personaParams);
    }

    const existingVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        CollectiveId: params.CollectiveId,
        RequestedByCollectiveId: params.RequestedByCollectiveId,
        provider: this.providerName,
        status: KYCVerificationStatus.VERIFIED,
      },
    });

    if (existingVerification) {
      return existingVerification;
    }

    const connectedAccount = await this.getConnectedAccount(params.RequestedByCollectiveId);
    const client = new PersonaClient(connectedAccount.token);

    const resumableVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        CollectiveId: params.CollectiveId,
        RequestedByCollectiveId: params.RequestedByCollectiveId,
        provider: this.providerName,
        status: {
          [Op.in]: [KYCVerificationStatus.EXPIRED, KYCVerificationStatus.PENDING],
        },
      },
    });

    if (resumableVerification) {
      const res = await client.resumeInquiry(resumableVerification.providerData.inquiry.id);
      return await resumableVerification.update({
        status: KYCVerificationStatus.PENDING,
        providerData: {
          ...resumableVerification.providerData,
          inquiry: this.sanitizeInquiry(res.data),
        },
      });
    }

    const { data: inquiry } = await client.createInquiry({
      accountReferenceId: `${params.RequestedByCollectiveId}-${params.CollectiveId}`,
      inquiryTemplateId: connectedAccount.settings.inquiryTemplateId,
    });

    const kycVerification = await KYCVerification.create<PersonaKYCVerification>({
      CollectiveId: params.CollectiveId,
      RequestedByCollectiveId: params.RequestedByCollectiveId,
      providerData: {
        inquiry: this.sanitizeInquiry(inquiry),
      },
      provider: this.providerName,
      status: KYCVerificationStatus.PENDING,
      verifiedAt: new Date(),
    });

    await this.createRequestedActivity(kycVerification, params.UserTokenId);

    return kycVerification;
  }

  async startVerification(kycVerification: PersonaKYCVerification): Promise<any> {
    const connectedAccount = await this.getConnectedAccount(kycVerification.RequestedByCollectiveId);
    const client = new PersonaClient(connectedAccount.token);
    const { data: inquiry, meta } = await client.resumeInquiry(kycVerification.providerData.inquiry.id);

    return {
      inquiryId: inquiry.id,
      sessionToken: meta['session-token'],
    };
  }

  private async resolveWebhookConnectedAccount(req: express.Request<{ connectedAccountID: string }>, res, next) {
    const idNumber = parseInt(req.params.connectedAccountID);
    const connectedAccount = await ConnectedAccount.findOne({
      where: {
        id: idNumber,
        service: this.providerName,
      },
      include: [
        {
          model: Collective,
          as: 'collective',
          required: true,
        },
      ],
    });

    if (!connectedAccount) {
      res.status(404).end();
      return;
    }

    req['locals'] = req['locals'] || {};
    req['locals']['connectedAccount'] = connectedAccount;
    next();
  }

  private async validateWebhook(req: express.Request, res, next) {
    const connectedAccount = req['locals']['connectedAccount'] as ConnectedAccount;
    const client = new PersonaClient(connectedAccount.token);

    if (!client.validateWebhook(req, crypto.decrypt(connectedAccount.data.webhook.secret))) {
      next(new Error('invalid webhook signature'));
      return;
    }

    next();
  }

  private async handleWebhook(req, res) {
    const connectedAccount = req.locals.connectedAccount as ConnectedAccount;
    const event = req.body.data as PersonaWebhookEvent;
    logger.info(`persona webhook for ${connectedAccount.collective.slug}: ${event.attributes.name}`);

    const eventName = event.attributes.name;

    try {
      switch (eventName) {
        case PersonaEvent.INQUIRY_APPROVED:
          await this.handleInquiryApproved(
            connectedAccount,
            event as PersonaWebhookEvent<PersonaEvent.INQUIRY_APPROVED>,
          );
          break;
        case PersonaEvent.INQUIRY_DECLINED:
          await this.handleInquiryDeclined(
            connectedAccount,
            event as PersonaWebhookEvent<PersonaEvent.INQUIRY_DECLINED>,
          );
          break;
        case PersonaEvent.INQUIRY_EXPIRED:
          await this.handleInquiryExpired(connectedAccount, event as PersonaWebhookEvent<PersonaEvent.INQUIRY_EXPIRED>);
          break;
        case PersonaEvent.INQUIRY_FAILED:
          await this.handleInquiryFailed(connectedAccount, event as PersonaWebhookEvent<PersonaEvent.INQUIRY_FAILED>);
          break;
      }
    } catch (error) {
      logger.error(`error handling persona webhook: ${error}`);
      res.status(500).end();
      return;
    }

    res.status(200).end();
  }

  private verifiedDataFromInquiry(inquiry: PersonaInquiry): KYCVerifiedData {
    const firstName = inquiry.attributes.fields.name_first.value ?? '';
    const middleName = inquiry.attributes.fields.name_middle.value ?? '';
    const lastName = inquiry.attributes.fields.name_last.value ?? '';
    let legalName = firstName;
    if (legalName && middleName) {
      legalName += ` ${middleName}`;
    }
    if (legalName && lastName) {
      legalName += ` ${lastName}`;
    }

    const legalAddress = inquiry.attributes.fields.address_street_1.value;
    return {
      legalName,
      legalAddress,
    };
  }

  private async handleInquiryApproved(
    connectedAccount: ConnectedAccount,
    event: PersonaWebhookEvent<PersonaEvent.INQUIRY_APPROVED>,
  ) {
    const inquiry = event.attributes.payload.data;
    const kycVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        RequestedByCollectiveId: connectedAccount.CollectiveId,
        provider: this.providerName,
        providerData: {
          inquiry: {
            id: inquiry.id,
          },
        },
      },
    });

    if (!kycVerification) {
      return;
    }

    await kycVerification.update({
      status: KYCVerificationStatus.VERIFIED,
      providerData: {
        ...kycVerification.providerData,
        inquiry: this.sanitizeInquiry(inquiry),
      },
    });
  }

  private async handleInquiryDeclined(
    connectedAccount: ConnectedAccount,
    event: PersonaWebhookEvent<PersonaEvent.INQUIRY_DECLINED>,
  ) {
    const inquiry = event.attributes.payload.data;
    const kycVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        RequestedByCollectiveId: connectedAccount.CollectiveId,
        provider: this.providerName,
        providerData: {
          inquiry: {
            id: inquiry.id,
          },
        },
      },
    });

    if (!kycVerification) {
      return;
    }

    await kycVerification.update({
      status: KYCVerificationStatus.FAILED,
      providerData: {
        ...kycVerification.providerData,
        inquiry: this.sanitizeInquiry(inquiry),
      },
    });
  }

  private async handleInquiryExpired(
    connectedAccount: ConnectedAccount,
    event: PersonaWebhookEvent<PersonaEvent.INQUIRY_EXPIRED>,
  ) {
    const inquiry = event.attributes.payload.data;
    const kycVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        RequestedByCollectiveId: connectedAccount.CollectiveId,
        provider: this.providerName,
        providerData: {
          inquiry: {
            id: inquiry.id,
          },
        },
      },
    });

    if (!kycVerification) {
      return;
    }

    await kycVerification.update({
      status: KYCVerificationStatus.EXPIRED,
      providerData: {
        ...kycVerification.providerData,
        inquiry: this.sanitizeInquiry(inquiry),
      },
    });
  }

  private async handleInquiryFailed(
    connectedAccount: ConnectedAccount,
    event: PersonaWebhookEvent<PersonaEvent.INQUIRY_FAILED>,
  ) {
    const inquiry = event.attributes.payload.data;
    const kycVerification = await KYCVerification.findOne<PersonaKYCVerification>({
      where: {
        RequestedByCollectiveId: connectedAccount.CollectiveId,
        provider: this.providerName,
        providerData: {
          inquiry: {
            id: inquiry.id,
          },
        },
      },
    });

    if (!kycVerification) {
      return;
    }

    await kycVerification.update({
      status: KYCVerificationStatus.FAILED,
      providerData: {
        ...kycVerification.providerData,
        inquiry: this.sanitizeInquiry(inquiry),
      },
    });
  }

  async provisionProvider(req: {
    CollectiveId: number;
    CreatedByUserId: number;
    apiKeyId: string;
    apiKey: string;
    inquiryTemplateId: string;
  }): Promise<ConnectedAccount> {
    const collective = await Collective.findByPk(req.CollectiveId);
    if (!collective) {
      throw new Error('Collective not found');
    }
    await checkFeatureAccess(collective, FEATURE.PERSONA_KYC);

    const client = new PersonaClient(req.apiKey);
    // test key
    try {
      await client.listWebhooks();
    } catch (error) {
      logger.error(`error listing webhooks: ${error}`);
      throw new Error('Invalid API key');
    }

    let connectedAccount = await ConnectedAccount.findOne({
      where: {
        CollectiveId: req.CollectiveId,
        service: this.providerName,
      },
    });

    if (!connectedAccount) {
      connectedAccount = await ConnectedAccount.create({
        CollectiveId: req.CollectiveId,
        service: this.providerName,
        token: req.apiKey,
        clientId: req.apiKeyId,
        CreatedByUserId: req.CreatedByUserId,
      });
      logger.info(`created persona connected account #${connectedAccount.id} for #${req.CollectiveId}`);
    } else {
      logger.info(`exiting persona connected account #${connectedAccount.id} for #${req.CollectiveId}`);
    }

    if (this.shouldProvisionWebhook) {
      logger.info(
        `will provision persona webhook on connected account #${connectedAccount.id} for #${req.CollectiveId}`,
      );
      const webhooks = await client.listWebhooks();

      // enabled webhooks targeting this connected account on this url
      const enabledOCWebhooks = webhooks.data.filter(webhook => {
        const hasOcUrlWithConnectedAccount = webhook.attributes.url === `${this.webhookBaseUrl}/${connectedAccount.id}`;
        return hasOcUrlWithConnectedAccount && webhook.attributes.status === 'enabled';
      });

      const [enabledOcWebhook, ...otherOcWebhooks] = enabledOCWebhooks;
      if (otherOcWebhooks?.length > 0) {
        logger.info(
          `disabling other persona webhooks on connected account #${connectedAccount.id} for #${req.CollectiveId}: ${otherOcWebhooks.length}`,
        );
        for (const toDisable of otherOcWebhooks) {
          await client.disableWebhook(toDisable.id);
        }
      }

      if (
        enabledOcWebhook &&
        !REQUIRED_WEBHOOK_EVENTS.every(requiredEvent =>
          enabledOcWebhook.attributes['enabled-events'].includes(requiredEvent),
        )
      ) {
        await client.updateWebhook(enabledOcWebhook.id, {
          enabledEvents: REQUIRED_WEBHOOK_EVENTS,
        });
      }

      let webhookWithSecret: PersonaWebhookWithSecret;
      if (enabledOcWebhook) {
        logger.info(`reusing existing persona webhooks`);
        const res = await client.retrieveWebhook(enabledOcWebhook.id);
        webhookWithSecret = res.data;
      } else {
        logger.info(`creating persona webhook`);
        const res = await client.createWebhook({
          name: 'OpenCollective Webhook',
          url: `${this.webhookBaseUrl}/${connectedAccount.id}`,
          enabledEvents: REQUIRED_WEBHOOK_EVENTS,
        });
        webhookWithSecret = res.data;
        await client.enableWebhook(webhookWithSecret.id);
      }

      await connectedAccount.update({
        data: {
          ...connectedAccount.data,
          webhook: {
            id: webhookWithSecret.id,
            secret: crypto.encrypt(webhookWithSecret.attributes.secret),
          },
        },
      });
    }

    return await connectedAccount.update({
      token: req.apiKey,
      clientId: req.apiKeyId,
      settings: {
        inquiryTemplateId: req.inquiryTemplateId,
      },
      data: {
        ...connectedAccount.data,
        apiKeyId: req.apiKeyId,
      },
    });
  }
}

const personaKycProvider = new PersonaKYCProvider();

export { personaKycProvider };
