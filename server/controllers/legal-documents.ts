import type { Request, Response } from 'express';

import { idDecode } from '../graphql/v2/identifiers';
import { getFileFromS3 } from '../lib/awsS3';
import { reportErrorToSentry } from '../lib/sentry';
import twoFactorAuthLib from '../lib/two-factor-authentication';
import { LegalDocument } from '../models';
export default {
  download: async (req: Request, res: Response) => {
    // Must be logged in
    if (!req.remoteUser) {
      return res.status(401).send({ message: 'Unauthorized' });
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
      } else if (true) {
        // The condition above should let host admins download the legal documents they have access to.
        // We're blocking the feature for now. Remember to update the tests in `test/server/controllers/legal-documents.test.ts`
        // once the new condition is implemented. See https://github.com/opencollective/opencollective/issues/7218#issuecomment-2047005858.
        return res.status(403).send({ message: 'Unauthorized' });
      } else if (!legalDocument.canDownload()) {
        return res.status(403).send({ message: 'Document cannot be downloaded' });
      }

      // Check 2FA
      await twoFactorAuthLib.enforceForAccount(req, legalDocument.collective, { alwaysAskForToken: true });

      // Download associated file with `fetch`
      const encryptedFileContent = await getFileFromS3(legalDocument.documentLink);
      const decryptedFileContent = LegalDocument.decrypt(encryptedFileContent);
      return res.set('Content-Type', 'application/pdf').send(decryptedFileContent);
    } catch (error) {
      if (error.extensions?.code === '2FA_REQUIRED') {
        return res.status(401).send({
          message: 'Two-factor authentication required',
          supportedMethods: error.extensions.supportedMethods,
          authenticationOptions: error.extensions.authenticationOptions,
        });
      }

      reportErrorToSentry(error, { req });
      return res.status(500).send({ message: 'Internal server error' });
    }
  },
};
