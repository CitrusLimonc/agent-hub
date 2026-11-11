import type { TaskStore } from './taskStore';
import type { TaskRunner, TaskStatusEvent } from './taskRunner';
import { buildHandoffBrief } from './handoffBuilder';

/**
 * Wires the one failover rule this app implements: a failed Codex task gets
 * its captured events turned into a handoff brief and handed to a fresh
 * Claude Code task in the same working directory. Claude Code failures are
 * not failed-over anywhere (out of scope — see README roadmap).
 */
export function installFailoverController(store: TaskStore, runner: TaskRunner) {
  runner.on('status', (evt: TaskStatusEvent) => {
    if (evt.agent !== 'codex' || evt.status !== 'failed') return;

    const task = store.getTask(evt.taskId);
    if (!task) return;

    const events = store.getEvents(evt.taskId).map((e) => e.raw);
    const brief = buildHandoffBrief(task, events);

    runner.start('claude', task.cwd, brief, { handoffFromTaskId: evt.taskId });
    store.updateStatus(evt.taskId, 'handed_off');
  });
}
