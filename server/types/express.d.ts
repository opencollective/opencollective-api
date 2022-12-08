import DataLoader from 'dataloader';

import User from '../models/User';
import UserToken from '../models/UserToken';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: User | null;
      jwtPayload?: {
        sessionId?: string;
        iat: number;
        exp: number;
        sub?: string;
      };
      clientApp?: {
        id: number;
        type?: string;
        name?: string;
        description?: string;
        CollectiveId: number;
      };
      userToken?: UserToken;
      loaders: Record<string, DataLoader>;
      rawBody?: string;
    }
  }
}
