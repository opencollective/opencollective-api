import crypto from 'crypto';

import { Mutex } from 'async-mutex';
import jwt from 'jsonwebtoken';
import { keyBy } from 'lodash';
import moment from 'moment';
import fetch from 'node-fetch';

import { reportErrorToSentry } from '../sentry';

import sourceCachedMetadata from './cached-metadata.json';

type Metadata = {
  nextUpdate: string;
  entries: MetadataEntry[];
};

export type MetadataEntry = {
  aaguid?: string;
  metadataStatement?: MetadataStatement;
  statusReports: {
    status: string;
  }[];
};

type MetadataStatement = {
  description?: string;
  icon?: string;
};

const mutex = new Mutex();
let cachedMetadata: Metadata = sourceCachedMetadata;
let nextUpdate = cachedMetadata.nextUpdate;
let cachedEntriesByAaguid: Record<string, MetadataEntry> = cachedMetadata.entries.reduce(
  (acc, current) => {
    if (!current.aaguid) {
      return acc;
    }

    return {
      ...acc,
      [current.aaguid]: {
        ...current,
      },
    };
  },
  {} as Record<string, MetadataEntry>,
);

/**
 * Returns the FIDO metadata from the FIDO Alliance Metadata Service (MDS)
 * by downloading the MDS JWT and verifying the payload with the attached certificate signed by FIDO.
 *
 * https://fidoalliance.org/metadata/
 * @returns An updated fido authenticator metadata.
 */
export async function downloadFidoMetadata(): Promise<Metadata> {
  const fidoAlianceMetadataUrl = 'https://mds3.fidoalliance.org';

  const response = await fetch(fidoAlianceMetadataUrl);
  const text = await response.text();
  const decodedMetadataJwt = jwt.decode(text, { complete: true });
  const certs = (
    typeof decodedMetadataJwt.header.x5c === 'string' ? [decodedMetadataJwt.header.x5c] : decodedMetadataJwt.header.x5c
  )
    .map(base64Pem => new crypto.X509Certificate(Buffer.from(base64Pem, 'base64')))
    .join('\n');

  return jwt.verify(text, certs) as Metadata;
}

export async function updateCachedFidoMetadata() {
  try {
    return await mutex.runExclusive(async () => {
      if (moment().format('YYYY-MM-DD') <= nextUpdate) {
        return cachedMetadata;
      }

      const newMetadata = await downloadFidoMetadata();
      nextUpdate = newMetadata.nextUpdate;
      cachedEntriesByAaguid = keyBy(
        newMetadata.entries.filter(e => e.aaguid),
        'aaguid',
      );

      cachedMetadata = newMetadata;
    });
  } catch (e) {
    reportErrorToSentry(e);
  }
}

export async function getFidoMetadata(aaguid: string) {
  await updateCachedFidoMetadata();
  return cachedEntriesByAaguid[aaguid];
}
