const vscode = require('vscode');

exports.activate = async function activate(context) {
  const { registerReviewCommands } = await import('./review-ui.mjs');
  registerReviewCommands(vscode, context);
};
