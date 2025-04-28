import '../env';

import { getSignedGetURL, objectExists, parseS3Url } from './awsS3';

export async function getThumbnailSignedGetUrlFromBucketUrl(bucketUrl: string): Promise<string> {
  const thumbnailUrl = `${bucketUrl}.thumbnail`;
  const { bucket, key } = parseS3Url(thumbnailUrl);

  if (!(await objectExists(thumbnailUrl))) {
    throw new Error('Thumbnail not yet generated');
  }

  return await getSignedGetURL({ Bucket: bucket, Key: key }, { expiresIn: 3600 });
}
