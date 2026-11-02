import { expect } from 'chai';

import {
  getLegalDocumentAddressMismatchDetails,
  getLegalDocumentCountryMismatchDetails,
  getLegalDocumentIdentity,
  getLegalDocumentNameMismatchDetails,
  LegalDocumentIdentity,
} from '../../../../server/lib/tax-forms/identity';
import LegalDocument, {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
} from '../../../../server/models/LegalDocument';

const encryptFormData = (values: Record<string, unknown>): string => {
  return LegalDocument.encrypt(Buffer.from(JSON.stringify(values))).toString('base64');
};

const buildLegalDocument = (data: Record<string, unknown>, overrides: Partial<LegalDocument> = {}): LegalDocument =>
  ({
    id: 1,
    documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
    requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
    service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
    data,
    ...overrides,
  }) as LegalDocument;

const buildIdentity = (overrides: Partial<LegalDocumentIdentity> = {}): LegalDocumentIdentity => ({
  formType: 'W9',
  individualName: null,
  entityName: null,
  address: {
    address1: null,
    address2: null,
    city: null,
    zone: null,
    postalCode: null,
    country: null,
  },
  country: null,
  email: null,
  ...overrides,
});

describe('server/lib/tax-forms/identity', () => {
  describe('getLegalDocumentIdentity', () => {
    it('returns null when the document has no encrypted form data', () => {
      expect(getLegalDocumentIdentity(buildLegalDocument({}))).to.be.null;
      expect(getLegalDocumentIdentity(buildLegalDocument({ encryptedFormData: null }))).to.be.null;
      expect(getLegalDocumentIdentity(null)).to.be.null;
    });

    it('returns null when the encrypted form data cannot be decrypted', () => {
      expect(getLegalDocumentIdentity(buildLegalDocument({ encryptedFormData: 'not-a-valid-payload' }))).to.be.null;
    });

    it('normalizes a W9 Open Collective payload', () => {
      const identity = getLegalDocumentIdentity(
        buildLegalDocument({
          encryptedFormData: encryptFormData({
            formType: 'W9',
            submitterType: 'Business',
            email: 'jane@example.com',
            signer: { firstName: 'Jane', middleName: '', lastName: 'Doe' },
            businessName: 'Acme Inc',
            taxIdNumberType: 'EIN',
            taxIdNumber: '12-3456789',
            location: {
              country: 'us',
              structured: {
                address1: '1 Market St',
                address2: 'Suite 100',
                city: 'San Francisco',
                zone: 'CA',
                postalCode: '94105',
              },
            },
          }),
        }),
      );

      expect(identity).to.deep.equal({
        formType: 'W9',
        individualName: 'Jane Doe',
        entityName: 'Acme Inc',
        address: {
          address1: '1 Market St',
          address2: 'Suite 100',
          city: 'San Francisco',
          zone: 'CA',
          postalCode: '94105',
          country: 'US',
        },
        country: 'US',
        email: 'jane@example.com',
      });
    });

    it('normalizes a W8-BEN Open Collective payload', () => {
      const identity = getLegalDocumentIdentity(
        buildLegalDocument({
          encryptedFormData: encryptFormData({
            formType: 'W8_BEN',
            submitterType: 'Individual',
            email: 'jane@example.com',
            signer: { firstName: 'Jane', middleName: '', lastName: 'Doe' },
            beneficialOwner: { firstName: 'Jane', middleName: '', lastName: 'Doe' },
            taxpayerIdentificationNumberForeign: 'FR123456789',
            residenceAddress: {
              country: 'fr',
              structured: { address1: '2 Rue de Paris', city: 'Paris', zone: 'IDF', postalCode: '75001' },
            },
          }),
        }),
      );

      expect(identity).to.deep.equal({
        formType: 'W8_BEN',
        individualName: 'Jane Doe',
        entityName: 'Jane Doe',
        address: {
          address1: '2 Rue de Paris',
          address2: null,
          city: 'Paris',
          zone: 'IDF',
          postalCode: '75001',
          country: 'FR',
        },
        country: 'FR',
        email: 'jane@example.com',
      });
    });

    it('normalizes a W8-BEN-E Open Collective payload', () => {
      const identity = getLegalDocumentIdentity(
        buildLegalDocument({
          encryptedFormData: encryptFormData({
            formType: 'W8_BEN_E',
            submitterType: 'Business',
            email: 'contact@foreign.example',
            signer: { firstName: 'John', middleName: '', lastName: 'Smith' },
            businessName: 'Foreign LLC',
            taxpayerIdentificationNumberForeign: 'DE123456789',
            businessAddress: {
              country: 'DE',
              structured: { address1: 'Street 1', city: 'Berlin', postalCode: '10115' },
            },
          }),
        }),
      );

      expect(identity).to.deep.equal({
        formType: 'W8_BEN_E',
        individualName: 'John Smith',
        entityName: 'Foreign LLC',
        address: {
          address1: 'Street 1',
          address2: null,
          city: 'Berlin',
          zone: null,
          postalCode: '10115',
          country: 'DE',
        },
        country: 'DE',
        email: 'contact@foreign.example',
      });
    });

    it('never exposes tax IDs in the normalized identity', () => {
      const identity = getLegalDocumentIdentity(
        buildLegalDocument({
          encryptedFormData: encryptFormData({
            formType: 'W9',
            email: 'jane@example.com',
            signer: { firstName: 'Jane', lastName: 'Doe' },
            taxIdNumber: '12-3456789',
            location: { country: 'US', structured: { city: 'Boston', postalCode: '02108' } },
          }),
        }),
      );

      expect(identity).to.not.have.property('taxIdNumber');
      expect(JSON.stringify(identity)).to.not.include('12-3456789');
    });

    it('ignores DROPBOX_FORMS documents even when the payload is an Open Collective form', () => {
      const identity = getLegalDocumentIdentity(
        buildLegalDocument(
          {
            encryptedFormData: encryptFormData({
              formType: 'W9',
              email: 'jane@example.com',
              signer: { firstName: 'Jane', lastName: 'Doe' },
              businessName: 'Acme Inc',
              location: { country: 'US', structured: { city: 'Boston', postalCode: '02108' } },
            }),
          },
          { service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS },
        ),
      );

      expect(identity).to.be.null;
    });

    it('ignores documents carrying a legacy HelloWorks instance', () => {
      const identity = getLegalDocumentIdentity(
        buildLegalDocument({
          helloWorks: { instance: { id: 'instance-id' } },
          encryptedFormData: encryptFormData({
            formType: 'W9',
            email: 'jane@example.com',
            signer: { firstName: 'Jane', lastName: 'Doe' },
            businessName: 'Acme Inc',
            location: { country: 'US', structured: { city: 'Boston', postalCode: '02108' } },
          }),
        }),
      );

      expect(identity).to.be.null;
    });
  });

  describe('getLegalDocumentNameMismatchDetails', () => {
    it('ignores missing names', () => {
      expect(getLegalDocumentNameMismatchDetails(buildIdentity(), 'Acme Inc')).to.be.null;
      expect(getLegalDocumentNameMismatchDetails(buildIdentity({ individualName: 'Jane Doe' }), null)).to.be.null;
    });

    it('returns null when the form name matches the payee name', () => {
      expect(getLegalDocumentNameMismatchDetails(buildIdentity({ individualName: 'Jane Doe' }), 'Jane Doe')).to.be.null;
      // Reversed names and accents are handled by isAccountHolderNameAndLegalNameMatch
      expect(getLegalDocumentNameMismatchDetails(buildIdentity({ individualName: 'Jane Doe' }), 'Doe Jane')).to.be.null;
      expect(
        getLegalDocumentNameMismatchDetails(
          buildIdentity({ individualName: 'François Dêaccènt' }),
          'Francois DeAccent',
        ),
      ).to.be.null;
    });

    it('returns null when either the individual or the entity name matches', () => {
      const identity = buildIdentity({ individualName: 'Jane Doe', entityName: 'Acme Inc' });
      expect(getLegalDocumentNameMismatchDetails(identity, 'Acme Inc')).to.be.null;
      expect(getLegalDocumentNameMismatchDetails(identity, 'Jane Doe')).to.be.null;
      expect(getLegalDocumentNameMismatchDetails(identity, 'Evil Corp')).to.not.be.null;
    });

    it('returns the form values and the payee name when they do not match', () => {
      expect(getLegalDocumentNameMismatchDetails(buildIdentity({ individualName: 'Jack London' }), 'Acme Inc')).to.eq(
        'The name on the legal document ("Jack London") does not match the payee name ("Acme Inc").',
      );
      expect(
        getLegalDocumentNameMismatchDetails(
          buildIdentity({ individualName: 'Jane Doe', entityName: 'Acme Inc' }),
          'Evil Corp',
        ),
      ).to.eq('The name on the legal document ("Jane Doe" / "Acme Inc") does not match the payee name ("Evil Corp").');
    });

    it('supports a custom account holder label', () => {
      expect(
        getLegalDocumentNameMismatchDetails(buildIdentity({ individualName: 'Jack London' }), 'Acme Inc', {
          nameLabel: 'payout method account holder name',
        }),
      ).to.eq(
        'The name on the legal document ("Jack London") does not match the payout method account holder name ("Acme Inc").',
      );
    });
  });

  describe('getLegalDocumentAddressMismatchDetails', () => {
    const buildIdentityWithAddress = (city: string, postalCode: string) =>
      buildIdentity({ country: 'FR', address: { ...buildIdentity().address, city, postalCode, country: 'FR' } });

    it('returns null when the city and postal code match, ignoring case and extra spaces', () => {
      expect(
        getLegalDocumentAddressMismatchDetails(buildIdentityWithAddress('Paris', '75001'), {
          city: '  paris ',
          postalCode: '75001',
        }),
      ).to.be.null;
    });

    it('returns null when the components cannot be compared', () => {
      expect(getLegalDocumentAddressMismatchDetails(buildIdentityWithAddress('Paris', '75001'), null)).to.be.null;
      expect(getLegalDocumentAddressMismatchDetails(buildIdentityWithAddress('Paris', '75001'), { city: 'Paris' })).to
        .be.null;
      expect(
        getLegalDocumentAddressMismatchDetails(
          buildIdentity({ address: { ...buildIdentity().address, city: null, postalCode: null } }),
          { city: 'Paris', postalCode: '75001' },
        ),
      ).to.be.null;
    });

    it('returns the form values and the payee values when the city or postal code differ', () => {
      const expected =
        'The legal document lists "Lyon, 75001 (FR)", while the payee is registered at "Paris, 75001 (FR)".';
      expect(
        getLegalDocumentAddressMismatchDetails(
          buildIdentityWithAddress('Lyon', '75001'),
          {
            city: 'Paris',
            postalCode: '75001',
          },
          'FR',
        ),
      ).to.eq(expected);
      expect(
        getLegalDocumentAddressMismatchDetails(
          buildIdentityWithAddress('Paris', '69001'),
          {
            city: 'Paris',
            postalCode: '75001',
          },
          'FR',
        ),
      ).to.eq('The legal document lists "Paris, 69001 (FR)", while the payee is registered at "Paris, 75001 (FR)".');
    });

    it('does not compare street addresses', () => {
      expect(
        getLegalDocumentAddressMismatchDetails(buildIdentityWithAddress('Paris', '75001'), {
          address1: '2 Other Street',
          city: 'Paris',
          postalCode: '75001',
        }),
      ).to.be.null;
    });

    it('supports a custom counterparty label', () => {
      expect(
        getLegalDocumentAddressMismatchDetails(
          buildIdentityWithAddress('Lyon', '75001'),
          { city: 'Paris', postalCode: '75001' },
          'FR',
          { counterpartyLabel: 'payout method' },
        ),
      ).to.eq(
        'The legal document lists "Lyon, 75001 (FR)", while the payout method is registered at "Paris, 75001 (FR)".',
      );
    });
  });

  describe('getLegalDocumentCountryMismatchDetails', () => {
    it('ignores missing countries', () => {
      expect(getLegalDocumentCountryMismatchDetails(buildIdentity(), 'FR')).to.be.null;
      expect(getLegalDocumentCountryMismatchDetails(buildIdentity({ country: 'FR' }), null)).to.be.null;
    });

    it('returns null when the countries match', () => {
      expect(getLegalDocumentCountryMismatchDetails(buildIdentity({ country: 'FR' }), 'FR')).to.be.null;
      expect(getLegalDocumentCountryMismatchDetails(buildIdentity({ country: 'FR' }), 'fr')).to.be.null;
    });

    it('returns the form country and the payee country when they differ', () => {
      expect(getLegalDocumentCountryMismatchDetails(buildIdentity({ country: 'US' }), 'FR')).to.eq(
        'The legal document lists the country "US", while the payee is registered in "FR".',
      );
    });

    it('supports a custom counterparty label', () => {
      expect(
        getLegalDocumentCountryMismatchDetails(buildIdentity({ country: 'US' }), 'FR', {
          counterpartyLabel: 'payout method',
        }),
      ).to.eq('The legal document lists the country "US", while the payout method is registered in "FR".');
    });
  });
});
