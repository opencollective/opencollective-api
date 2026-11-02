import { expect } from 'chai';
import { pick } from 'lodash';
import sinon from 'sinon';

import { CollectiveType } from '../../../../server/constants/collectives';
import { Service } from '../../../../server/constants/connected-account';
import OrderStatuses from '../../../../server/constants/order-status';
import { checkExpense, checkExpensesBatch } from '../../../../server/lib/security/expense';
import models from '../../../../server/models';
import LegalDocument, {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
} from '../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeExpenseAttachedFile,
  fakeHost,
  fakeLegalDocument,
  fakeLocation,
  fakeOrder,
  fakePayoutMethod,
  fakeRequiredLegalDocument,
  fakeUploadedFile,
  fakeUser,
  multiple,
  randStr,
  sequelize,
} from '../../../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../../../utils';

const snapshotChecks = checks => checks.map(c => pick(c, ['scope', 'level', 'message']));

const encryptFormData = (values: Record<string, unknown>): string => {
  return LegalDocument.encrypt(Buffer.from(JSON.stringify(values))).toString('base64');
};

const buildW9LegalDocumentData = ({
  businessName,
  signerFirstName,
  signerLastName,
  country,
  city,
  postalCode,
  taxIdNumber,
}: {
  businessName: string;
  signerFirstName: string;
  signerLastName: string;
  country: string;
  city: string;
  postalCode: string;
  taxIdNumber: string;
}) => ({
  encryptedFormData: encryptFormData({
    formType: 'W9',
    submitterType: 'Business',
    email: 'payee@example.com',
    signer: { firstName: signerFirstName, middleName: '', lastName: signerLastName },
    businessName,
    taxIdNumberType: 'EIN',
    taxIdNumber,
    location: { country, structured: { address1: '1 Main St', city, postalCode } },
  }),
});

