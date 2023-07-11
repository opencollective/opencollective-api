/**
 * Implementing the type locally as @types/multer declares the namespace globally under Express,
 * which doesn't work great with the local `express.d.ts`
 */

import { Readable } from 'stream';

export interface MulterFile {
  /** Name of the form field associated with this file. */
  fieldName: string;
  /** Name of the file on the uploader's computer. */
  originalname: string;
  /** Size of the file in bytes. */
  size: number;
  /** Readable stream of file data */
  stream: Readable;
  /** Value of the `Content-Type` header for this file. */
  detectedMimeType: string;
  /** The typical file extension for files of the detected type, or empty string if we failed to detect (with leading . to match path.extname)*/
  detectedFileExtension: string;
  /** The mime type reported by the client using the Content-Type header, or null1 if the header was absent */
  clientReportedMimeType?: string;
  /** The extension of the file uploaded (as reported by path.extname) */
  clientReportedFileExtension?: string;
}
