/**
 * Regenerates `server/lib/address/countries.json`, the address metadata used by `server/lib/address`.
 * Only the fields read by `server/lib/address` and the first level of sub-regions are kept.
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

const GOOGLE_BASE_URL = 'https://chromium-i18n.appspot.com/ssl-address';
const OUTPUT = path.join(__dirname, '../server/lib/address/countries.json');

type SubRegion = { key: string; name: Record<string, string>; zip?: string };

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
  sub_regions: country.sub_regions?.map(({ key, name, zip }) => ({ key, name, zip })),
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
  languages?: string;
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

const fetchSubRegion = async (id: string, extraLocales: string[]): Promise<SubRegion> => {
  const data = await fetchJSON<GoogleRegionData>(`${GOOGLE_BASE_URL}/${id}`);
  const localizedNames = await Promise.all(
    extraLocales.map(async locale => {
      const localized = await fetchJSON<GoogleRegionData>(`${GOOGLE_BASE_URL}/${id}--${locale}`);
      return [locale, localized.name] as const;
    }),
  );

  return {
    key: data.isoid ?? data.key,
    name: { default: data.name ?? data.key, latin: data.lname, ...Object.fromEntries(localizedNames) },
    zip: data.zip,
  };
};

const fetchCountry = async (countryCode: string): Promise<Country> => {
  const data = await fetchJSON<GoogleRegionData>(`${GOOGLE_BASE_URL}/data/${countryCode}`);
  const extraLocales = data.languages?.split('~').slice(1) ?? [];
  const subRegionKeys = data.sub_keys?.split('~') ?? [];
  const subRegions = await Promise.all(subRegionKeys.map(key => fetchSubRegion(`${data.id}/${key}`, extraLocales)));
  // eslint-disable-next-line camelcase
  return { ...data, sub_regions: subRegions.length ? subRegions : undefined };
};

const loadFromGoogle = async () => {
  const { countries } = await fetchJSON<{ countries: string }>(`${GOOGLE_BASE_URL}/data`);
  const result: Country[] = [];
  // Sequential on purpose: each country already fans out one request per sub-region and locale
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
    generatedAt: new Date().toISOString().slice(0, 10),
    countries: Object.fromEntries(countries.map(country => [country.key, trimCountry(country)])),
  };

  writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${countries.length} countries to ${OUTPUT}`);
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
