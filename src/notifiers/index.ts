// Notifier barrel — side-effect imports that register notifiers.
//
// stdout + file are wired today. To add another delivery channel:
//   1. Create src/notifiers/<name>.ts that calls registerNotifier(...)
//   2. Add its import line below
//
// Examples for later:
//   - slack.ts:    post to a personal Slack via incoming webhook
//   - email.ts:    send the summary to yourself via Graph send-mail
//   - telegram.ts: bot-to-self DM

import './stdout.js';
import './file.js';
// import './slack.js';
// import './email.js';
