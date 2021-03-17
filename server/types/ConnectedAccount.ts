import { Model } from 'sequelize';

export interface ConnectedAccount extends Model {
  id: number;
  updatedAt: Date;
  token: string;
  refreshToken: string;
  hash: string;
  data: Record<string, unknown>;
}
