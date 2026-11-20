/**
 * Regenerates `server/lib/address/countries.json`, the address metadata used by `server/lib/address`.
 * Only the fields read by `server/lib/address` and the first level of sub-regions are kept, and sub-regions are
 * flattened to `{ key, name, latin?, zip? }` (`latin` only when it differs from `name`).
 *
 * Translated sub-region names (e.g. Spanish provinces in Galician, Indian states in Hindi) are not kept: nothing
 * formats addresses in a language other than the local one yet. Email translations
 * (https://github.com/opencollective/opencollective/issues/4182) may need them back: fetch
 * `${GOOGLE_BASE_URL}/data/<country>/<sub-region>--<lang>` for each extra language listed in the country's `languages`.
 *
 * The file is written compact and then formatted with Prettier, which keeps short objects on a single line: each
 * sub-region is one line, so the monthly refresh (`.github/workflows/update-address-metadata.yml`) produces small diffs.
 *
 * A few local deviations from the source are applied on every run, see `COUNTRY_OVERRIDES` and
 * `LEGACY_SUB_REGION_KEYS`.
 *
 * Two sources are supported:
 *
 * - Google's address metadata service (https://chromium-i18n.appspot.com/ssl-address, the data behind
 *   https://github.com/google/libaddressinput). This is the default. The download logic mirrors lib-address's
 *   `scripts/download-data.ts` (https://github.com/LancelotP/lib-address/blob/v0.7.0/scripts/download-data.ts).
 *   Google's data changes over time, so refreshing from it can change how some addresses are formatted.
 *
 * - An extracted lib-address npm package (`npm pack lib-address@0.7.0 && tar -xzf lib-address-0.7.0.tgz`), which
 *   is what the checked-in file was generated from.
 *
 * Usage:
 *   npm run script scripts/update-address-metadata.ts
 *   npm run script scripts/update-address-metadata.ts -- /path/to/extracted/lib-address/package
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { format, resolveConfig } from 'prettier';

const GOOGLE_BASE_URL = 'https://chromium-i18n.appspot.com/ssl-address';
const OUTPUT = path.join(__dirname, '../server/lib/address/countries.json');

/** Sub-region as found in the sources: `name.default` is the local name, `name.latin` its transliteration */
type SubRegion = { key: string; name: { default: string; latin?: string }; zip?: string };

type Country = {
  key: string;
  name?: string;
  fmt?: string;
  require?: string;
  zip?: string;
  sub_regions?: SubRegion[];
};

// ---- Local overrides ----

/** Fields replaced in the source data. Each entry says why; drop it once the reason no longer holds. */
const COUNTRY_OVERRIDES: Record<string, Pick<Country, 'zip'>> = {
  // Google now only accepts the full 8-character CPA (C1043AAZ), but most people still write the 4-digit code (1043)
  // or the letter + 4-digit one (C1043). Keep accepting all three.
  AR: { zip: '((?:[A-HJ-NP-Z])?\\d{4})([A-Z]{3})?' },
};

/**
 * Sub-region keys kept at their previous value when the source renames them, as `{ country: { newKey: keptKey } }`.
 *
 * Zone codes are shared with the frontend, which still picks them from lib-address 0.7.0 (`lib/address.ts` in
 * opencollective-frontend) and clears a stored zone it does not know. `Collective.setLocation` stores what
 * `normalizeZoneCode` returns, so switching to the new keys here alone would wipe the zone of these locations the
 * next time they are edited. Rename on both sides at once, and migrate stored locations with
 * `scripts/fixes/normalize-location-zones.ts`, before removing an entry.
 */
const LEGACY_SUB_REGION_KEYS: Record<string, Record<string, string>> = {
  // ISO 3166-2:CN moved from numeric to letter codes
  CN: {
    AH: '34',
    MO: '92',
    BJ: '11',
    CQ: '50',
    FJ: '35',
    GS: '62',
    GD: '44',
    GX: '45',
    GZ: '52',
    HI: '46',
    HE: '13',
    HA: '41',
    HL: '23',
    HB: '42',
    HN: '43',
    JL: '22',
    JS: '32',
    JX: '36',
    LN: '21',
    NM: '15',
    NX: '64',
    QH: '63',
    SD: '37',
    SX: '14',
    SN: '61',
    SH: '31',
    SC: '51',
    TW: '71',
    TJ: '12',
    XZ: '54',
    HK: '91',
    XJ: '65',
    YN: '53',
    ZJ: '33',
  },
  // ISO 3166-2:IN renamed Chhattisgarh, Odisha, Telangana and Uttarakhand
  IN: { CG: 'CT', OD: 'OR', TS: 'TG', UK: 'UT' },
};

/**
 * Applies `COUNTRY_OVERRIDES` and `LEGACY_SUB_REGION_KEYS`.
 * Throws when an override no longer matches the data, so that a change in the source gets reviewed rather than
 * silently shadowed or reintroduced.
 */
