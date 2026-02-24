/**
 * Tests for scripts/tax-forms/export-1099.ts generateExport function.
 * Covers OPENCOLLECTIVE (W8_BEN) and DROPBOX_FORMS (HelloWorks W9) entries.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import { parse } from 'csv-parse/sync';

import { generateExport } from '../../../scripts/tax-forms/export-1099';
import { TaxFormCSVColumns } from '../../../server/lib/tax-forms/types';
import LegalDocument, { LEGAL_DOCUMENT_SERVICE } from '../../../server/models/LegalDocument';

describe('scripts/tax-forms/export-1099', () => {
  describe('generateExport', () => {
    let outputDir: string;

    beforeEach(() => {
      outputDir = path.join(os.tmpdir(), `export-1099-test-${Date.now()}`);
      fs.mkdirSync(outputDir, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true });
      }
    });

    it('exports CSV with correct content for OPENCOLLECTIVE W8_BEN and DROPBOX_FORMS W9 entries', async () => {
      // 1st entry: OPENCOLLECTIVE service, W8_BEN form (decrypted formData from user)
      const w8BenFormData = {
        isUSPersonOrEntity: false,
        submitterType: 'Individual',
        formType: 'W8_BEN',
        email: 'test@opencollective.com',
        signer: { firstName: 'Benjamin', middleName: '', lastName: 'Piouffle' },
        isSigned: true,
        beneficialOwner: { firstName: 'Benjamin', middleName: '', lastName: 'Piouffle' },
        taxpayerIdentificationNumberTypeUS: null,
        taxpayerIdentificationNumberUS: '',
        taxpayerIdentificationNumberForeign: '0123456789123456',
        dateOfBirth: '1991-10-01',
        countryOfCitizenship: 'FR',
        residenceAddress: {
          country: 'FR',
          structured: {
            address1: 'Somewhere over the rainbow',
            postalCode: '13600',
            city: 'La Ciotat',
          },
        },
        mailingAddress: {
          country: '',
          structured: { address1: '', address2: '', city: '', zone: '', postalCode: '' },
        },
        hasConfirmedTOS: true,
        claimsSpecialRatesAndConditions: false,
        isSignerTheBeneficialOwner: true,
      };

      const encryptedW8Ben = LegalDocument.encrypt(Buffer.from(JSON.stringify(w8BenFormData))).toString('base64');

      // 2nd entry: DROPBOX_FORMS / HelloWorks W9 (Form_nRZrdh)
      const helloworksInstance = {
        /* eslint-disable camelcase */
        audit_trail_hash: 'xxxxxxxxxxxxxxxxxxxxxxx',
        data: {
          Form_nRZrdh: {
            field_ENxHCd: 'Yes',
            field_JI6gsq: 'Jack London',
            field_SXcrBL: '0123456789',
            field_bsHU5V: 'Burlington, VT, 05408',
            field_gwd8pa: 'john.meluso@uvm.edu',
            field_m4nLix: 'SSN',
            field_oU5IRt: 'Yes',
            field_pxvAbW: '0987654321',
            field_ruhFN4: 'Individual (or sole proprietor)',
            field_vBxRqQ: 'Jack London',
            field_y19HZi: 'Some address',
          },
        },
        document_hashes: { Form_nRZrdh: 'xxxxxxxxxxxxxx' },
        id: 'xxxxxxxxxxxxxx',
        metadata: {
          accountId: '4242',
          accountType: 'USER',
          adminEmails: 'test2@opencollective.com',
          email: 'test2@opencollective.com',
          userId: '4242',
          year: '2026',
        },
        mode: 'live',
        status: 'completed',
        workflow_id: 'MfmOZErmhz1qPgMp',
        /* eslint-enable camelcase */
      };

      const encryptedHelloworks = LegalDocument.encrypt(Buffer.from(JSON.stringify(helloworksInstance))).toString(
        'base64',
      );

      const recipients = [
        {
          name: 'Benjamin Piouffle',
          legalName: 'Benjamin Piouffle',
          service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
          profileUrl: 'https://opencollective.com/benjamin-collective',
          type: 'USER',
          country: 'FR',
          adminEmails: 'test@opencollective.com',
          documentPath: '',
          paid: 50000, // cents => $500.00
          document_id: 1001, // eslint-disable-line camelcase
          data: JSON.stringify({ encryptedFormData: encryptedW8Ben }),
        },
        {
          name: 'Jack London',
          legalName: 'Jack London',
          service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
          profileUrl: 'https://opencollective.com/jack-collective',
          type: 'USER',
          country: 'US',
          adminEmails: 'test2@opencollective.com',
          documentPath: 'US_TAX_FORM/2026/some-file.pdf',
          paid: 120000, // cents => $1,200.00
          document_id: 1002, // eslint-disable-line camelcase
          data: JSON.stringify({
            helloWorks: { instance: { id: 'xxxxxxxxxxx' } },
            encryptedFormData: encryptedHelloworks,
          }),
        },
      ];

      await generateExport('test-host', 2026, recipients, { outputDir });

      const csvPath = path.join(outputDir, 'test-host-2026', 'test-host-2026-tax-forms.csv');
      expect(fs.existsSync(csvPath), 'CSV file should be created').to.be.true;

      const csvContent = fs.readFileSync(csvPath, 'utf-8');
      const lines = csvContent.trim().split('\n');
      expect(lines.length, 'CSV should have header + 2 data rows').to.equal(3);

      const parsed = parse(csvContent, { columns: true, skip_empty_lines: true }); // eslint-disable-line camelcase
      expect(parsed.length).to.equal(2);

      const columns = Object.values(TaxFormCSVColumns);
      const headerLine = lines[0];
      columns.forEach(col => {
        expect(headerLine).to.include(col);
      });

      // Row 1: OPENCOLLECTIVE W8_BEN (Benjamin Piouffle)
      const row1 = parsed[0];
      expect(row1[TaxFormCSVColumns.RECIPIENT_NAME]).to.equal('Benjamin Piouffle');
      expect(row1[TaxFormCSVColumns.ACCOUNT]).to.equal('https://opencollective.com/benjamin-collective');
      expect(row1[TaxFormCSVColumns.TYPE]).to.equal('W8_BEN');
      expect(row1[TaxFormCSVColumns.ENTITY]).to.equal('Benjamin Piouffle');
      expect(row1[TaxFormCSVColumns.STATUS]).to.equal('Individual');
      expect(row1[TaxFormCSVColumns.TAX_ID_TYPE]).to.equal('Foreign');
      expect(row1[TaxFormCSVColumns.TAX_ID]).to.equal('0123456789123456');
      expect(row1[TaxFormCSVColumns.RECIPIENT_ADDRESS_1]).to.equal('Somewhere over the rainbow');
      expect(row1[TaxFormCSVColumns.RECIPIENT_ADDRESS_2]).to.equal('La Ciotat, 13600');
      expect(row1[TaxFormCSVColumns.RECIPIENT_COUNTRY]).to.equal('FR');
      expect(row1[TaxFormCSVColumns.RECIPIENT_EMAIL]).to.equal('test@opencollective.com');
      expect(row1[TaxFormCSVColumns.BOX_1_NONEMPLOYEE_COMPENSATION]).to.equal('$500.00');
      expect(row1[TaxFormCSVColumns.FILE]).to.equal('');
      expect(row1[TaxFormCSVColumns.DROPBOX_FORM_INSTANCE]).to.equal('');
      expect(row1[TaxFormCSVColumns.PLATFORM_ID]).to.equal('1001');

      // Row 2: DROPBOX_FORMS W9 (Jack London)
      const row2 = parsed[1];
      expect(row2[TaxFormCSVColumns.RECIPIENT_NAME]).to.equal('Jack London');
      expect(row2[TaxFormCSVColumns.ACCOUNT]).to.equal('https://opencollective.com/jack-collective');
      expect(row2[TaxFormCSVColumns.TYPE]).to.equal('W9');
      expect(row2[TaxFormCSVColumns.ENTITY]).to.equal('');
      expect(row2[TaxFormCSVColumns.STATUS]).to.equal('Individual (or sole proprietor)');
      expect(row2[TaxFormCSVColumns.TAX_ID_TYPE]).to.equal('SSN');
      expect(row2[TaxFormCSVColumns.TAX_ID]).to.equal('0123456789');
      expect(row2[TaxFormCSVColumns.RECIPIENT_ADDRESS_1]).to.equal('Some address');
      expect(row2[TaxFormCSVColumns.RECIPIENT_ADDRESS_2]).to.equal('Burlington, VT, 05408');
      expect(row2[TaxFormCSVColumns.RECIPIENT_COUNTRY]).to.equal('US');
      expect(row2[TaxFormCSVColumns.RECIPIENT_EMAIL]).to.equal('john.meluso@uvm.edu');
      expect(row2[TaxFormCSVColumns.BOX_1_NONEMPLOYEE_COMPENSATION]).to.equal('$1,200.00');
      expect(row2[TaxFormCSVColumns.FILE]).to.equal('US_TAX_FORM/2026/some-file.pdf');
      expect(row2[TaxFormCSVColumns.DROPBOX_FORM_INSTANCE]).to.equal('xxxxxxxxxxx');
      expect(row2[TaxFormCSVColumns.PLATFORM_ID]).to.equal('1002');
    });
  });
});
