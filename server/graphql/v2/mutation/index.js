import accountingCategoriesMutations from './AccountingCategoriesMutations';
import accountMutations from './AccountMutations';
import activitySubscriptionsMutations from './ActivitySubscriptionsMutations';
import addedFundsMutations from './AddedFundsMutations';
import agreementMutations from './AgreementMutations';
import applicationMutations from './ApplicationMutations';
import commentMutations from './CommentMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutation from './CreateCollectiveMutation';
import createEventMutation from './CreateEventMutation';
import createFundMutation from './CreateFundMutation';
import createProjectMutation from './CreateProjectMutation';
import emojiReactionMutations from './EmojiReactionMutations';
import expenseMutations from './ExpenseMutations';
import goCardlessMutations from './GoCardlessMutations';
import guestMutations from './GuestMutations';
import hostApplicationMutations from './HostApplicationMutations';
import individualMutations from './IndividualMutations';
import { legalDocumentsMutations } from './LegalDocumentsMutations';
import memberInvitationMutations from './MemberInvitationMutations';
import memberMutations from './MemberMutations';
import oAuthAuthorizationMutations from './OAuthAuthorizationMutations';
import orderMutations from './OrderMutations';
import organizationMutations from './OrganizationMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';
import personalTokenMutations from './PersonalTokenMutations';
import { plaidMutations } from './PlaidMutations';
import rootMutations from './RootMutations';
import { sendSurveyResponseMutation } from './SendSurveyResponseMutation';
import socialLinkMutations from './SocialLinkMutations';
import tagMutations from './TagMutations';
import tierMutations from './TierMutations';
import transactionImportsMutations from './TransactionImportsMutations';
import transactionMutations from './TransactionMutations';
import updateMutations from './UpdateMutations';
import uploadedFileMutations from './UploadedFileMutations';
import vendorMutations from './VendorMutations';
import virtualCardMutations from './VirtualCardMutations';
import webhookMutations from './WebhookMutations';

const mutation = {
  createCollective: createCollectiveMutation,
  createEvent: createEventMutation,
  createFund: createFundMutation,
  createProject: createProjectMutation,
  ...accountMutations,
  ...accountingCategoriesMutations,
  ...addedFundsMutations,
  ...applicationMutations,
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...emojiReactionMutations,
  ...expenseMutations,
  ...guestMutations,
  ...hostApplicationMutations,
  ...individualMutations,
  ...legalDocumentsMutations,
  ...memberInvitationMutations,
  ...memberMutations,
  ...oAuthAuthorizationMutations,
  ...orderMutations,
  ...organizationMutations,
  ...paymentMethodMutations,
  ...payoutMethodMutations,
  ...plaidMutations,
  ...goCardlessMutations,
  ...rootMutations,
  ...transactionMutations,
  ...transactionImportsMutations,
  ...updateMutations,
  ...uploadedFileMutations,
  ...virtualCardMutations,
  ...webhookMutations,
  ...activitySubscriptionsMutations,
  ...tierMutations,
  ...personalTokenMutations,
  ...socialLinkMutations,
  ...tagMutations,
  ...agreementMutations,
  ...vendorMutations,
  sendSurveyResponse: sendSurveyResponseMutation,
};

export default mutation;
