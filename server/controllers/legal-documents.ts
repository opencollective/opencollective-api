import type { Response } from 'express';

import { idDecode } from '../graphql/v2/identifiers';
import { getFileFromS3 } from '../lib/awsS3';
import { reportErrorToSentry } from '../lib/sentry';
import { LegalDocument } from '../models';

export default {
  download: async (req: Express.Request, res: Response) => {
    // Must be logged in
    if (!req.remoteUser) {
      return res.status(401).send('Unauthorized');
    }

    // Parse ID
    const { id } = req.params;
    let decodedId;
    try {
      decodedId = idDecode(id, 'legal-document');
    } catch (e) {
      return res.status(400).send('Invalid id');
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
        return res.status(404).send('Legal document not found');
      } else if (!req.remoteUser.isAdminOfCollective(legalDocument.collective)) {
        return res.status(403).send('Unauthorized');
      } else if (!legalDocument.canDownload()) {
        return res.status(403).send('Document cannot be downloaded');
      }

      // TODO check 2fa

      // Download associated file with `fetch`
      const encryptedFileContent = await getFileFromS3(legalDocument.documentLink);
      const decryptedFileContent = LegalDocument.decryptFileContent(encryptedFileContent);
      return res.set('Content-Type', 'application/pdf').send(decryptedFileContent);
    } catch (error) {
      reportErrorToSentry(error, { req });
      return res.status(500).send('Internal server error');
    }
  },
};
