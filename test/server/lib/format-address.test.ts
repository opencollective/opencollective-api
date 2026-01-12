import { expect } from 'chai';

import { formatAddress } from '../../../server/lib/format-address';

describe('server/lib/format-address', () => {
  describe('formatAddress', () => {
    describe('returns null for missing data', () => {
      it('returns null when structured is undefined', async () => {
        const result = await formatAddress({ country: 'US' });
        expect(result).to.be.null;
      });

      it('returns null when structured is null', async () => {
        const result = await formatAddress({ country: 'US', structured: null });
        expect(result).to.be.null;
      });
    });

    describe('US addresses', () => {
      it('formats a complete US address', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '123 Main Street',
            address2: 'Suite 100',
            city: 'San Francisco',
            zone: 'CA',
            postalCode: '94102',
          },
        });
        expect(result).to.equal('123 Main Street, Suite 100, San Francisco California 94102');
      });

      it('formats a US address without address2', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '456 Oak Avenue',
            city: 'New York',
            zone: 'NY',
            postalCode: '10001',
          },
        });
        expect(result).to.equal('456 Oak Avenue, New York New York 10001');
      });

      it('formats a US address with minimal fields', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '789 Pine Road',
            city: 'Boston',
          },
        });
        expect(result).to.equal('789 Pine Road, Boston');
      });
    });

    describe('international addresses', () => {
      it('formats a French address', async () => {
        const result = await formatAddress({
          country: 'FR',
          structured: {
            address1: '15 Rue de la Paix',
            city: 'Paris',
            postalCode: '75002',
          },
        });
        expect(result).to.equal('15 Rue de la Paix, 75002 Paris');
      });

      it('formats a German address', async () => {
        const result = await formatAddress({
          country: 'DE',
          structured: {
            address1: 'Alexanderplatz 1',
            city: 'Berlin',
            zone: 'BE',
            postalCode: '10178',
          },
        });
        expect(result).to.equal('Alexanderplatz 1, 10178 Berlin');
      });

      it('formats a UK address', async () => {
        const result = await formatAddress({
          country: 'GB',
          structured: {
            address1: '221B Baker Street',
            city: 'London',
            postalCode: 'NW1 6XE',
          },
        });
        expect(result).to.equal('221B Baker Street, London, NW1 6XE');
      });

      it('formats a Belgian address', async () => {
        const result = await formatAddress({
          country: 'BE',
          structured: {
            address1: 'Grand Place 1',
            city: 'Brussels',
            postalCode: '1000',
          },
        });
        expect(result).to.equal('Grand Place 1, 1000 Brussels');
      });

      it('formats a Spanish address', async () => {
        const result = await formatAddress({
          country: 'ES',
          structured: {
            address1: 'Calle Gran Vía 28',
            city: 'Madrid',
            zone: 'M',
            postalCode: '28013',
          },
        });
        expect(result).to.equal('Calle Gran Vía 28, 28013 Madrid, Madrid Province');
      });

      it('formats a Dutch address', async () => {
        const result = await formatAddress({
          country: 'NL',
          structured: {
            address1: 'Dam 1',
            city: 'Amsterdam',
            postalCode: '1012 JS',
          },
        });
        expect(result).to.equal('Dam 1, 1012 JS Amsterdam');
      });

      it('formats an Israeli address', async () => {
        const result = await formatAddress({
          country: 'IL',
          structured: {
            address1: 'Rothschild Boulevard 1',
            city: 'Tel Aviv',
            postalCode: '6688101',
          },
        });
        expect(result).to.equal('Rothschild Boulevard 1, 6688101 Tel Aviv');
      });

      it('formats a Canadian address', async () => {
        const result = await formatAddress({
          country: 'CA',
          structured: {
            address1: '350 Fifth Avenue',
            city: 'Toronto',
            zone: 'ON',
            postalCode: 'M5V 1E3',
          },
        });
        expect(result).to.equal('350 Fifth Avenue, Toronto Ontario M5V 1E3');
      });

      it('formats a Swedish address', async () => {
        const result = await formatAddress({
          country: 'SE',
          structured: {
            address1: 'Drottninggatan 53',
            city: 'Stockholm',
            postalCode: '111 21',
          },
        });
        expect(result).to.equal('Drottninggatan 53, 111 21 Stockholm');
      });

      it('formats a Brazilian address', async () => {
        const result = await formatAddress({
          country: 'BR',
          structured: {
            address1: 'Avenida Paulista 1000',
            city: 'São Paulo',
            zone: 'SP',
            postalCode: '01310-100',
          },
        });
        expect(result).to.equal('Avenida Paulista 1000, 01310-100 São Paulo São Paulo');
      });

      it('formats an Indian address', async () => {
        const result = await formatAddress({
          country: 'IN',
          structured: {
            address1: 'Connaught Place',
            city: 'New Delhi',
            zone: 'DL',
            postalCode: '110001',
          },
        });
        expect(result).to.equal('Connaught Place, 110001 New Delhi Delhi');
      });
    });

    describe('includeCountry option', () => {
      it('appends country name when includeCountry is true', async () => {
        const result = await formatAddress(
          {
            country: 'FR',
            structured: {
              address1: '15 Rue de la Paix',
              city: 'Paris',
              postalCode: '75002',
            },
          },
          { includeCountry: true },
        );
        expect(result).to.equal('15 Rue de la Paix, 75002 Paris, France');
      });

      it('does not include country when includeCountry is false', async () => {
        const result = await formatAddress(
          {
            country: 'FR',
            structured: {
              address1: '15 Rue de la Paix',
              city: 'Paris',
              postalCode: '75002',
            },
          },
          { includeCountry: false },
        );
        expect(result).to.equal('15 Rue de la Paix, 75002 Paris');
      });
    });

    describe('lineDivider option', () => {
      it('uses comma divider by default', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '123 Main Street',
            city: 'San Francisco',
            zone: 'CA',
            postalCode: '94102',
          },
        });
        expect(result).to.equal('123 Main Street, San Francisco California 94102');
      });

      it('uses newline divider when specified', async () => {
        const result = await formatAddress(
          {
            country: 'US',
            structured: {
              address1: '123 Main Street',
              city: 'San Francisco',
              zone: 'CA',
              postalCode: '94102',
            },
          },
          { lineDivider: '\n' },
        );
        expect(result).to.equal('123 Main Street\nSan Francisco California 94102');
      });
    });

    describe('edge cases', () => {
      it('handles empty string fields', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '123 Main Street',
            address2: '',
            city: 'Boston',
            zone: '',
            postalCode: '',
          },
        });
        expect(result).to.equal('123 Main Street, Boston');
      });

      it('handles address with only address1', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '123 Main Street',
          },
        });
        expect(result).to.equal('123 Main Street');
      });
    });
  });
});
