import { app } from 'electron';
import path from 'node:path';
import { TaskStore } from '../src/core/taskStore';
import { TaskRunner } from '../src/core/taskRunner';
import { installFailoverController } from '../src/core/failoverController';

// Lazily-created singletons, shared by every IPC handler in main.ts. Lazy
// because `app.getPath('userData')` isn't valid until Electron is ready, and
// this file gets imported before that point.
let store: TaskStore | null = null;
let runner: TaskRunner | null = null;

export function getStore(): TaskStore {
  if (!store) {
    const dbPath = path.join(app.getPath('userData'), 'agent-hub.sqlite');
    store = new TaskStore(dbPath);
  }
  return store;
}

export function getRunner(): TaskRunner {
  if (!runner) {
    runner = new TaskRunner(getStore());
    installFailoverController(getStore(), runner);
  }
  return runner;
}
