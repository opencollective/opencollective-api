import accountMutations from './AccountMutations.js';
import activitySubscriptionsMutations from './ActivitySubscriptionsMutations.js';
import { addFundsMutation } from './AddFundsMutations.js';
import agreementMutations from './AgreementMutations.js';
import applicationMutations from './ApplicationMutations.js';
import commentMutations from './CommentMutations.js';
import connectedAccountMutations from './ConnectedAccountMutations.js';
import conversationMutations from './ConversationMutations.js';
import createCollectiveMutation from './CreateCollectiveMutation.js';
import createEventMutation from './CreateEventMutation.js';
import createFundMutation from './CreateFundMutation.js';
import createOrganizationMutation from './CreateOrganizationMutation.js';
import createProjectMutation from './CreateProjectMutation.js';
import emojiReactionMutations from './EmojiReactionMutations.js';
import expenseMutations from './ExpenseMutations.js';
import guestMutations from './GuestMutations.js';
import hostApplicationMutations from './HostApplicationMutations.js';
import individualMutations from './IndividualMutations.js';
import memberInvitationMutations from './MemberInvitationMutations.js';
import memberMutations from './MemberMutations.js';
import oAuthAuthorizationMutations from './OAuthAuthorizationMutations.js';
import orderMutations from './OrderMutations.js';
import paymentMethodMutations from './PaymentMethodMutations.js';
import payoutMethodMutations from './PayoutMethodMutations.js';
import personalTokenMutations from './PersonalTokenMutations.js';
import rootMutations from './RootMutations.js';
import socialLinkMutations from './SocialLinkMutations.js';
import tagMutations from './TagMutations.js';
import tierMutations from './TierMutations.js';
import transactionMutations from './TransactionMutations.js';
import updateMutations from './UpdateMutations.js';
import virtualCardMutations from './VirtualCardMutations.js';
import webhookMutations from './WebhookMutations.js';

const mutation = {
  addFunds: addFundsMutation,
  createCollective: createCollectiveMutation,
  createEvent: createEventMutation,
  createFund: createFundMutation,
  createOrganization: createOrganizationMutation,
  createProject: createProjectMutation,
  ...accountMutations,
  ...applicationMutations,
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...emojiReactionMutations,
  ...expenseMutations,
  ...guestMutations,
  ...hostApplicationMutations,
  ...individualMutations,
  ...memberInvitationMutations,
  ...memberMutations,
  ...oAuthAuthorizationMutations,
  ...orderMutations,
  ...paymentMethodMutations,
  ...payoutMethodMutations,
  ...rootMutations,
  ...transactionMutations,
  ...updateMutations,
  ...virtualCardMutations,
  ...webhookMutations,
  ...activitySubscriptionsMutations,
  ...tierMutations,
  ...personalTokenMutations,
  ...socialLinkMutations,
  ...tagMutations,
  ...agreementMutations,
};

export default mutation;
