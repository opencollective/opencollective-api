import { HostApplication } from '../../models';

export async function canCommentHostApplication(
  req: Express.Request,
  hostApplication: HostApplication,
): Promise<boolean> {
  if (
    req.remoteUser.isAdmin(hostApplication.CollectiveId) ||
    req.remoteUser.isAdmin(hostApplication.HostCollectiveId)
  ) {
    return true;
  }

  return false;
}