describe('lib/security/expense', () => {
  before(resetTestDB);

  before(async () => {
    await multiple(fakeExpense, 10, {});
  });

  describe('checkExpense() and checkExpenses()', () => {
    let expense;
    before(async () => {
      const ip = '192.168.0.27';
      const [user] = await multiple(fakeUser, 2, { data: { lastSignInRequest: { ip } }, updatedAt: new Date() });

      // Payout Method overlap
      const [pm] = await multiple(fakePayoutMethod, 2, {
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'will@dafoe.net',
        },
      });
      await pm.update({
        CollectiveId: user.collective.id,
      });

      // Connected Accounts overlap
      const otherUser = await fakeUser();
      const [ca] = await multiple(fakeConnectedAccount, 2, {
        service: Service.GITHUB,
        username: 'dude',
        CollectiveId: otherUser.collective.id,
      });
      await ca.update({
        CollectiveId: user.collective.id,
      });

      expense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });

      // Order Error rate
      await multiple(fakeOrder, 5, { CollectiveId: expense.CollectiveId, status: OrderStatuses.ERROR });
      await multiple(fakeOrder, 5, { CollectiveId: expense.CollectiveId, status: OrderStatuses.PAID });
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveOrderStats"`);
    });

    it('does not identify user as impersonating itself', async () => {
      const ip = '192.168.0.26';
      const userSlug = randStr('user-');
      const user = await fakeUser({ data: { lastSignInRequest: { ip } }, updatedAt: new Date() }, { slug: userSlug });

      const pm = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: `${randStr('email-')}@email.com`,
        },
        CollectiveId: user.collective.id,
      });
      const expense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });
      const securityChecks = await checkExpense(expense, { req: makeRequest() as any });

      expect(securityChecks.find(s => s.message === 'This user may be impersonating multiple profiles')).to.be
        .undefined;
    });

    it('returns potential threats related to the expense payment', async () => {
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(snapshotChecks(checks)).to.matchTableSnapshot();
    });

    it('returns potential threats related to the expense payment (batch)', async () => {
      const user = await fakeUser();
      const pm = await fakePayoutMethod({
        CollectiveId: user.collective.id,
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'nicolas@cage.com',
        },
      });
      const otherExpense = await fakeExpense({ UserId: user.id, PayoutMethodId: pm.id });

      const [expenseCheck, otherExpenseCheck] = await checkExpensesBatch(makeRequest() as any, [expense, otherExpense]);
      expect(await checkExpense(expense, { req: makeRequest() as any })).to.deep.equal(expenseCheck);
      expect(snapshotChecks(expenseCheck)).to.matchTableSnapshot();
      expect(snapshotChecks(otherExpenseCheck)).to.matchTableSnapshot();
    });

    it('ignores similar payout methods that belongs to VENDORs', async () => {
      const [vendor, anotherVendor] = await multiple(fakeCollective, 2, { type: CollectiveType.VENDOR });
      const pm = await fakePayoutMethod({
        CollectiveId: vendor.id,
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'vendor@opencollective.com',
        },
      });
      await fakePayoutMethod({
        CollectiveId: anotherVendor.id,
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'vendor@opencollective.com',
        },
      });
      const vendorExpense = await fakeExpense({ UserId: vendor.CreatedByUserId, PayoutMethodId: pm.id });

      const checks = await checkExpense(vendorExpense, { req: makeRequest() as any });
      expect(snapshotChecks(checks)).to.matchTableSnapshot();
    });

    it('detects if the same file was attached to multiple expenses', async () => {
      const expense = await fakeExpense();
      const file1 = await fakeUploadedFile({ data: { s3SHA256: 'test' } });
      await fakeExpenseAttachedFile({ ExpenseId: expense.id, url: file1.getDataValue('url') });

      const otherExpense = await fakeExpense();
      const file2 = await fakeUploadedFile({ data: { s3SHA256: 'test' } });
      await fakeExpenseAttachedFile({ ExpenseId: otherExpense.id, url: file2.getDataValue('url') });

      const checks = await checkExpense(otherExpense, { req: makeRequest() as any });
      expect(checks).to.containSubset([
        {
          scope: 'ATTACHMENTS',
          level: 'HIGH',
          message: 'Same attachment uploaded to multiple expenses',
        },
      ]);
    });
  });

  describe('legal document checks', () => {
    let sandbox: sinon.SinonSandbox;
    const getLegalDocumentChecks = checks => checks.filter(check => check.scope === 'LEGAL_DOCUMENT');

    const createPayeeWithLocation = async ({
      legalName,
      countryISO,
      city,
      postalCode,
    }: {
      legalName: string;
      countryISO: string;
      city: string;
      postalCode: string;
    }) => {
      const payee = await fakeCollective({ type: CollectiveType.ORGANIZATION, legalName, countryISO });
      await fakeLocation({ CollectiveId: payee.id, country: countryISO, structured: { city, postalCode } });
      return payee;
    };

    const createHost = async ({ requiresTaxForm = true } = {}) => {
      const host = await fakeHost();
      if (requiresTaxForm) {
        await fakeRequiredLegalDocument({ HostCollectiveId: host.id });
      }
      return host;
    };

    const createProcessingCollective = (host: { id: number }) => fakeCollective({ HostCollectiveId: host.id });

    const createExpenseForPayee = async (payee: { id: number }) => {
      const host = await createHost();
      const collective = await createProcessingCollective(host);
      return fakeExpense({ CollectiveId: collective.id, FromCollectiveId: payee.id });
    };

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('flags name, address and country mismatches with the submitted legal document', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: buildW9LegalDocumentData({
          businessName: 'Evil Corp',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'US',
          city: 'New York',
          postalCode: '10001',
          taxIdNumber: '12-3456789',
        }),
      });

      const expense = await createExpenseForPayee(payee);
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      const legalDocumentChecks = getLegalDocumentChecks(checks);

      expect(legalDocumentChecks).to.have.length(3);
      expect(legalDocumentChecks).to.containSubset([
        {
          scope: 'LEGAL_DOCUMENT',
          level: 'MEDIUM',
          message: 'Legal document name does not match the payee name',
        },
        {
          scope: 'LEGAL_DOCUMENT',
          level: 'MEDIUM',
          message: 'Legal document address does not match the payee address',
        },
        {
          scope: 'LEGAL_DOCUMENT',
          level: 'MEDIUM',
          message: 'Legal document country does not match the payee country',
        },
      ]);
      expect(legalDocumentChecks.map(check => check.level)).to.not.include('HIGH');
      expect(legalDocumentChecks.find(check => check.message.includes('name')).details).to.include(
        'The name on the legal document ("Jane Doe" / "Evil Corp") does not match the payee name ("Acme Inc").',
      );
      expect(legalDocumentChecks.find(check => check.message.includes('address')).details).to.eq(
        'The legal document lists "New York, 10001 (US)", while the payee is registered at "Paris, 75001 (FR)".',
      );
      expect(legalDocumentChecks.find(check => check.message.includes('country')).details).to.eq(
        'The legal document lists the country "US", while the payee is registered in "FR".',
      );
      // Tax IDs must never leak into the checks
      expect(JSON.stringify(legalDocumentChecks)).to.not.include('12-3456789');
    });

    it('flags mismatches with the payout method bank account', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: buildW9LegalDocumentData({
          businessName: 'Acme Inc',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'FR',
          city: 'Paris',
          postalCode: '75001',
          taxIdNumber: '12-3456789',
        }),
      });
      const payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        CollectiveId: payee.id,
        data: {
          accountHolderName: 'Evil Corp',
          currency: 'USD',
          type: 'aba',
          details: {
            address: { country: 'US', city: 'New York', postCode: '10001', firstLine: '1 Main St', state: 'NY' },
          },
        },
      });

      const host = await createHost();
      const collective = await createProcessingCollective(host);
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payee.id,
        PayoutMethodId: payoutMethod.id,
      });
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      const legalDocumentChecks = getLegalDocumentChecks(checks);

      expect(legalDocumentChecks).to.have.length(3);
      expect(legalDocumentChecks).to.containSubset([
        {
          scope: 'LEGAL_DOCUMENT',
          level: 'MEDIUM',
          message: 'Legal document name does not match the payout method account holder name',
        },
        {
          scope: 'LEGAL_DOCUMENT',
          level: 'MEDIUM',
          message: 'Legal document address does not match the payout method address',
        },
        {
          scope: 'LEGAL_DOCUMENT',
          level: 'MEDIUM',
          message: 'Legal document country does not match the payout method country',
        },
      ]);
      expect(legalDocumentChecks.find(check => check.message.includes('name')).details).to.eq(
        'The name on the legal document ("Jane Doe" / "Acme Inc") does not match the payout method account holder name ("Evil Corp").',
      );
      expect(legalDocumentChecks.find(check => check.message.includes('address')).details).to.eq(
        'The legal document lists "Paris, 75001 (FR)", while the payout method is registered at "New York, 10001 (US)".',
      );
      expect(legalDocumentChecks.find(check => check.message.includes('country')).details).to.eq(
        'The legal document lists the country "FR", while the payout method is registered in "US".',
      );
      expect(JSON.stringify(legalDocumentChecks)).to.not.include('12-3456789');
    });

    it('does not flag bank account details when the legal document matches them', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: buildW9LegalDocumentData({
          businessName: 'Acme Inc',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'FR',
          city: 'Paris',
          postalCode: '75001',
          taxIdNumber: '12-3456789',
        }),
      });
      const payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        CollectiveId: payee.id,
        data: {
          accountHolderName: 'Acme Inc',
          currency: 'USD',
          type: 'aba',
          details: {
            address: { country: 'FR', city: 'Paris', postCode: '75001', firstLine: '1 Main St', state: 'IDF' },
          },
        },
      });

      const host = await createHost();
      const collective = await createProcessingCollective(host);
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payee.id,
        PayoutMethodId: payoutMethod.id,
      });
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(getLegalDocumentChecks(checks)).to.be.empty;
    });

    it('does not flag anything when the legal document matches the payee', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: buildW9LegalDocumentData({
          businessName: 'Acme Inc',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'FR',
          city: 'Paris',
          postalCode: '75001',
          taxIdNumber: '12-3456789',
        }),
      });

      const expense = await createExpenseForPayee(payee);
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(getLegalDocumentChecks(checks)).to.be.empty;
    });

    it('ignores documents that are not RECEIVED', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
        data: buildW9LegalDocumentData({
          businessName: 'Evil Corp',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'US',
          city: 'New York',
          postalCode: '10001',
          taxIdNumber: '12-3456789',
        }),
      });

      const expense = await createExpenseForPayee(payee);
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(getLegalDocumentChecks(checks)).to.be.empty;
    });

    it('does not throw when the legal document payload cannot be decrypted', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: { encryptedFormData: 'not-a-valid-payload' },
      });

      const expense = await createExpenseForPayee(payee);
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(getLegalDocumentChecks(checks)).to.be.empty;
    });

    it('ignores legal documents when the fiscal host does not require tax forms', async () => {
      const host = await createHost({ requiresTaxForm: false });
      const collective = await createProcessingCollective(host);
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: buildW9LegalDocumentData({
          businessName: 'Evil Corp',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'US',
          city: 'New York',
          postalCode: '10001',
          taxIdNumber: '12-3456789',
        }),
      });

      const expense = await fakeExpense({ CollectiveId: collective.id, FromCollectiveId: payee.id });
      const checks = await checkExpense(expense, { req: makeRequest() as any });
      expect(getLegalDocumentChecks(checks)).to.be.empty;
    });

    it('skips tax form requirement lookups when no payee has a legal document', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      const expense = await createExpenseForPayee(payee);

      const requiredLegalDocumentSpy = sandbox.spy(models.RequiredLegalDocument, 'findAll');
      const checks = await checkExpense(expense, { req: makeRequest() as any });

      expect(requiredLegalDocumentSpy.callCount).to.eq(0);
      expect(getLegalDocumentChecks(checks)).to.be.empty;
    });

    it('scopes the checks to the fiscal host processing each expense', async () => {
      const hostWithTaxForms = await createHost();
      const hostWithoutTaxForms = await createHost({ requiresTaxForm: false });
      const collectiveWithTaxForms = await createProcessingCollective(hostWithTaxForms);
      const collectiveWithoutTaxForms = await createProcessingCollective(hostWithoutTaxForms);
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        data: buildW9LegalDocumentData({
          businessName: 'Evil Corp',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'US',
          city: 'New York',
          postalCode: '10001',
          taxIdNumber: '12-3456789',
        }),
      });

      const [expenseWithTaxForms, expenseWithoutTaxForms] = await Promise.all([
        fakeExpense({ CollectiveId: collectiveWithTaxForms.id, FromCollectiveId: payee.id }),
        fakeExpense({ CollectiveId: collectiveWithoutTaxForms.id, FromCollectiveId: payee.id }),
      ]);
      const [checksWithTaxForms, checksWithoutTaxForms] = await checkExpensesBatch(makeRequest() as any, [
        expenseWithTaxForms,
        expenseWithoutTaxForms,
      ]);

      expect(getLegalDocumentChecks(checksWithTaxForms)).to.have.length(3);
      expect(getLegalDocumentChecks(checksWithoutTaxForms)).to.be.empty;
    });

    it('loads the latest RECEIVED legal document once per batch', async () => {
      const payee = await createPayeeWithLocation({
        legalName: 'Acme Inc',
        countryISO: 'FR',
        city: 'Paris',
        postalCode: '75001',
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        createdAt: new Date('2024-01-01'),
        data: buildW9LegalDocumentData({
          businessName: 'Evil Corp',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'US',
          city: 'New York',
          postalCode: '10001',
          taxIdNumber: '12-3456789',
        }),
      });
      await fakeLegalDocument({
        CollectiveId: payee.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        createdAt: new Date('2025-01-01'),
        data: buildW9LegalDocumentData({
          businessName: 'Acme Inc',
          signerFirstName: 'Jane',
          signerLastName: 'Doe',
          country: 'FR',
          city: 'Paris',
          postalCode: '75001',
          taxIdNumber: '98-7654321',
        }),
      });

      const findAllSpy = sandbox.spy(models.LegalDocument, 'findAll');
      const host = await createHost();
      const collective = await createProcessingCollective(host);
      const [firstExpense, secondExpense] = await Promise.all([
        fakeExpense({ CollectiveId: collective.id, FromCollectiveId: payee.id }),
        fakeExpense({ CollectiveId: collective.id, FromCollectiveId: payee.id }),
      ]);
      const [firstChecks, secondChecks] = await checkExpensesBatch(makeRequest() as any, [firstExpense, secondExpense]);

      expect(findAllSpy.callCount).to.eq(1);
      expect(getLegalDocumentChecks(firstChecks)).to.be.empty;
      expect(getLegalDocumentChecks(secondChecks)).to.be.empty;
    });
  });
});
