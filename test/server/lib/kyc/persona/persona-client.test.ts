import { expect } from 'chai';
import nock from 'nock';
import sinon, { SinonSandbox } from 'sinon';

import { PersonaClient } from '../../../../../server/lib/kyc/providers/persona/client';

describe('server/lib/kyc/persona/client', () => {
  let sandbox: SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('errors', () => {
    it('handle API error', async () => {
      const client = new PersonaClient('dummy-api-key');
      const scope = nock(client.personaBaseUrl)
        .get('/api/v1/webhooks')
        .reply(400, { errors: [{ title: 'Bad Request' }] });

      await expect(client.listWebhooks()).to.be.rejectedWith('Persona API error: 400 Bad Request');

      expect(scope.isDone()).to.be.true;
    });
  });

  describe('listWebhooks', () => {
    it('calls listWebhooks on the Persona API base URL', async () => {
      const client = new PersonaClient('dummy-api-key');
      const scope = nock(client.personaBaseUrl).get('/api/v1/webhooks').reply(200, { data: [] });

      await client.listWebhooks();

      expect(scope.isDone()).to.be.true;
    });
  });
});
