import { expect } from 'chai';

import { normalizeZoneCode } from '../../../server/lib/normalize-zone';

describe('server/lib/normalize-zone', () => {
  describe('normalizeZoneCode', () => {
    it('returns null for empty zone', () => {
      expect(normalizeZoneCode('US', null)).to.be.null;
      expect(normalizeZoneCode('US', '')).to.be.null;
      expect(normalizeZoneCode('US', '   ')).to.be.null;
    });

    it('returns zone unchanged when country is missing', () => {
      expect(normalizeZoneCode(null, 'California')).to.equal('California');
    });

    it('keeps valid subdivision codes', () => {
      expect(normalizeZoneCode('US', 'CA')).to.equal('CA');
      expect(normalizeZoneCode('AU', 'NSW')).to.equal('NSW');
      expect(normalizeZoneCode('AE', 'DU')).to.equal('DU');
    });

    it('converts subdivision names to codes', () => {
      expect(normalizeZoneCode('US', 'California')).to.equal('CA');
      expect(normalizeZoneCode('AU', 'New South Wales')).to.equal('NSW');
      expect(normalizeZoneCode('CA', 'Ontario')).to.equal('ON');
    });

    it('matches names case-insensitively', () => {
      expect(normalizeZoneCode('US', 'california')).to.equal('CA');
      expect(normalizeZoneCode('AU', 'new south wales')).to.equal('NSW');
    });

    it('converts latin emirate names for AE', () => {
      expect(normalizeZoneCode('AE', 'Abu Dhabi')).to.equal('AZ');
      expect(normalizeZoneCode('AE', 'Dubai')).to.equal('DU');
    });

    it('returns the original value when no match exists', () => {
      expect(normalizeZoneCode('US', 'Not A State')).to.equal('Not A State');
      expect(normalizeZoneCode('FR', 'Ile-de-France')).to.equal('Ile-de-France');
    });
  });
});
