# Ruyi for Mac architecture

The desktop host manages the local service and displays the workbench in WKWebView. Desktop windows and browsers use the same web interface and local HTTP API. Requests read snapshots or submit actions. Server-sent events deliver updates while tasks run. [Mac host](../desktop-macos/README.md) · [Web entry point](../app/public/index.html)

## Backend assembly and storage

The Node entry point loads the workbench runtime. Domain implementations live in `app/backend/`. Fragments in `app/src/` supply their dependencies. After editing a fragment, run `node ruyi-workbench/app/build.js` from the repository root. The generated inventories list cross-fragment references and HTTP routes. [Entry point](../app/server.js) · [Module dependencies](../../docs/architecture/module-dependency-graph.md) · [Routes](../../docs/architecture/route-inventory.md)

One service owns each data root. Startup obtains the operating-system lock before migration and recovery. Session headers and transcripts are stored separately. Switching execution engines preserves the workbench conversation. Changes to storage formats or recovery ordering need coverage with existing data. [Ownership](../app/backend/server-ownership.cjs) · [Durable state](../../docs/architecture/durable-state-inventory.md)

## From a session to execution

The session route selects Claude CLI or a configured provider for the next turn. The provider turn handles streaming events, tool calls and usage. The HTTP module manages endpoint candidates and retry eligibility. The workflow scheduler starts child tasks according to dependencies and resource availability. The UI receives pending interactions through the Mission and Intervention contract. [Session routing](../app/backend/session-engine-route.cjs) · [Provider turns](../app/backend/provider-turn.cjs) · [HTTP](../app/backend/provider-http.cjs) · [Interaction contract](../../docs/MISSION-SCHEMA.md)

Desktop automation uses local MCP tools. Available capabilities depend on the distribution, installed components and current macOS permissions. Full and Slim share product source. Packaging manifests and offline dependencies determine what ships with each variant. [Model workflow](MODEL-WORKFLOW-SPEC_EN.md) · [Release guide](MACOS-RELEASE_EN.md)
