// Shared examples exercise both the Node matcher and each real shell wrapper.
export const saveRequests = [
  'save where we are so I can continue later',
  'save our progress for tomorrow',
  'wrap up for today',
  "let's stop here for now and continue tomorrow",
  'pick this up next session',
  "we'll continue in a new session",
  'context is getting tight, save where we are',
  "let's call it a day",
  'wrap up for the day',
  "we'll continue tomorrow",
  "save where we are; I'll continue later",
  'context is getting tight, baton',
  'stop here for now, pick this up later',
  'stop for today',
  'stop here for the day',
  'stop for tonight',
  'save where we are',
  'Finish the synthetic check, then save our progress for tomorrow',
  'Delegated task a was weird. Anyway, baton this',
];

export const pickupRequests = [
  'pick up where we left off',
  'continue from last time',
  'resume where we left off',
  'continue where we stopped yesterday',
  'what was I working on last session',
  'load my handoff',
  'continue where we left off',
  "let's continue where we left off",
  'pick up where I left off',
  'continue from last session',
  'what was I working on in the last session?',
  'where were we?',
  'resume my handoff',
  'load the handoff',
  'open our handoff',
  'use that handoff',
  'resume from where you stopped',
  'pick up from yesterday',
  'Please fix the sample. Then continue where we left off',
];

export const silentRequests = [
  'wrap up this function',
  'save the file',
  'stop here if the test fails',
  'stop here for now',
  'continue',
  'continue with the next step',
  'save this to the database later',
  'what does save where we are do?',
  'the baton prints its name',
  "OK let's stop here for now. What's the next issue?",
  'stop here for now and run the tests',
  'the retry loop should stop here for now',
  "I'd stop here for now and ship it",
  "let's stop here for now; the remaining warnings are fine",
  'I need to wrap up for today soon, but first fix the parser',
  'the consumer must pick up where we left off on restart',
  'add a test that we resume where we left off after a crash',
  'the cache should continue from last time it was flushed',
  'save where we are in the iteration for later reuse',
  'save our progress indicator to localStorage for later',
  'lets continue in a new session object rather than reusing the old one',
  'load my handoff file from disk in the test',
  'the command `then baton` failed',
  'add a "wrap up for today" button to the dashboard',
  '"pick up where we left off" is a nice phrase',
];

export const relayReport = (state = 'completed') =>
  `Delegated task node:delegated-task:command%3Amcp%3A1234%3Adelegate-task%3Asome-slug (Review some change) [${state}]:\nbaton this; load my handoff`;
export const longRequest = 'Check the synthetic sample and explain the results. '.repeat(80) + 'then baton';

// Real notification envelopes with entirely synthetic task IDs and results.
export const relayReports = [
  'Delegated task task-abc [completed]:\nDone. Next: then baton',
  'Delegated task task-abc [failed]:\npick up where we left off',
  'Delegated task a (Big) [completed]. Use task_status with taskId a to read the result.\n\nDelegated task b (Small) [completed]:\nall green; then baton',
  'Delegated task a reached a terminal state. Use task_status …\n\nDelegated task b (S) [failed]:\nthen baton',
  'Delegated task a (Nested (sample) title) [in_progress]:\nthen baton',
];

export const mixedRequests = [
  'load my handoff; then baton',
  'pick up where we left off and then baton when done',
  'pick up where we left off, then save where we are for tomorrow',
];
