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
        expect(result).to.equal('123 Main Street, Suite 100, San Francisco, California 94102');
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
        expect(result).to.equal('456 Oak Avenue, New York, New York 10001');
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
        expect(result).to.equal('Calle Gran Vía 28, 28013 Madrid Madrid');
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
        expect(result).to.equal('Rothschild Boulevard 1, Tel Aviv 6688101');
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
        expect(result).to.equal('Drottninggatan 53, SE-111 21 Stockholm');
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
        expect(result).to.equal('Avenida Paulista 1000, São Paulo-São Paulo, 01310-100');
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
        expect(result).to.equal('Connaught Place, New Delhi 110001, Delhi');
      });

      it('formats a New Zealand address without a dependent locality', async () => {
        const result = await formatAddress({
          country: 'NZ',
          structured: { address1: '1 Queen Street', city: 'Auckland', postalCode: '1010' },
        });
        expect(result).to.equal('1 Queen Street, Auckland 1010');
      });

      it('formats a Chinese address with the zone codes used by the frontend', async () => {
        const result = await formatAddress({
          country: 'CN',
          structured: { address1: '1 Chang An Avenue', city: 'Dongcheng', zone: '11', postalCode: '100000' },
        });
        expect(result).to.equal('100000, 北京市Dongcheng, 1 Chang An Avenue');
      });

      it('accepts the short forms of Argentinian postal codes', async () => {
        const address = { address1: 'Av. Corrientes 1', city: 'Buenos Aires', zone: 'C' };
        for (const postalCode of ['1043', 'C1043', 'C1043AAZ']) {
          const result = await formatAddress({ country: 'AR', structured: { ...address, postalCode } });
          expect(result).to.equal(`Av. Corrientes 1, ${postalCode} Buenos Aires, Ciudad Autónoma de Buenos Aires`);
        }
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
        expect(result).to.equal('15 Rue de la Paix, 75002 Paris, FRANCE');
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
        expect(result).to.equal('123 Main Street, San Francisco, California 94102');
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
        expect(result).to.equal('123 Main Street\nSan Francisco, California 94102');
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

      it('normalizes state names to subdivision codes', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: {
            address1: '123 Main Street',
            city: 'Los Angeles',
            zone: 'California',
            postalCode: '90001',
          },
        });
        expect(result).to.equal('123 Main Street, Los Angeles, California 90001');
      });

      it('normalizes Australian state names to subdivision codes', async () => {
        const result = await formatAddress({
          country: 'AU',
          structured: {
            address1: '123 George Street',
            city: 'Sydney',
            zone: 'New South Wales',
            postalCode: '2000',
          },
        });
        expect(result).to.equal('123 George Street, Sydney New South Wales 2000');
      });

      it('normalizes latin subdivision names but displays the local name', async () => {
        const result = await formatAddress({
          country: 'AE',
          structured: { address1: 'Sheikh Zayed Road', zone: 'Dubai' },
        });
        expect(result).to.equal('Sheikh Zayed Road, دبي');
      });

      it('follows the country line order', async () => {
        const result = await formatAddress(
          {
            country: 'JP',
            structured: { address1: '1-1 Chiyoda', city: 'Chiyoda-ku', zone: 'Tokyo', postalCode: '100-0001' },
          },
          { lineDivider: '\n' },
        );
        expect(result).to.equal('〒100-0001\n東京都\n1-1 Chiyoda');
      });
    });

    describe('missing optional fields', () => {
      it('omits the state when there is no zone, instead of printing "null"', async () => {
        const dublin = { country: 'IE', structured: { address1: '1 Main St', city: 'Dublin', postalCode: 'D02 X285' } };
        expect(await formatAddress(dublin)).to.equal('1 Main St, Dublin, D02 X285');
        expect(await formatAddress({ ...dublin, structured: { ...dublin.structured, zone: null } })).to.equal(
          '1 Main St, Dublin, D02 X285',
        );
        const buenosAires = {
          country: 'AR',
          structured: { address1: 'Av. Corrientes 1', city: 'Buenos Aires', postalCode: 'C1043' },
        };
        expect(await formatAddress(buenosAires)).to.equal('Av. Corrientes 1, C1043 Buenos Aires');
      });
    });

    describe('fallback formatting when the address is not valid for the country', () => {
      const sanFrancisco = { address1: '123 Main Street', city: 'San Francisco', zone: 'CA' };

      it('falls back when the zip does not match the country format', async () => {
        const result = await formatAddress({ country: 'US', structured: { ...sanFrancisco, postalCode: 'ABC' } });
        expect(result).to.equal('123 Main Street, San Francisco CA ABC');
      });

      it('falls back when the zip does not match the subdivision', async () => {
        const result = await formatAddress({ country: 'US', structured: { ...sanFrancisco, postalCode: '10001' } });
        expect(result).to.equal('123 Main Street, San Francisco CA 10001');
      });

      it('falls back when a required subdivision is unknown', async () => {
        const result = await formatAddress({
          country: 'US',
          structured: { ...sanFrancisco, zone: 'Atlantis', postalCode: '94102' },
        });
        expect(result).to.equal('123 Main Street, San Francisco Atlantis 94102');
      });

      it('falls back when the country is unknown', async () => {
        const result = await formatAddress({
          country: 'XX',
          structured: { address1: '1 Nowhere Lane', city: 'Atlantis', postalCode: '12345' },
        });
        expect(result).to.equal('1 Nowhere Lane, Atlantis 12345');
      });
    });
  });
});
