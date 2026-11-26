import { expect } from 'chai';

import { areNamesMatching, cleanName } from '../../../server/lib/name-matching';

describe('server/lib/name-matching', () => {
  describe('cleanName', () => {
    it('trims and collapses whitespace', () => {
      expect(cleanName('  John   Smith ')).to.eq('John Smith');
      expect(cleanName('John  \tSmith')).to.eq('John Smith');
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

    it('rejects partial matches (extra or missing words)', () => {
      expect(areNamesMatching('John Smith', 'John Michael Smith')).to.be.false;
      expect(areNamesMatching('John Michael Smith', 'Smith John')).to.be.false;
      expect(areNamesMatching('John', 'John Smith')).to.be.false;
      expect(areNamesMatching('Sudharaka', 'Palamakumbura Sudharaka')).to.be.false;
      expect(areNamesMatching('Mr Smith', 'Mr John Smith')).to.be.false;
      expect(areNamesMatching('Acme Inc', 'Acme Inc Holdings')).to.be.false;
    });

    it('rejects abbreviated names', () => {
      expect(areNamesMatching('J. Smith', 'John Smith')).to.be.false;
      expect(areNamesMatching('John Smith', 'J. Smith')).to.be.false;
      expect(areNamesMatching('John M Smith', 'John Michael Smith')).to.be.false;
      expect(areNamesMatching('J.R.R. Tolkien', 'John Ronald Reuel Tolkien')).to.be.false;
      expect(areNamesMatching('J S', 'John Smith')).to.be.false;
    });

    it('rejects mismatches', () => {
      expect(areNamesMatching('John Smith', 'John Doe')).to.be.false;
      expect(areNamesMatching('John Smith', 'Jon Smith')).to.be.false;
      expect(areNamesMatching('John Smith', 'Smith Smith')).to.be.false;
      expect(areNamesMatching('Studio 1', 'Studio 100')).to.be.false;
    });

    it('keeps combining marks of non-Latin scripts', () => {
      expect(areNamesMatching('शिव कुमार', 'शिव कुमार')).to.be.true;
      expect(areNamesMatching('रवि शर्मा', 'रवी शर्मा')).to.be.false;
      expect(areNamesMatching('王 小明', '王五 小明')).to.be.false;
    });

    it('folds letters that do not decompose and ignores invisible characters', () => {
      expect(areNamesMatching('Straße Müller', 'Strasse Muller')).to.be.true;
      expect(areNamesMatching('Søren Łukasz', 'Soren Lukasz')).to.be.true;
      expect(areNamesMatching('Ja­ne Doe', 'Jane Doe')).to.be.true;
      expect(areNamesMatching('مُحَمَّد علي', 'محمد علي')).to.be.true;
    });

    it('handles single words and empty values', () => {
      expect(areNamesMatching('François', 'Francois')).to.be.true;
      expect(areNamesMatching('J S', 'j. s.')).to.be.true;
      expect(areNamesMatching('', 'John Smith')).to.be.false;
      expect(areNamesMatching('...', '!!!')).to.be.false;
      expect(areNamesMatching(null, undefined)).to.be.false;
    });
  });
});
