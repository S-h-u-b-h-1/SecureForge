const vscode = require('vscode');

exports.activate = async function activate(context) {
  const { activate } = await import('./entry.mjs');
  return activate(context, vscode);
};
