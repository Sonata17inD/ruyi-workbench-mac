# Ruyi Administrator Guide

## Install and choose a variant

Ruyi for Mac targets Apple Silicon and macOS 14. Verify the SHA-256 checksum supplied with the DMG, copy the complete app to Applications, eject the image and open the installed app. Internal trial builds use ad-hoc signing. Follow the approval options macOS offers under your device policy.

| Variant | Included capabilities | Default data directory |
| --- | --- | --- |
| Ruyi | Node workbench, ripgrep, Python, Office/PDF tools, Chromium and desktop automation | `~/.ruyi-workbench-full` |
| Ruyi Slim | Node workbench, ripgrep and native host | `~/.ruyi-workbench` |

Configure a model for either variant. Cloud models require connectivity. Start the model service for a local or intranet endpoint. System browser mode opens URLs. Select the bundled browser in Full to automate page contents.

## Configure models and workspaces

In Settings, select a model service, enter its endpoint, protocol, model and credentials, test the connection and send a short message. Match the service to Anthropic Messages, Chat Completions or Responses. To use Claude Code, install and sign in to its local CLI. Settings can point to its executable. Conversations retain their engine selection. When an engine is unavailable, choose an available engine in the thread to continue.

Choose the working folder for each task and grant the read and write access it needs. On shared Macs, keep each user's data directory and Keychain under their account. Set `RUYI_HOME` for an independent data directory. Each running instance needs exclusive access to its directory.

## Permissions, credentials and audit

Check Desktop Permissions in the app menu. Desktop input uses Accessibility. Screenshots and on-screen OCR use Screen Recording. Voice input uses the microphone. OCR of a local image only requires access to the file. Full and Slim have separate permission registrations. Check diagnostics after replacing the app.

Enter secrets in the credential fields in Settings. Keychain protects encrypted credentials. To move accounts, import the password-protected credential recovery bundle or enter the credentials again. External bots bind to a sender and conversation. Confirm the context shared with that conversation before enabling remote control. Use the audit record to review tool calls, permission decisions and task outcomes. Review paths, request contents and credentials before sharing logs.

## Upgrade, recover and troubleshoot

Save work and quit all instances using the data directory with Command-Q. Closing the window may leave the service running. Upgrade by replacing the whole app. If data rollback is required, copy the data directory after quitting and keep the credential recovery bundle separately. Workspace files outside the data directory, system permissions and Keychain have separate recovery mechanisms.

Launch the upgraded app from Applications. Check workspaces, conversation history, attachments and the desktop capabilities you use. To roll back, quit the new version, restore the pre-upgrade data to a separate directory and start the matching older version against that directory. Uninstall by quitting and removing the app. User data stays in its directory.

For connection failures, check endpoint, model name, protocol and authentication. For missing desktop tools, check the installed variant and macOS permissions. The Help menu provides logs and guides inside the app. See the [User Guide](USER-GUIDE_EN.md) for daily operation.
