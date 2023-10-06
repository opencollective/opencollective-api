import { expect } from 'chai';
import { useFakeTimers } from 'sinon';

import { roles } from '../../../../server/constants';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { canDownloadInvoice, canRefund, canReject } from '../../../../server/graphql/common/transactions';
import {
  fakeCollective,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
import { makeRequest } from '../../../utils';

describe('server/graphql/common/transactions', () => {
  let collective,
    collectiveAdmin,
    collectiveAccountant,
    fromCollectiveAccountant,
    hostAdmin,
    hostAccountant,
    contributor,
    randomUser,
    transaction,
    refundTransaction,
    manualPaymentTransaction;

  let publicReq,
    randomUserReq,
    fromCollectiveAccountantReq,
    collectiveAdminReq,
    collectiveAccountantReq,
    hostAdminReq,
    hostAccountantReq,
    rootAdminReq,
    contributorReq,
    timer,
    oldTransaction,
    addedFundTransaction;

  before(async () => {
    randomUser = await fakeUser();
    collectiveAdmin = await fakeUser();
    hostAdmin = await fakeUser();
    fromCollectiveAccountant = await fakeUser();
    collectiveAccountant = await fakeUser();
    hostAccountant = await fakeUser();
    const rootAdmin = await fakeUser({ data: { isRoot: true } });
    contributor = await fakeUser({}, { name: 'Contributor' });
    collective = await fakeCollective({ name: 'Collective' });
    const order = await fakeOrder({ FromCollectiveId: contributor.CollectiveId, CollectiveId: collective.id });
    const creditCard = await fakePaymentMethod({ service: 'stripe', type: 'creditcard', name: '4242' });
    transaction = await fakeTransaction({
      description: 'Contribution',
      CollectiveId: collective.id,
      FromCollectiveId: contributor.CollectiveId,
      amount: 100000,
      OrderId: order.id,
      PaymentMethodId: creditCard.id,
    });
    refundTransaction = await fakeTransaction({
      description: 'Refund of Contribution',
      FromCollectiveId: collective.id,
      CollectiveId: contributor.CollectiveId,
      amount: 100000,
      OrderId: order.id,
      isRefund: true,
      PaymentMethodId: creditCard.id,
    });
    addedFundTransaction = await fakeTransaction({
      description: 'Added Funds',
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      amount: 100000,
      kind: TransactionKind.ADDED_FUNDS,
      OrderId: order.id,
    });
    manualPaymentTransaction = await fakeTransaction({
      description: 'Manual payment',
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      PaymentMethodId: null,
      amount: 100000,
      kind: TransactionKind.CONTRIBUTION,
      OrderId: order.id,
    });
    timer = useFakeTimers(new Date('2020-07-23 0:0').getTime());
    oldTransaction = await fakeTransaction({
      CollectiveId: collective.id,
      FromCollectiveId: contributor.CollectiveId,
      amount: 100000,
      OrderId: order.id,
      PaymentMethodId: creditCard.id,
    });
    timer.restore();

    await collective.addUserWithRole(collectiveAdmin, 'ADMIN');
    await collective.host.addUserWithRole(hostAdmin, 'ADMIN');
    await contributor.collective.addUserWithRole(fromCollectiveAccountant, 'ACCOUNTANT');
    await collective.addUserWithRole(collectiveAccountant, 'ACCOUNTANT');
    await collective.host.addUserWithRole(hostAccountant, 'ACCOUNTANT');

    await collectiveAdmin.populateRoles();
    await hostAdmin.populateRoles();
    await rootAdmin.populateRoles();
    await collectiveAccountant.populateRoles();
    await hostAccountant.populateRoles();
    await fromCollectiveAccountant.populateRoles();

    rootAdmin.rolesByCollectiveId[1] = [roles.ADMIN];

    publicReq = makeRequest();
    randomUserReq = makeRequest(randomUser);
    collectiveAdminReq = makeRequest(collectiveAdmin);
    hostAdminReq = makeRequest(hostAdmin);
    rootAdminReq = makeRequest(rootAdmin);
    contributorReq = makeRequest(contributor);
    collectiveAccountantReq = makeRequest(collectiveAccountant);
    fromCollectiveAccountantReq = makeRequest(fromCollectiveAccountant);
    hostAccountantReq = makeRequest(hostAccountant);
  });

  describe('canRefund', () => {
    it('can refund if root or host admin of the collective receiving the contribution', async () => {
      expect(await canRefund(transaction, undefined, publicReq)).to.be.false;
      expect(await canRefund(transaction, undefined, randomUserReq)).to.be.false;
      expect(await canRefund(transaction, undefined, collectiveAccountantReq)).to.be.false;
      expect(await canRefund(transaction, undefined, hostAccountantReq)).to.be.false;
      expect(await canRefund(transaction, undefined, contributorReq)).to.be.false;
      expect(await canRefund(transaction, undefined, fromCollectiveAccountantReq)).to.be.false;
      expect(await canRefund(transaction, undefined, hostAdminReq)).to.be.true;
      expect(await canRefund(transaction, undefined, rootAdminReq)).to.be.true;
      expect(await canRefund(oldTransaction, undefined, hostAdminReq)).to.be.true;
      expect(await canRefund(oldTransaction, undefined, rootAdminReq)).to.be.true;
      expect(await canRefund(addedFundTransaction, undefined, rootAdminReq)).to.be.true;
      expect(await canRefund(addedFundTransaction, undefined, hostAdminReq)).to.be.true;
      expect(await canRefund(manualPaymentTransaction, undefined, hostAdminReq)).to.be.true;
    });

    it('can refund as admin of the receiving collective only if transaction < 30 days old', async () => {
      expect(await canRefund(transaction, undefined, collectiveAdminReq)).to.be.true;
      expect(await canRefund(oldTransaction, undefined, collectiveAdminReq)).to.be.false;
    });

    it('cannot refund as admin of receiving collective if the transaction is of kind ADDED_FUNDS', async () => {
      expect(await canRefund(addedFundTransaction, undefined, collectiveAdminReq)).to.be.false;
    });

    it('cannot refund as admin of receiving collective if the transaction is a manual payment', async () => {
      expect(await canRefund(manualPaymentTransaction, undefined, collectiveAdminReq)).to.be.false;
    });
  });

  describe('canReject', () => {
    it('can reject if root or host admin of the collective receiving the contribution', async () => {
      expect(await canReject(transaction, undefined, publicReq)).to.be.false;
      expect(await canReject(transaction, undefined, randomUserReq)).to.be.false;
      expect(await canReject(transaction, undefined, collectiveAccountantReq)).to.be.false;
      expect(await canReject(transaction, undefined, hostAccountantReq)).to.be.false;
      expect(await canReject(transaction, undefined, contributorReq)).to.be.false;
      expect(await canReject(transaction, undefined, fromCollectiveAccountantReq)).to.be.false;
      expect(await canReject(transaction, undefined, hostAdminReq)).to.be.true;
      expect(await canReject(transaction, undefined, rootAdminReq)).to.be.true;
      expect(await canReject(oldTransaction, undefined, hostAdminReq)).to.be.true;
      expect(await canReject(oldTransaction, undefined, rootAdminReq)).to.be.true;
      expect(await canReject(addedFundTransaction, undefined, rootAdminReq)).to.be.true;
      expect(await canReject(addedFundTransaction, undefined, hostAdminReq)).to.be.true;
      expect(await canReject(manualPaymentTransaction, undefined, hostAdminReq)).to.be.true;
    });

    it('can reject as admin of the receiving collective only if transaction < 30 days old', async () => {
      expect(await canReject(transaction, undefined, collectiveAdminReq)).to.be.true;
      expect(await canReject(oldTransaction, undefined, collectiveAdminReq)).to.be.false;
    });

    it('cannot Reject as admin of receiving collective if the transaction is of kind ADDED_FUNDS', async () => {
      expect(await canReject(addedFundTransaction, undefined, collectiveAdminReq)).to.be.false;
    });

    it('cannot Reject as admin of receiving collective if the transaction is a manual payment', async () => {
      expect(await canRefund(manualPaymentTransaction, undefined, collectiveAdminReq)).to.be.false;
    });
  });

  describe('canDownloadInvoice', () => {
    it('can download invoice if donator or host admin of the collective receiving the contribution', async () => {
      expect(await canDownloadInvoice(transaction, undefined, publicReq)).to.be.false;
      expect(await canDownloadInvoice(transaction, undefined, randomUserReq)).to.be.false;
      expect(await canDownloadInvoice(transaction, undefined, collectiveAdminReq)).to.be.false;
      expect(await canDownloadInvoice(transaction, undefined, contributorReq)).to.be.true;
      expect(await canDownloadInvoice(transaction, undefined, hostAccountantReq)).to.be.false;
      expect(await canDownloadInvoice(transaction, undefined, collectiveAccountantReq)).to.be.false;
      expect(await canDownloadInvoice(transaction, undefined, fromCollectiveAccountantReq)).to.be.true;
      expect(await canDownloadInvoice(transaction, undefined, hostAdminReq)).to.be.true;
      expect(await canDownloadInvoice(transaction, undefined, rootAdminReq)).to.be.false;
    });

    it('can download invoice for refunds if contributor or host admin of the collective receiving the contribution', async () => {
      expect(await canDownloadInvoice(refundTransaction, undefined, publicReq)).to.be.false;
      expect(await canDownloadInvoice(refundTransaction, undefined, randomUserReq)).to.be.false;
      expect(await canDownloadInvoice(refundTransaction, undefined, collectiveAdminReq)).to.be.false;
      expect(await canDownloadInvoice(refundTransaction, undefined, contributorReq)).to.be.true;
      expect(await canDownloadInvoice(refundTransaction, undefined, hostAccountantReq)).to.be.false;
      expect(await canDownloadInvoice(refundTransaction, undefined, collectiveAccountantReq)).to.be.false;
      expect(await canDownloadInvoice(refundTransaction, undefined, fromCollectiveAccountantReq)).to.be.true;
      expect(await canDownloadInvoice(refundTransaction, undefined, hostAdminReq)).to.be.true;
      expect(await canDownloadInvoice(refundTransaction, undefined, rootAdminReq)).to.be.false;
    });
  });
});
