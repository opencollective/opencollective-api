import '../env';

import type { Canvas } from '@napi-rs/canvas';
import type { NodeCanvasFactory } from 'pdfjs-dist/types/src/display/node_utils';
import type { getDocument } from 'pdfjs-dist/types/src/pdf';
import sharp from 'sharp';

import { UploadedFile } from '../models';

import { getObjectFromUrl } from './awsS3';
import logger from './logger';

const CMAP_URL = 'node_modules/pdfjs-dist/cmaps/';
const CMAP_PACKED = true;

const STANDARD_FONT_DATA_URL = 'node_modules/pdfjs-dist/standard_fonts/';

async function generateThumbnail(imageBuffer: Uint8Array): Promise<Uint8Array> {
  return await sharp(imageBuffer)
    .rotate()
    .resize({ width: 200, height: 200, position: 'top' })
    .toFormat(sharp.format.png)
    .toBuffer();
}

async function generatePdfThumbnail(pdfBuffer: Uint8Array): Promise<Uint8Array> {
  // dynamic import of esm dependency
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as { getDocument: typeof getDocument };

  const loadingTask = pdfjs.getDocument({
    data: pdfBuffer,
    cMapUrl: CMAP_URL,
    cMapPacked: CMAP_PACKED,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });

  const pdfDocument = await loadingTask.promise;
  const page = await pdfDocument.getPage(1);

  const canvasFactory = pdfDocument.canvasFactory as NodeCanvasFactory;
  const viewport = page.getViewport({ scale: 1.0 });
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  const renderContext = {
    canvasContext: canvasAndContext.context,
    viewport,
  };

  const renderTask = page.render(renderContext);
  await renderTask.promise;
  // Convert the canvas to an image buffer.
  const image = (canvasAndContext.canvas as unknown as Canvas).toBuffer('image/png');
  const thumbnail = await generateThumbnail(image);
  page.cleanup();
  return thumbnail;
}

export async function generateThumbnailFromBucketUrl(bucketUrl: string): Promise<Uint8Array> {
  const s3GetObjectOutput = await getObjectFromUrl(bucketUrl);

  const isSupportedMimeType =
    UploadedFile.isSupportedImageMimeType(s3GetObjectOutput.ContentType as string) ||
    s3GetObjectOutput.ContentType === 'application/pdf';

  if (!isSupportedMimeType) {
    return null;
  }

  const fileBuffer = await s3GetObjectOutput.Body?.transformToByteArray();
  if (!fileBuffer) {
    logger.error(`could not get file buffer for ${bucketUrl}`);
    return;
  }

  if (UploadedFile.isSupportedImageMimeType(s3GetObjectOutput.ContentType as string)) {
    return generateThumbnail(fileBuffer);
  } else if (s3GetObjectOutput.ContentType === 'application/pdf') {
    return generatePdfThumbnail(fileBuffer);
  }
}
