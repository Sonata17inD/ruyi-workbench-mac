// Native media service; all subprocesses use the shared Mac supervisor.
const MediaInspection = require('./backend/media-inspection.cjs').createMediaInspection({ ProcessRuntime });
