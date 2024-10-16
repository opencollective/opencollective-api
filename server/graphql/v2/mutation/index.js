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
import createOrganizationMutation from './CreateOrganizationMutation';
import createProjectMutation from './CreateProjectMutation';
import emojiReactionMutations from './EmojiReactionMutations';
import expenseMutations from './ExpenseMutations';
import guestMutations from './GuestMutations';
import goalMutations from './GoalMutations';
import hostApplicationMutations from './HostApplicationMutations';
import individualMutations from './IndividualMutations';
import { legalDocumentsMutations } from './LegalDocumentsMutations';
import memberInvitationMutations from './MemberInvitationMutations';
import memberMutations from './MemberMutations';
import oAuthAuthorizationMutations from './OAuthAuthorizationMutations';
import orderMutations from './OrderMutations';
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
  createOrganization: createOrganizationMutation,
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
  ...goalMutations,
  ...hostApplicationMutations,
  ...individualMutations,
  ...legalDocumentsMutations,
  ...memberInvitationMutations,
  ...memberMutations,
  ...oAuthAuthorizationMutations,
  ...orderMutations,
  ...paymentMethodMutations,
  ...payoutMethodMutations,
  ...plaidMutations,
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
