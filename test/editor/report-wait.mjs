import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// VS Code can return from its CLI before the Extension Development Host finishes.
// Wait for a terminal report, never an incomplete checkpoint or merely CLI exit 0.
export async function waitForEditorReport(reportPath, {
  timeoutMs = 240000,
  pollMs = 250,
  onCheckpoint = () => {},
  getLaunchState = () => null,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 20 || !Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error('Invalid editor report polling configuration');
  }
  const deadline = Date.now() + timeoutMs;
  let checkpoint = '';
  let seenReport = false;
  while (Date.now() <= deadline) {
    const launch = getLaunchState();
    if (launch?.error) {
      throw new Error('Could not start VS Code editor host: ' + launch.error.message, { cause: launch.error });
    }
    try {
      const raw = await readFile(reportPath, 'utf8');
      seenReport = true;
      let report;
      try { report = JSON.parse(raw); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // A checkpoint may have been read while its JSON was being written.
      }
      if (report) {
        if (typeof report !== 'object' || Array.isArray(report)) {
          throw new Error('Editor test report must be a JSON object');
        }
        if (Array.isArray(report.passed) && report.incomplete === true) {
          if (typeof report.lastCheckpoint === 'string' && report.lastCheckpoint !== checkpoint) {
            checkpoint = report.lastCheckpoint;
            onCheckpoint(checkpoint);
          }
        } else if (Array.isArray(report.passed)) {
          return report;
        } else {
          throw new Error('Editor test report has no passed array');
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (launch?.exited && launch.code !== 0 && launch.code !== null) {
      throw new Error('VS Code test CLI exited with code ' + launch.code + ' before a completed report was available');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(pollMs, remaining));
  }
  const reason = seenReport ? 'VS Code wrote no completed test report' : 'VS Code did not write a test report';
  const last = checkpoint ? ' Last checkpoint: ' + checkpoint + '.' : '';
  throw new Error(reason + ' within ' + timeoutMs + ' ms.' + last + ' Inspect ' + reportPath +
    '. If VS Code Stable is already running, close its other windows or use Insiders for extension tests.');
}
