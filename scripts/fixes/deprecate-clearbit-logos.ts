import '../../server/env';

import { isEmpty } from 'lodash';

import logger from '../../server/lib/logger';
import { Collective, Op, UploadedFile } from '../../server/models';

const PAGE_SIZE = 100;

export async function deprecateClearbitLogos({
  pageSize,
  dry,
  clearbitImageGetter = clearbitImageGetterImpl,
  logger,
}: {
  pageSize?: number;
  dry?: boolean;
  clearbitImageGetter?: typeof clearbitImageGetterImpl;
  logger?: (...msg) => void;
} = {}) {
  if (dry) {
    logger?.('RUNNING IN DRY MODE!');
  }

  let updatedCount = 0;
  for await (const col of collectivesWithClearbitLogoIterator({ pageSize, logger })) {
    if (dry) {
      logger?.(`Would update profile image of ${col.slug}: ${col.image}`);
      continue;
    }

    const file = await clearbitImageGetter(col.image);
    const uploadedFile = await UploadedFile.upload(file, 'ACCOUNT_AVATAR', null);
    await col.update({
      image: uploadedFile.url,
      data: {
        ...col.data,
        migration20251020ClearbitLogo: col.image,
      },
    });

    if (++updatedCount % 100) {
      logger?.(`completed ${updatedCount} collectives`);
    }
  }
}

async function clearbitImageGetterImpl(imgUrl: string) {
  const clearbitImageRequest = await fetch(imgUrl);
  const bytes = await clearbitImageRequest.arrayBuffer();
  const mimetype = clearbitImageRequest.headers.get('Content-Type') || 'image/png';
  const file = {
    buffer: bytes,
    size: bytes.byteLength,
    mimetype,
    originalname: null,
  };

  return file;
}

async function* collectivesWithClearbitLogoIterator({
  pageSize = PAGE_SIZE,
  logger,
}: { pageSize?: number; logger?: (...msg) => void } = {}) {
  const whereArgs = {
    image: {
      [Op.like]: 'https://logo.clearbit.com/%',
    },
  };

  const count = await Collective.count({
    where: whereArgs,
  });
  logger?.(`${count} collectives found with clearbit logo`);

  let lastCollectiveId = 0;
  while (true) {
    const pageResult = await Collective.findAll({
      where: {
        ...whereArgs,
        id: { [Op.gt]: lastCollectiveId },
      },
      order: [['id', 'ASC']],
      limit: pageSize,
    });

    if (isEmpty(pageResult)) {
      return;
    }

    lastCollectiveId = pageResult[pageResult.length - 1].id;

    for (const col of pageResult) {
      yield col;
    }
  }
}

async function main() {
  await deprecateClearbitLogos({ dry: !!process.env.DRY, logger: logger.info });
}

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch(e => {
      logger.error(e);
      process.exit(1);
    });
}
