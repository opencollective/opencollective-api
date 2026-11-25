import { expect } from 'chai';

import { areNamesMatching, cleanName, getNameMatchLevel, NameMatchLevel } from '../../../server/lib/name-matching';

describe('server/lib/name-matching', () => {
  describe('cleanName', () => {
    it('trims and collapses whitespace', () => {
      expect(cleanName('  John   Smith ')).to.eq('John Smith');
      expect(cleanName('John  \tSmith')).to.eq('John Smith');
    });
  });

  describe('areNamesMatching', () => {
    it('ignores case, accents, punctuation, extra spaces and order', () => {
      expect(areNamesMatching('François  Dêaccènt', 'francois deaccent')).to.be.true;
      expect(areNamesMatching('Evil Corp, Inc', 'Evil Corp, Inc.')).to.be.true;
      expect(areNamesMatching('Piouffle, Benjamin', 'Benjamin Piouffle')).to.be.true;
      expect(areNamesMatching("Conan O'Brien", 'Conan OBrien')).to.be.true;
      expect(areNamesMatching('Jean-Luc Picard', 'Jean Luc Picard')).to.be.true;
      expect(areNamesMatching('JHipster Inc. 501(c)(3)', 'JHipster Inc.')).to.be.true;
    });

    it('accepts partial matches of at least two words', () => {
      expect(areNamesMatching('John Smith', 'John Michael Smith')).to.be.true;
      expect(areNamesMatching('John Michael Smith', 'Smith John')).to.be.true;
      expect(areNamesMatching('J. Smith', 'John Smith')).to.be.true;
      expect(areNamesMatching('John Smith', 'J. Smith')).to.be.true;
      expect(areNamesMatching('John M Smith', 'J Michael Smith')).to.be.true;
      expect(areNamesMatching('John M Smith', 'John Michael Smith')).to.be.true;
      expect(areNamesMatching('John J Smith', 'J James Smith')).to.be.true;
      expect(areNamesMatching('J.R.R. Tolkien', 'John Ronald Reuel Tolkien')).to.be.true;
      expect(areNamesMatching('John Ronald Reuel Tolkien', 'J.R.R. Tolkien')).to.be.true;
    });

    it('rejects mismatches', () => {
      expect(areNamesMatching('John Smith', 'John Doe')).to.be.false;
      expect(areNamesMatching('John', 'John Smith')).to.be.false;
      expect(areNamesMatching('Smith', 'John Smith')).to.be.false;
      expect(areNamesMatching('John Smith', 'Jon Smith')).to.be.false;
      expect(areNamesMatching('John Smith', 'Smith Smith')).to.be.false;
      expect(areNamesMatching('J S', 'John Smith')).to.be.false;
      expect(areNamesMatching('Studio 1', 'Studio 100')).to.be.false;
      expect(areNamesMatching('Studio 100', 'Studio 1')).to.be.false;
      expect(areNamesMatching('John Smith', 'J S')).to.be.false;
    });

    it('keeps combining marks of non-Latin scripts', () => {
      expect(areNamesMatching('शिव कुमार', 'शिव कुमार')).to.be.true;
      expect(getNameMatchLevel('रवि शर्मा', 'रवी शर्मा')).to.eq(NameMatchLevel.NONE);
    });

    it('does not blow up on adversarial names', () => {
      const start = Date.now();
      expect(areNamesMatching(`Smith ${'J '.repeat(15)}Zebra`, `Smith ${'John '.repeat(15)}Other`)).to.be.false;
      expect(areNamesMatching(`Smith ${'J '.repeat(15)}`, `Smith ${'John '.repeat(15)}`)).to.be.true;
      expect(Date.now() - start).to.be.lessThan(500);
    });

    it('limits extra words and ignores generic words as anchors', () => {
      expect(areNamesMatching('John Smith', 'Mallory Jones John Smith')).to.be.true; // 2 extra words is the limit
      expect(areNamesMatching('John Smith', 'Mallory Jones Anne John Smith')).to.be.false;
      expect(areNamesMatching('John Smith', 'Mallory John Smith')).to.be.true;
      expect(areNamesMatching('A LLC', 'Anything Else LLC')).to.be.false;
      expect(areNamesMatching('Mr Smith', 'Mr John Smith')).to.be.true;
      expect(areNamesMatching('de la', 'Juan de la Cruz')).to.be.false;
      expect(areNamesMatching('Dr J', 'Dr Jane Doe')).to.be.false;
    });

    it('does not treat single CJK characters as initials', () => {
      expect(areNamesMatching('王 小明', '王五 小明')).to.be.false;
    });

    it('folds letters that do not decompose and ignores invisible characters', () => {
      expect(getNameMatchLevel('Straße Müller', 'Strasse Muller')).to.eq(NameMatchLevel.EXACT);
      expect(getNameMatchLevel('Søren Łukasz', 'Soren Lukasz')).to.eq(NameMatchLevel.EXACT);
      expect(getNameMatchLevel('Ja\u00ADne Doe', 'Jane Doe')).to.eq(NameMatchLevel.EXACT);
      expect(getNameMatchLevel('مُحَمَّد علي', 'محمد علي')).to.eq(NameMatchLevel.EXACT);
    });

    it('only compares for equality names with too many words', () => {
      const longName = 'Smith '.repeat(30).trim();
      expect(areNamesMatching(longName, longName)).to.be.true;
      expect(areNamesMatching(longName, `${longName} Jones`)).to.be.false;
    });

    it('matches identical names made only of initials or generic words', () => {
      expect(areNamesMatching('J S', 'j. s.')).to.be.true;
      expect(areNamesMatching('Mr Dr', 'Dr Mr')).to.be.true;
    });

    it('handles single words and empty values', () => {
      expect(areNamesMatching('François', 'Francois')).to.be.true;
      expect(areNamesMatching('Sudharaka', 'Palamakumbura Sudharaka')).to.be.false;
      expect(areNamesMatching('', 'John Smith')).to.be.false;
      expect(areNamesMatching(null, undefined)).to.be.false;
    });
  });

  describe('getNameMatchLevel', () => {
    it('distinguishes exact and partial matches', () => {
      expect(getNameMatchLevel('François  Dêaccènt', 'deaccent, francois')).to.eq(NameMatchLevel.EXACT);
      expect(getNameMatchLevel('John Smith', 'John Michael Smith')).to.eq(NameMatchLevel.PARTIAL);
      expect(getNameMatchLevel('J. Smith', 'John Smith')).to.eq(NameMatchLevel.PARTIAL);
      expect(getNameMatchLevel('John Smith', 'J. Smith')).to.eq(NameMatchLevel.PARTIAL);
      expect(getNameMatchLevel('J S', 'John Smith')).to.eq(NameMatchLevel.NONE);
      expect(getNameMatchLevel('John Smith', 'John Doe')).to.eq(NameMatchLevel.NONE);
      expect(getNameMatchLevel('', 'John Doe')).to.eq(NameMatchLevel.NONE);
    });
  });
});
