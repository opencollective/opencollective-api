import { expect } from 'chai';

import { containsProtectedBrandName } from '../../../server/lib/string-utils';

describe('server/lib/string-utils', () => {
  describe('containsProtectedBrandName', () => {
    it('detects protected brand names in slugs', () => {
      expect(containsProtectedBrandName('opencollective')).to.be.true;
      expect(containsProtectedBrandName('open-collective')).to.be.true;
      expect(containsProtectedBrandName('open_collective')).to.be.true;
      expect(containsProtectedBrandName('opencollective1')).to.be.true;
      expect(containsProtectedBrandName('super-open-collective')).to.be.true;
    });

    it('detects protected brand names in names', () => {
      // OC
      expect(containsProtectedBrandName('opencollective')).to.be.true;
      expect(containsProtectedBrandName('opencolllective')).to.be.true;
      expect(containsProtectedBrandName('OpenCollective')).to.be.true;
      expect(containsProtectedBrandName('open coll ecti ve')).to.be.true;
      expect(containsProtectedBrandName('0pen Collective')).to.be.true;
      expect(containsProtectedBrandName('opén collective')).to.be.true;

      // Ofitech
      expect(containsProtectedBrandName('ofitech')).to.be.true;
      expect(containsProtectedBrandName('Ofitech')).to.be.true;
      expect(containsProtectedBrandName('ofi tech')).to.be.true;
      expect(containsProtectedBrandName('0fi tech')).to.be.true;
      expect(containsProtectedBrandName('ofí tech')).to.be.true;

      // Ofico
      expect(containsProtectedBrandName('ofico')).to.be.true;
      expect(containsProtectedBrandName('Ofico')).to.be.true;
      expect(containsProtectedBrandName('    0fic02   ')).to.be.true;
      expect(containsProtectedBrandName('ofi co')).to.be.true;
      expect(containsProtectedBrandName('0fi co')).to.be.true;
    });

    it('does not trigger false positives', () => {
      expect(containsProtectedBrandName('babel')).to.be.false;
      expect(containsProtectedBrandName('Webpack Collective')).to.be.false;
      expect(containsProtectedBrandName('open-potatoes')).to.be.false;
      expect(containsProtectedBrandName('open-family-collective')).to.be.false;
      expect(containsProtectedBrandName('ofinew')).to.be.false;
      expect(containsProtectedBrandName('backyourstack')).to.be.false;
    });
  });
});
