import { Account } from './interface/Account';
import { FileInfo } from './interface/FileInfo';
import { Amount } from './object/Amount';
import { Application } from './object/Application';
import { Bot } from './object/Bot';
import { Collective } from './object/Collective';
import { Credit } from './object/Credit';
import { Debit } from './object/Debit';
import { Event } from './object/Event';
import { ImageFileInfo } from './object/ImageFileInfo';
import { Individual } from './object/Individual';
import { Member, MemberOf } from './object/Member';
import { Organization } from './object/Organization';
import { TransferWise } from './object/TransferWise';
import { Vendor } from './object/Vendor';
import { VirtualCard } from './object/VirtualCard';

const types = [
  Application,
  Account,
  Amount,
  Bot,
  Collective,
  Credit,
  Debit,
  Event,
  FileInfo,
  ImageFileInfo,
  Individual,
  Member,
  MemberOf,
  Organization,
  TransferWise,
  Vendor,
  VirtualCard,
];

export default types;
