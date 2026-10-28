// Shared examples exercise both the Node matcher and each real shell wrapper.
export const saveRequests = [
  'save where we are so I can continue later',
  'save our progress for tomorrow',
  'wrap up for today',
  "let's stop here for now and continue tomorrow",
  'pick this up next session',
  "we'll continue in a new session",
  'context is getting tight, save where we are',
];

export const pickupRequests = [
  'pick up where we left off',
  'continue from last time',
  'resume where we left off',
  'continue where we stopped yesterday',
  'what was I working on last session',
  'load my handoff',
];

export const silentRequests = [
  'wrap up this function',
  'save the file',
  'stop here if the test fails',
  'continue',
  'continue with the next step',
  'save this to the database later',
  'what does save where we are do?',
  'the baton prints its name',
];

export const relayReport = (state = 'completed') =>
  `Delegated task node:delegated-task:command%3Amcp%3A1234%3Adelegate-task%3Asome-slug (Review some change) [${state}]:\nbaton this; load my handoff`;
export const longRequest = 'Check the synthetic sample and explain the results. '.repeat(80) + 'then baton';
