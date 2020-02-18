import commentMutations from './CommentMutations';
import conversationMutations from './ConversationMutations';
import expenseMutations from './ExpenseMutations';

const mutation = {
  ...commentMutations,
  ...conversationMutations,
  ...expenseMutations,
};

export default mutation;
