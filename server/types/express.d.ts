import DataLoader from 'dataloader';

import PersonalToken from '../models/PersonalToken';
import UserModel from '../models/User';
import UserToken from '../models/UserToken';

declare global {
  namespace Express {
    interface Request {
      remoteUser?: UserModel | null;
      isGraphQL?: boolean;
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
      loaders: Record<string, DataLoader>;
      rawBody?: string;
      params: Record<string, string>;
    }
  }
}
