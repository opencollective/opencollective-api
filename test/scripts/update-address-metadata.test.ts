/* eslint-disable camelcase -- `sub_regions` is the field name of the address metadata */
import { expect } from 'chai';

import { applyOverrides } from '../../scripts/update-address-metadata';

const subRegions = (...keys: string[]) => keys.map(key => ({ key, name: { default: `Region ${key}` } }));

// Google's current CN keys, and the lib-address 0.7.0 keys they are pinned to (same order)
const CN_SOURCE_KEYS =
  'AH MO BJ CQ FJ GS GD GX GZ HI HE HA HL HB HN JL JS JX LN NM NX QH SD SX SN SH SC TW TJ XZ HK XJ YN ZJ'.split(' ');
const CN_LEGACY_KEYS =
  '34 92 11 50 35 62 44 45 52 46 13 41 23 42 43 22 32 36 21 15 64 63 37 14 61 31 51 71 12 54 91 65 53 33'.split(' ');

/** Minimal source data with every country that has an override, using the keys of Google's current data */
const sourceCountries = () => [
  { key: 'AR', zip: '[A-HJ-NP-Z]\\d{4}[A-Z]{3}' },
  { key: 'CN', sub_regions: subRegions(...CN_SOURCE_KEYS) },
  { key: 'IN', sub_regions: subRegions('AN', 'CG', 'DL', 'OD', 'TS', 'UK') },
  { key: 'US', zip: '(\\d{5})(?:[ \\-](\\d{4}))?', sub_regions: subRegions('CA', 'NY') },
];

const getKeys = (countries: ReturnType<typeof applyOverrides>, countryCode: string) =>
  countries.find(country => country.key === countryCode).sub_regions.map(subRegion => subRegion.key);

describe('scripts/update-address-metadata', () => {
  describe('applyOverrides', () => {
    it('keeps the sub-region keys used by the frontend when the source renames them', () => {
      const result = applyOverrides(sourceCountries());
      expect(getKeys(result, 'IN')).to.deep.equal(['AN', 'CT', 'DL', 'OR', 'TG', 'UT']);
      expect(getKeys(result, 'CN')).to.deep.equal(CN_LEGACY_KEYS);
      expect(result.find(country => country.key === 'IN').sub_regions[1].name.default).to.equal('Region CG');
    });

    it('is a no-op on data that already uses the legacy keys', () => {
      const once = applyOverrides(sourceCountries());
      expect(applyOverrides(once)).to.deep.equal(once);
    });

    it('overrides the Argentinian zip format and leaves other countries untouched', () => {
      const result = applyOverrides(sourceCountries());
      expect(result.find(country => country.key === 'AR').zip).to.equal('((?:[A-HJ-NP-Z])?\\d{4})([A-Z]{3})?');
      expect(result.find(country => country.key === 'US')).to.deep.equal(sourceCountries()[3]);
    });

    it('throws when an overridden country is missing from the source', () => {
      const countries = sourceCountries().filter(country => country.key !== 'AR');
      expect(() => applyOverrides(countries)).to.throw('Override for AR: country not found in the source data');
    });

    it('throws when a legacy key override no longer matches a sub-region', () => {
      const countries = sourceCountries().map(country =>
        country.key === 'IN' ? { ...country, sub_regions: subRegions('AN', 'CG', 'DL', 'OD', 'TS') } : country,
      );
      expect(() => applyOverrides(countries)).to.throw(
        'Legacy key override IN/UK -> UT: no sub-region with either key',
      );
    });

    it('throws when the source uses both the new and the legacy key', () => {
      const countries = sourceCountries().map(country =>
        country.key === 'IN' ? { ...country, sub_regions: subRegions('CG', 'CT', 'OD', 'TS', 'UK') } : country,
      );
      expect(() => applyOverrides(countries)).to.throw(
        'Legacy key override IN/CG -> CT: both keys exist in the source',
      );
    });
  });
});
