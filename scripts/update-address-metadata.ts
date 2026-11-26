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
    countries: Object.fromEntries(countries.map(country => [country.key, trimCountry(country)])),
  };

  const prettierConfig = await resolveConfig(OUTPUT);
  writeFileSync(OUTPUT, await format(JSON.stringify(output), { ...prettierConfig, filepath: OUTPUT }));
  console.log(`Wrote ${countries.length} countries to ${OUTPUT}`);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
