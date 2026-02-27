import debugLib from 'debug';
import type express from 'express';
import nodeCrypto from 'node:crypto';

import { reportErrorToSentry } from '../../../sentry';

const debug = debugLib('persona:client');

export enum PersonaEvent {
  INQUIRY_CREATED = 'inquiry.created',
  INQUIRY_DECLINED = 'inquiry.declined',
  INQUIRY_EXPIRED = 'inquiry.expired',
  INQUIRY_FAILED = 'inquiry.failed',
  INQUIRY_APPROVED = 'inquiry.approved',
}

type PersonaFieldType = 'string' | 'date' | 'selfie' | 'json' | 'government_id';
type PersonaFieldValues = {
  string: string;
  date: string;
  selfie: {
    id: string;
    type: string;
  };
  json: object;
  government_id: {
    id: string;
    type: string;
  };
};

type PersonaInquiryField<Type extends PersonaFieldType = PersonaFieldType> = {
  type: Type;
  value: null | (Type extends keyof PersonaFieldValues ? PersonaFieldValues[Type] : unknown);
};

export type PersonaInquiry = {
  type: 'inquiry';
  id: string;
  attributes: {
    status: 'created' | 'pending' | 'completed' | 'expired' | 'failed' | 'needs_review' | 'approved' | 'declined';
    fields: {
      name_first?: PersonaInquiryField<'string'>;
      name_last?: PersonaInquiryField<'string'>;
      name_middle?: PersonaInquiryField<'string'>;
      address_city?: PersonaInquiryField<'string'>;
      address_street_1?: PersonaInquiryField<'string'>;
      address_street_2?: PersonaInquiryField<'string'>;
      address_postal_code?: PersonaInquiryField<'string'>;
      address_subdivision?: PersonaInquiryField<'string'>;
      address_country_code?: PersonaInquiryField<'string'>;
    } & Record<string, PersonaInquiryField>;
  };
};

type PersonaEventPayload = {
  [PersonaEvent.INQUIRY_CREATED]: {
    data: PersonaInquiry;
  };
  [PersonaEvent.INQUIRY_DECLINED]: {
    data: PersonaInquiry;
  };
  [PersonaEvent.INQUIRY_EXPIRED]: {
    data: PersonaInquiry;
  };
  [PersonaEvent.INQUIRY_FAILED]: {
    data: PersonaInquiry;
  };
  [PersonaEvent.INQUIRY_APPROVED]: {
    data: PersonaInquiry;
  };
};

export type PersonaWebhookEvent<E extends PersonaEvent = PersonaEvent> = {
  type: 'event';
  id: string;
  attributes: {
    name: E;
    'created-at': string;
    payload: E extends keyof PersonaEventPayload ? PersonaEventPayload[E] : unknown;
  };
};

type PersonaWebhook = {
  id: string;
  attributes: {
    status: 'disabled' | 'enabled' | 'archived';
    url: string;
    'enabled-events': PersonaEvent[];
  };
};

export type PersonaWebhookWithSecret = PersonaWebhook & {
  attributes: {
    secret: string;
  };
};

export class PersonaClient {
  private apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get personaBaseUrl(): string {
    return 'https://api.withpersona.com';
  }

  private get personaRequestHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  validateWebhook(req: express.Request, webhookSecret: string): boolean {
    const body = req.rawBody;
    const signatureHeader = req.headers['persona-signature'] as string;
    const t = signatureHeader.split(',')[0].split('=')[1];

    const signatures = signatureHeader.split(' ').map(pair => pair.split('v1=')[1]);

    const hmac = nodeCrypto.createHmac('sha256', webhookSecret).update(`${t}.${body}`).digest('hex');

    const isVerified = signatures.some(signature => {
      return nodeCrypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
    });

    return isVerified;
  }

