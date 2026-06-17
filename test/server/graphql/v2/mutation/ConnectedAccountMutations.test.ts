import { expect } from 'chai';
import gql from 'fake-tag';
import sinon, { createSandbox } from 'sinon';

import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import * as GoCardlessConnect from '../../../../../server/lib/gocardless/connect';
import * as paypal from '../../../../../server/lib/paypal';
import * as PlaidConnect from '../../../../../server/lib/plaid/connect';
import models from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeOrder,
  fakePaymentMethod,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/ConnectedAccountMutations', () => {
  const sandbox = createSandbox();
  beforeEach(async () => {
    await utils.resetTestDB();
  });

  afterEach(() => sandbox.restore());

  describe('createConnectedAccount', () => {
    const createConnectedAccountMutation = gql`
      mutation CreateConnectedAccount(
        $connectedAccount: ConnectedAccountCreateInput!
        $account: AccountReferenceInput!
      ) {
        createConnectedAccount(connectedAccount: $connectedAccount, account: $account) {
          id
          legacyId
          settings
          service
        }
      }
    `;
    let user, collective;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeActiveHost({
        plan: 'start-plan-2021',
        admin: user.collective,
        settings: { features: { paypalPayouts: true } },
      });
    });

    beforeEach(() => {
      sandbox.stub(paypal, 'validateConnectedAccount').resolves();
      sandbox.stub(paypal, 'setupPaypalWebhookForHost').resolves();
    });

    it('should create a new connected account', async () => {
      const connectedAccount = {
        token: 'fakeToken',
        service: 'paypal',
      };

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createConnectedAccount).to.exist;

      const createdConnectedAccount = await models.ConnectedAccount.findByPk(
        result.data.createConnectedAccount.legacyId,
      );
      expect(createdConnectedAccount.toJSON()).to.deep.include(connectedAccount);
      expect(paypal.validateConnectedAccount).to.have.been.calledOnce;
      expect(paypal.setupPaypalWebhookForHost).to.have.been.calledOnce;
    });

    it('should fail if token already exists', async () => {
      const connectedAccount = {
        token: 'fakeToken',
        service: 'paypal',
      };

      await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('ValidationFailed');
      expect(result.errors[0].message).to.include('This token is already being used');
    });

    it('should fail if service is not supported (e.g. transferwise)', async () => {
      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount: { token: 'fakeToken', service: 'transferwise' },
          account: { legacyId: collective.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      expect(result.errors[0].message).to.include('Only PayPal is supported');
    });

    it('should fail if token is not valid', async () => {
      (paypal.validateConnectedAccount as sinon.SinonStub).rejects();
      const setupWebhookStub = paypal.setupPaypalWebhookForHost as sinon.SinonStub;
      const connectedAccount = {
        token: 'fakeToken',
        service: 'paypal',
      };

      const result = await graphqlQueryV2(
        createConnectedAccountMutation,
        {
          connectedAccount,
          account: { legacyId: collective.id },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('ValidationFailed');
      expect(result.errors[0].message).to.include('The Client ID and Token are not a valid combination');
      expect(setupWebhookStub).to.not.have.been.called;
    });
  });

  describe('deleteConnectedAccount', () => {
    const deleteConnectedAccountMutation = gql`
      mutation DeleteConnectedAccount($connectedAccount: ConnectedAccountReferenceInput!) {
        deleteConnectedAccount(connectedAccount: $connectedAccount) {
          id
        }
      }
    `;

    let user, collective, connectedAccount;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeCollective({
        admin: user.collective,
      });
      connectedAccount = await fakeConnectedAccount({ CollectiveId: collective.id });
    });

    it('should soft delete the connected account', async () => {
      const result = await graphqlQueryV2(
        deleteConnectedAccountMutation,
        {
          connectedAccount: {
            legacyId: connectedAccount.id,
          },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;

      const createdConnectedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id, { paranoid: false });
      expect(createdConnectedAccount).to.not.be.null;
      expect(createdConnectedAccount.deletedAt).to.not.be.null;
    });

    it('should fail if the connected account is being mirrored by another organization', async () => {
      connectedAccount = await fakeConnectedAccount({ service: 'transferwise', CollectiveId: collective.id });
      // Create a mirror connected account that references the original via data.MirrorConnectedAccountId
      await fakeConnectedAccount({
        data: { MirrorConnectedAccountId: connectedAccount.id },
      });

      const result = await graphqlQueryV2(
        deleteConnectedAccountMutation,
        {
          connectedAccount: {
            legacyId: connectedAccount.id,
          },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include(
        'This connected account is being mirrored by other organization(s). Please disconnect mirrors before removing this account.',
      );

      // Verify the account was NOT deleted
      const stillExists = await models.ConnectedAccount.findByPk(connectedAccount.id);
      expect(stillExists).to.not.be.null;
      expect(stillExists.deletedAt).to.be.null;
    });

    describe('should disconnect on 3rd party services', () => {
      it('with Plaid', async () => {
        sandbox.stub(PlaidConnect, 'disconnectPlaidAccount').resolves();
        const connectedAccount = await fakeConnectedAccount({ service: 'plaid' });
        await connectedAccount.collective.addUserWithRole(user, 'ADMIN');
        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: connectedAccount.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(PlaidConnect.disconnectPlaidAccount).to.have.been.calledOnce;
        const deletedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id);
        expect(deletedAccount).to.be.null;
      });

      it('with Stripe - no active recurring contributions', async () => {
        const host = await fakeActiveHost();
        await host.addUserWithRole(user, 'ADMIN');
        const stripeAccount = await fakeConnectedAccount({ service: 'stripe', CollectiveId: host.id });

        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: stripeAccount.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const deletedAccount = await models.ConnectedAccount.findByPk(stripeAccount.id, { paranoid: false });
        expect(deletedAccount.deletedAt).to.not.be.null;
      });

      it('with Stripe - fails when there are active recurring contributions', async () => {
        const host = await fakeActiveHost();
        await host.addUserWithRole(user, 'ADMIN');
        const stripeAccount = await fakeConnectedAccount({ service: 'stripe', CollectiveId: host.id });

        // Create an active recurring order via a Stripe payment method hosted by this host
        const hostedCollective = await fakeCollective({ HostCollectiveId: host.id });
        const pm = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
        });
        await fakeOrder(
          { CollectiveId: hostedCollective.id, PaymentMethodId: pm.id, status: OrderStatuses.ACTIVE },
          { withSubscription: true },
        );

        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: stripeAccount.id } },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('ValidationFailed');
        expect(result.errors[0].message).to.include(
          'There are active contributions based on this payment provider. Please contact support to disconnect it.',
        );

        // Verify the account was NOT deleted
        const stillExists = await models.ConnectedAccount.findByPk(stripeAccount.id);
        expect(stillExists).to.not.be.null;
        expect(stillExists.deletedAt).to.be.null;
      });

      it('with PayPal - no active recurring contributions', async () => {
        const host = await fakeActiveHost();
        await host.addUserWithRole(user, 'ADMIN');
        const paypalAccount = await fakeConnectedAccount({ service: 'paypal', CollectiveId: host.id });

        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: paypalAccount.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const deletedAccount = await models.ConnectedAccount.findByPk(paypalAccount.id, { paranoid: false });
        expect(deletedAccount.deletedAt).to.not.be.null;
      });

      it('with PayPal - fails when there are active recurring contributions', async () => {
        const host = await fakeActiveHost();
        await host.addUserWithRole(user, 'ADMIN');
        const paypalAccount = await fakeConnectedAccount({ service: 'paypal', CollectiveId: host.id });

        // Create an active recurring order via a PayPal payment method hosted by this host
        const hostedCollective = await fakeCollective({ HostCollectiveId: host.id });
        const pm = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.PAYPAL,
          type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
        });
        await fakeOrder(
          { CollectiveId: hostedCollective.id, PaymentMethodId: pm.id, status: OrderStatuses.ACTIVE },
          { withSubscription: true },
        );

        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: paypalAccount.id } },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('ValidationFailed');
        expect(result.errors[0].message).to.include(
          'There are active contributions based on this payment provider. Please contact support to disconnect it.',
        );

        // Verify the account was NOT deleted
        const stillExists = await models.ConnectedAccount.findByPk(paypalAccount.id);
        expect(stillExists).to.not.be.null;
        expect(stillExists.deletedAt).to.be.null;
      });

      it('with GoCardless', async () => {
        sandbox.stub(GoCardlessConnect, 'disconnectGoCardlessAccount').resolves();
        const connectedAccount = await fakeConnectedAccount({ service: 'gocardless' });
        await connectedAccount.collective.addUserWithRole(user, 'ADMIN');
        const result = await graphqlQueryV2(
          deleteConnectedAccountMutation,
          { connectedAccount: { legacyId: connectedAccount.id } },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(GoCardlessConnect.disconnectGoCardlessAccount).to.have.been.calledOnce;
        const deletedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id);
        expect(deletedAccount).to.be.null;
      });
    });
  });
});
