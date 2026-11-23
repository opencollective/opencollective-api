import { expect } from 'chai';

import { getStandardizedDataFromOCLegalDocumentData } from '../../../../server/lib/tax-forms/opencollective';
import { TaxFormCSVColumns } from '../../../../server/lib/tax-forms/types';

describe('server/lib/tax-forms/opencollective', () => {
  describe('getStandardizedDataFromOCLegalDocumentData', () => {
    describe('W8_BEN', () => {
      const baseW8Ben = {
        formType: 'W8_BEN',
        signer: { firstName: 'Jane', lastName: 'Doe' },
        beneficialOwner: { firstName: 'Jane', lastName: 'Doe' },
      };

      it('exports the foreign TIN with the Foreign type when both a foreign and a US TIN are provided', () => {
        const row = getStandardizedDataFromOCLegalDocumentData({
          ...baseW8Ben,
          taxpayerIdentificationNumberTypeUS: 'ITIN',
          taxpayerIdentificationNumberUS: '912-34-5678',
          taxpayerIdentificationNumberForeign: 'FR123',
        } as Parameters<typeof getStandardizedDataFromOCLegalDocumentData>[0]);

        expect(row[TaxFormCSVColumns.TAX_ID_TYPE]).to.equal('Foreign');
        expect(row[TaxFormCSVColumns.TAX_ID]).to.equal('FR123');
      });

      it('exports the US TIN with its type when no foreign TIN is provided', () => {
        const row = getStandardizedDataFromOCLegalDocumentData({
          ...baseW8Ben,
          taxpayerIdentificationNumberTypeUS: 'SSN',
          taxpayerIdentificationNumberUS: '123-45-6789',
          taxpayerIdentificationNumberForeign: '',
        } as Parameters<typeof getStandardizedDataFromOCLegalDocumentData>[0]);

        expect(row[TaxFormCSVColumns.TAX_ID_TYPE]).to.equal('SSN');
        expect(row[TaxFormCSVColumns.TAX_ID]).to.equal('123-45-6789');
      });
    });
  });
});
