import crypto from 'crypto';

import { Mutex } from 'async-mutex';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import moment from 'moment';

import { reportErrorToSentry } from '../sentry';

import sourceCachedMetadata from './cached-metadata.json';

export type Metadata = {
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
let cachedEntriesByAaguid: Record<string, MetadataEntry> = {};

export async function downloadFidoMetadata(): Promise<Metadata> {
  const fidoAlianceMetadataUrl = 'https://mds3.fidoalliance.org';

  const response = await axios.get<string>(fidoAlianceMetadataUrl);

  const decodedMetadataJwt = jwt.decode(response.data, { complete: true });
  const certs = (
    typeof decodedMetadataJwt.header.x5c === 'string' ? [decodedMetadataJwt.header.x5c] : decodedMetadataJwt.header.x5c
  )
    .map(base64Pem => new crypto.X509Certificate(Buffer.from(base64Pem, 'base64')))
    .join('\n');

  return jwt.verify(response.data, certs) as Metadata;
}

export async function updateCachedFidoMetadata() {
  try {
    return await mutex.runExclusive(async () => {
      if (moment().format('YYYY-MM-DD') <= nextUpdate) {
        return cachedMetadata;
      }

      const newMetadata = await downloadFidoMetadata();
      nextUpdate = newMetadata.nextUpdate;
      cachedEntriesByAaguid = newMetadata.entries.reduce((acc, current) => {
        if (!current.aaguid) {
          return acc;
        }

        return {
          ...acc,
          [current.aaguid]: {
            ...current,
          },
        };
      }, {} as Record<string, MetadataEntry>);

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
