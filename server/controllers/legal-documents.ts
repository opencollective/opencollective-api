import config from 'config';
import type { Request, Response } from 'express';

import MemberRoles from '../constants/roles';
import { idDecode } from '../graphql/v2/identifiers';
import { getFileFromS3 } from '../lib/awsS3';
import SQLQueries from '../lib/queries';
import RateLimit from '../lib/rate-limit';
import { reportErrorToSentry } from '../lib/sentry';
import twoFactorAuthLib from '../lib/two-factor-authentication';
import { LegalDocument, RequiredLegalDocument, User } from '../models';

/**
 * User must be an admin of the host where the legal document is attached
 */
const hasPermissionToDownload = async (legalDocument: LegalDocument, remoteUser: User): Promise<boolean> => {
  const administratedCollectiveIds = Object.entries(remoteUser.rolesByCollectiveId)
    .filter(([, roles]) => roles.includes(MemberRoles.ADMIN))
    .map(([collectiveId]) => Number(collectiveId));

  if (!administratedCollectiveIds.length) {
    return false;
  }

  const administratedHostRequiredLegalDocs = await RequiredLegalDocument.findAll({
    attributes: ['HostCollectiveId'],
    where: { HostCollectiveId: administratedCollectiveIds },
    raw: true,
  });

  if (!administratedHostRequiredLegalDocs.length) {
    return false;
  }

  const taxFormAccounts = await SQLQueries.getTaxFormsRequiredForAccounts({
    HostCollectiveId: administratedHostRequiredLegalDocs.map(doc => doc.HostCollectiveId),
    CollectiveId: legalDocument.CollectiveId,
    year: legalDocument.year,
  });

  return taxFormAccounts.has(legalDocument.CollectiveId);
};

export default {
  download: async (req: Request, res: Response) => {
    // Must be logged in
    if (!req.remoteUser) {
      return res.status(401).send({ message: 'Unauthorized' });
    }

    // Rate limit by user
    const rateLimitKey = `legal-document-download-${req.remoteUser.id}`;
    const rateLimit = new RateLimit(rateLimitKey, config.limits.taxForms.downloadPerHour);
    if (await rateLimit.hasReachedLimit()) {
      return res.status(429).send({ message: 'Rate limit exceeded' });
    }

    // Parse ID
    const { id } = req.params;
    let decodedId;
    try {
      decodedId = idDecode(id, 'legal-document');
    } catch (e) {
      return res.status(400).send({ message: 'Invalid id' });
    }

    try {
      // Load & check legal document
      const legalDocument = await LegalDocument.findByPk(decodedId, {
        include: {
          association: 'collective',
          required: true,
        },
      });

      if (!legalDocument) {
        return res.status(404).send({ message: 'Legal document not found' });
        // eslint-disable-next-line no-constant-condition
      } else if (!(await hasPermissionToDownload(legalDocument, req.remoteUser))) {
        return res.status(403).send({ message: 'Unauthorized' });
      } else if (!(await twoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser))) {
        return res.status(403).send({ message: 'Two-factor authentication required' });
      } else if (!legalDocument.canDownload()) {
        return res.status(403).send({ message: 'Document cannot be downloaded' });
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, legalDocument.collective, { alwaysAskForToken: true });

      // Download associated file with `fetch`
      const encryptedFileContent = await getFileFromS3(legalDocument.documentLink);
      const decryptedFileContent = LegalDocument.decrypt(encryptedFileContent);
      await rateLimit.registerCall();
      return res.set('Content-Type', 'application/pdf').send(decryptedFileContent);
    } catch (error) {
      if (error.extensions?.code === '2FA_REQUIRED') {
        return res.status(401).send({
          message: error.message,
          supportedMethods: error.extensions.supportedMethods,
          authenticationOptions: error.extensions.authenticationOptions,
        });
      } else if (error.extensions?.code === 'INVALID_2FA_CODE') {
        return res.status(401).send({ message: error.message });
      }

      reportErrorToSentry(error, { req });
      return res.status(500).send({ message: 'Internal server error' });
    }
  },
};
