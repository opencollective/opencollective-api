import type express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { canSeeIncognitoProfile } from '../../../lib/incognito';
import { optsSanitizeHtmlForSimplified, sanitizeHTML } from '../../../lib/sanitize-html';
import { Activity, Collective, FiscalHostNote, sequelize } from '../../../models';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkRemoteUserCanUseHost, checkScope } from '../../common/scope-check';
import { BadRequest, Unauthorized, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { GraphQLRemoveFiscalHostNoteInput, GraphQLSetFiscalHostNoteInput } from '../input/FiscalHostNoteInput';
import { FiscalHostNoteData, GraphQLFiscalHostNote } from '../object/FiscalHostNote';

const NOTE_MAX_LENGTH = 5000;

const ALLOWED_ACCOUNT_TYPES = [
  CollectiveType.USER,
  CollectiveType.ORGANIZATION,
  CollectiveType.VENDOR,
  CollectiveType.COLLECTIVE,
  CollectiveType.FUND,
  CollectiveType.PROJECT,
  CollectiveType.EVENT,
];

const fetchHostAndAccount = async (
  input: { host: AccountReferenceInput; account: AccountReferenceInput },
  req: express.Request,
): Promise<{ host: Collective; account: Collective }> => {
  const host = await fetchAccountWithReference(input.host, { loaders: req.loaders, throwIfMissing: true });
  const account = await fetchAccountWithReference(input.account, { loaders: req.loaders, throwIfMissing: true });
  return { host, account };
};

const assertValidFiscalHostNoteTarget = async (
  host: Collective,
  account: Collective,
  req: express.Request,
  unauthorizedMessage: string,
): Promise<void> => {
  if (!req.remoteUser.isAdminOfCollective(host)) {
    throw new Unauthorized(unauthorizedMessage);
  } else if (!(await host.isHost())) {
    throw new BadRequest('Only fiscal hosts can have fiscal host notes');
  } else if (!ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
    throw new BadRequest('Only individuals, organizations, vendors and collectives can be flagged');
  }
};

const resolveNoteTargetAccount = async (account: Collective, req: express.Request): Promise<Collective> => {
  if (!account.isIncognito) {
    return account;
  }

  if (
    !checkScope(req, 'account') ||
    !checkScope(req, 'incognito') ||
    (!canSeeIncognitoProfile(req, account) &&
      !getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, account.id))
  ) {
    throw new Unauthorized('You are not allowed to manage fiscal host notes for this incognito profile');
  }

  const mainProfile = await req.loaders.Collective.mainProfileFromIncognito.load(account.id);
  if (!mainProfile) {
    throw new BadRequest('Could not resolve the incognito profile');
  }

  return mainProfile;
};

const fiscalHostNoteMutations = {
  setFiscalHostNote: {
    type: new GraphQLNonNull(GraphQLFiscalHostNote),
    description: 'Add or update a host-private note about an account. Scope: "host".',
    args: {
      input: {
        type: new GraphQLNonNull(GraphQLSetFiscalHostNoteInput),
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<FiscalHostNoteData> {
      checkRemoteUserCanUseHost(req);

      const { host, account } = await fetchHostAndAccount(args.input, req);
      await assertValidFiscalHostNoteTarget(host, account, req, 'Only host admins can set fiscal host notes');
      const targetAccount = await resolveNoteTargetAccount(account, req);

      const rawNote = args.input.note?.trim();
      if (!rawNote) {
        throw new ValidationFailed('Note cannot be empty');
      } else if (rawNote.length > NOTE_MAX_LENGTH) {
        throw new ValidationFailed(`Note is too long (maximum ${NOTE_MAX_LENGTH} characters)`);
      }

      const sanitizedNote = sanitizeHTML(rawNote, optsSanitizeHtmlForSimplified);
      if (!sanitizedNote.trim()) {
        throw new ValidationFailed('Note cannot be empty');
      } else if (sanitizedNote.length > NOTE_MAX_LENGTH) {
        throw new ValidationFailed(`Note is too long (maximum ${NOTE_MAX_LENGTH} characters)`);
      }

      return sequelize.transaction(async transaction => {
        const [fiscalHostNote, created] = await FiscalHostNote.findOrCreate({
          where: { HostCollectiveId: host.id, CollectiveId: targetAccount.id },
          defaults: {
            type: args.input.type,
            note: sanitizedNote,
            CreatedByUserId: req.remoteUser.id,
            UpdatedByUserId: req.remoteUser.id,
          },
          transaction,
        });

        if (!created) {
          await fiscalHostNote.update(
            {
              type: args.input.type,
              note: sanitizedNote,
              UpdatedByUserId: req.remoteUser.id,
            },
            { transaction },
          );
        }

        await Activity.create(
          {
            type: ActivityTypes.FISCAL_HOST_NOTE_SET,
            CollectiveId: host.id,
            FromCollectiveId: targetAccount.id,
            HostCollectiveId: host.id,
            UserId: req.remoteUser.id,
            data: { notify: false, note: sanitizedNote, noteType: args.input.type },
          },
          { transaction },
        );

        return fiscalHostNote;
      });
    },
  },
  removeFiscalHostNote: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Remove a host-private note about an account. Scope: "host".',
    args: {
      input: {
        type: new GraphQLNonNull(GraphQLRemoveFiscalHostNoteInput),
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      checkRemoteUserCanUseHost(req);

      const { host, account } = await fetchHostAndAccount(args.input, req);
      await assertValidFiscalHostNoteTarget(host, account, req, 'Only host admins can remove fiscal host notes');
      const targetAccount = await resolveNoteTargetAccount(account, req);

      await sequelize.transaction(async transaction => {
        const fiscalHostNote = await FiscalHostNote.findOne({
          where: { HostCollectiveId: host.id, CollectiveId: targetAccount.id },
          transaction,
        });

        if (!fiscalHostNote) {
          return;
        }

        await fiscalHostNote.destroy({ transaction });
        await Activity.create(
          {
            type: ActivityTypes.FISCAL_HOST_NOTE_REMOVED,
            CollectiveId: host.id,
            FromCollectiveId: targetAccount.id,
            HostCollectiveId: host.id,
            UserId: req.remoteUser.id,
            data: { notify: false, note: fiscalHostNote.note, noteType: fiscalHostNote.type },
          },
          { transaction },
        );
      });

      return true;
    },
  },
};

export default fiscalHostNoteMutations;
