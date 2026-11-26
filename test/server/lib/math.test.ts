import { expect } from 'chai';

import { formatSize, toNegative } from '../../../server/lib/math';

describe('server/lib/math', () => {
  describe('#toNegative', () => {
    it('should convert positive numbers to negative', () => {
      expect(toNegative(10)).to.equal(-10);
    });
    it('should not do anything with negative numbers', () => {
      expect(toNegative(-10)).to.equal(-10);
    });
  });

  describe('#formatSize', () => {
    it('formats bytes, KB, MB and GB', () => {
      expect(formatSize(0)).to.equal('0 B');
      expect(formatSize(512)).to.equal('512 B');
      expect(formatSize(2048)).to.equal('2.0 KB');
      expect(formatSize(5 * 1024 * 1024)).to.equal('5.0 MB');
      expect(formatSize(2 * 1024 * 1024 * 1024)).to.equal('2.0 GB');
    });
  });
});