export const applyOverrides = (countries: Country[]): Country[] => {
  const byKey = new Map(countries.map(country => [country.key, country]));
  for (const countryCode of [...Object.keys(COUNTRY_OVERRIDES), ...Object.keys(LEGACY_SUB_REGION_KEYS)]) {
    if (!byKey.has(countryCode)) {
      throw new Error(`Override for ${countryCode}: country not found in the source data`);
    }
  }

  return countries.map(country => {
    const legacyKeys = LEGACY_SUB_REGION_KEYS[country.key];
    if (!legacyKeys) {
      return { ...country, ...COUNTRY_OVERRIDES[country.key] };
    }

    const sourceKeys = new Set(country.sub_regions?.map(subRegion => subRegion.key));
    for (const [newKey, keptKey] of Object.entries(legacyKeys)) {
      if (!sourceKeys.has(newKey) && !sourceKeys.has(keptKey)) {
        throw new Error(`Legacy key override ${country.key}/${newKey} -> ${keptKey}: no sub-region with either key`);
      }
      if (sourceKeys.has(newKey) && sourceKeys.has(keptKey)) {
        throw new Error(`Legacy key override ${country.key}/${newKey} -> ${keptKey}: both keys exist in the source`);
      }
    }

    return {
      ...country,
      ...COUNTRY_OVERRIDES[country.key],
      // eslint-disable-next-line camelcase
      sub_regions: country.sub_regions?.map(subRegion => ({
        ...subRegion,
        key: legacyKeys[subRegion.key] ?? subRegion.key,
      })),
    };
  });
};

const trimCountry = (country: Country) => ({
  name: country.name,
  fmt: country.fmt,
  require: country.require,
  zip: country.zip,
  // eslint-disable-next-line camelcase
  sub_regions: country.sub_regions?.map(({ key, name, zip }) => ({
    key,
    name: name.default,
    latin: name.latin && name.latin !== name.default ? name.latin : undefined,
    zip,
  })),
});

// ---- Source: Google ----

type GoogleRegionData = {
  id: string;
  key: string;
  name?: string;
  lname?: string;
  isoid?: string;
  fmt?: string;
  require?: string;
  zip?: string;
  sub_keys?: string;
};

const fetchJSON = async <T>(url: string, attempts = 3): Promise<T> => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (attempts <= 1) {
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    return fetchJSON<T>(url, attempts - 1);
  }
};

const fetchSubRegion = async (id: string): Promise<SubRegion> => {
  const data = await fetchJSON<GoogleRegionData>(`${GOOGLE_BASE_URL}/${id}`);
  return { key: data.isoid ?? data.key, name: { default: data.name ?? data.key, latin: data.lname }, zip: data.zip };
};

const fetchCountry = async (countryCode: string): Promise<Country> => {
  const data = await fetchJSON<GoogleRegionData>(`${GOOGLE_BASE_URL}/data/${countryCode}`);
  const subRegionKeys = data.sub_keys?.split('~') ?? [];
  const subRegions = await Promise.all(subRegionKeys.map(key => fetchSubRegion(`${data.id}/${key}`)));
  // eslint-disable-next-line camelcase
  return { ...data, sub_regions: subRegions.length ? subRegions : undefined };
};

const loadFromGoogle = async () => {
  const { countries } = await fetchJSON<{ countries: string }>(`${GOOGLE_BASE_URL}/data`);
  const result: Country[] = [];
  // Sequential on purpose: each country already fans out one request per sub-region
  for (const countryCode of countries.split('~')) {
    console.log(`Fetching ${countryCode}...`);
    result.push(await fetchCountry(countryCode));
  }

  return { source: GOOGLE_BASE_URL, countries: result };
};

// ---- Source: lib-address package ----

const loadFromLibAddress = (packageDir: string) => {
  const { version } = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const countriesDir = path.join(packageDir, 'countries');
  const countries = readdirSync(countriesDir)
    .filter(file => /^[A-Z]{2}\.json$/.test(file))
    .sort()
    .map(file => JSON.parse(readFileSync(path.join(countriesDir, file), 'utf8')) as Country);

  return { source: `lib-address@${version} (https://github.com/LancelotP/lib-address)`, countries };
};

const main = async () => {
  const libAddressDir = process.argv[2];
  const { source, countries } = libAddressDir ? loadFromLibAddress(libAddressDir) : await loadFromGoogle();
  const output = {
    source,
    countries: Object.fromEntries(applyOverrides(countries).map(country => [country.key, trimCountry(country)])),
  };

  const prettierConfig = await resolveConfig(OUTPUT);
  writeFileSync(OUTPUT, await format(JSON.stringify(output), { ...prettierConfig, filepath: OUTPUT }));
  console.log(`Wrote ${countries.length} countries to ${OUTPUT}`);
};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
