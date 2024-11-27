import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';

import { UploadedFile } from '../../../models';

export const AccountImagesInputFields = {
  image: {
    type: GraphQLUpload,
    description: 'The profile avatar image',
  },
  backgroundImage: {
    type: GraphQLUpload,
    description: 'The profile background image, for the banner and social media sharing',
  },
};

export async function handleCollectiveImageUploadFromArgs(
  remoteUser,
  args,
): Promise<{ avatar: UploadedFile | null | undefined; banner: UploadedFile | null | undefined }> {
  if (!args) {
    return { avatar: undefined, banner: undefined };
  }

  const { image, backgroundImage } = args;
  if (!image && !backgroundImage) {
    return { avatar: image, banner: backgroundImage };
  }

  const [avatar, banner] = await Promise.all([
    image && UploadedFile.uploadGraphQl(await image, 'ACCOUNT_AVATAR', remoteUser),
    backgroundImage && UploadedFile.uploadGraphQl(await backgroundImage, 'ACCOUNT_BANNER', remoteUser),
  ]);

  return { avatar, banner };
}
