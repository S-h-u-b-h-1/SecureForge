const vscode = require('vscode');

exports.activate = async function activate(context) {
  const { registerReviewCommands } = await import('./review-ui.mjs');
  const { registerWorkflows } = await import('./workflows.mjs');
  const state = registerWorkflows(vscode, context);
  registerReviewCommands(vscode, context, state.recordReview);
  return state;
};
