import DataLoader from 'dataloader';

import models from '../models';
import PersonalToken from '../models/PersonalToken';
import User from '../models/User';
import UserToken from '../models/UserToken';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: User | null;
      jwtPayload?: {
        sessionId?: string;
        scope?: string;
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
      personalToken?: PersonalToken;
      loaders: Record<keyof typeof models, DataLoader>;
      rawBody?: string;
    }
  }
}