  async createInquiry(opts: {
    accountReferenceId: string;
    inquiryTemplateId: string;
  }): Promise<{ data: PersonaInquiry }> {
    const { body } = await this.apiRequest(
      'POST',
      `/api/v1/inquiries`,
      JSON.stringify({
        data: {
          attributes: {
            'inquiry-template-id': opts.inquiryTemplateId,
          },
        },
        meta: {
          'auto-create-account': true,
          'auto-create-account-reference-id': opts.accountReferenceId,
        },
      }),
    );

    return body as { data: PersonaInquiry };
  }

  async resumeInquiry(id: string): Promise<{
    data: PersonaInquiry;
    meta: {
      'session-token': string;
    };
  }> {
    const { body } = await this.apiRequest('POST', `/api/v1/inquiries/${id}/resume`);
    return body as { data: PersonaInquiry; meta: { 'session-token': string } };
  }

  async retrieveInquiry(id: string): Promise<{ data: PersonaInquiry }> {
    const { body } = await this.apiRequest('GET', `/api/v1/inquiries/${id}`);

    return body as { data: PersonaInquiry };
  }

  async listWebhooks(): Promise<{
    data: PersonaWebhook[];
  }> {
    const { body } = await this.apiRequest('GET', `/api/v1/webhooks`);

    return body as { data: PersonaWebhook[] };
  }

  async retrieveWebhook(id: string): Promise<{ data: PersonaWebhookWithSecret }> {
    const { body } = await this.apiRequest('GET', `/api/v1/webhooks/${id}`);

    return body as { data: PersonaWebhookWithSecret };
  }

  async updateWebhook(
    id: string,
    opts: {
      enabledEvents: PersonaEvent[];
    },
  ): Promise<{
    data: PersonaWebhook[];
  }> {
    const { body } = await this.apiRequest(
      'PATCH',
      `/api/v1/webhooks/${id}`,
      JSON.stringify({
        data: {
          attributes: {
            'enabled-events': opts.enabledEvents,
          },
        },
      }),
    );

    return body as { data: PersonaWebhook[] };
  }

  async createWebhook(opts: {
    url: string;
    name: string;
    enabledEvents: PersonaEvent[];
  }): Promise<{ data: PersonaWebhookWithSecret }> {
    const { body } = await this.apiRequest(
      'POST',
      `/api/v1/webhooks`,
      JSON.stringify({
        data: {
          attributes: {
            name: opts.name,
            url: opts.url,
            'enabled-events': opts.enabledEvents,
          },
        },
      }),
    );
    return body as { data: PersonaWebhookWithSecret };
  }

  async enableWebhook(id: string): Promise<{ data: PersonaWebhook }> {
    const { body } = await this.apiRequest('POST', `/api/v1/webhooks/${id}/enable`);

    return body as { data: PersonaWebhook };
  }

  async disableWebhook(id: string): Promise<{ data: PersonaWebhook }> {
    const { body } = await this.apiRequest('POST', `/api/v1/webhooks/${id}/disable`);

    return body as { data: PersonaWebhook };
  }

  private async apiRequest(
    method: string,
    reqPath: string,
    body?: BodyInit,
    init?: RequestInit,
  ): Promise<{ status: number; headers: Headers; body: unknown }> {
    let res: Response;
    try {
      debug(`persona request: ${method} ${reqPath}`);
      res = await fetch(`${this.personaBaseUrl}${reqPath}`, {
        method,
        body,
        ...init,
        headers: {
          ...init?.headers,
          ...this.personaRequestHeaders,
        },
      });

      const responseBody = await res.json();
      debug(`persona response: ${res.status}, ${JSON.stringify(responseBody)}`);

      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, headers: res.headers, body: responseBody };
      }

      throw new Error(`Persona API error: ${res.status} ${responseBody?.errors?.[0]?.title}`);
    } catch (e) {
      debug(`persona error: ${e.message}`);
      reportErrorToSentry(e);
      throw e;
    }
  }
}
