import { GraphQLAccount } from './interface/Account.js';
import { GraphQLFileInfo } from './interface/FileInfo.js';
import { GraphQLAmount } from './object/Amount.js';
import { GraphQLApplication } from './object/Application.js';
import { GraphQLBot } from './object/Bot.js';
import { GraphQLCollective } from './object/Collective.js';
import { GraphQLCredit } from './object/Credit.js';
import { GraphQLDebit } from './object/Debit.js';
import { GraphQLEvent } from './object/Event.js';
import { GraphQLGenericFileInfo } from './object/GenericFileInfo.js';
import { GraphQLImageFileInfo } from './object/ImageFileInfo.js';
import { GraphQLIndividual } from './object/Individual.js';
import { GraphQLMember, GraphQLMemberOf } from './object/Member.js';
import { GraphQLOrganization } from './object/Organization.js';
import { GraphQLTransferWise } from './object/TransferWise.js';
import { GraphQLVendor } from './object/Vendor.js';
import { GraphQLVirtualCard } from './object/VirtualCard.js';

const types = [
  GraphQLApplication,
  GraphQLAccount,
  GraphQLAmount,
  GraphQLBot,
  GraphQLCollective,
  GraphQLCredit,
  GraphQLDebit,
  GraphQLEvent,
  GraphQLFileInfo,
  GraphQLImageFileInfo,
  GraphQLGenericFileInfo,
  GraphQLIndividual,
  GraphQLMember,
  GraphQLMemberOf,
  GraphQLOrganization,
  GraphQLTransferWise,
  GraphQLVendor,
  GraphQLVirtualCard,
];

export default types;
