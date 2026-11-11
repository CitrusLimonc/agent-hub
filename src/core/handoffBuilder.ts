import type { TaskRecord } from './types';

interface Step {
  text: string;
}

/**
 * Builds the markdown brief handed to Claude Code when a Codex task fails.
 * Walks the Codex `item.completed` events we already captured live (no disk
 * parsing) and reconstructs: original task, ordered commands run + their
 * output, and the last thing Codex said before it died.
 */
export function buildHandoffBrief(task: TaskRecord, events: any[]): string {
  const steps: Step[] = [];
  let lastAgentMessage: string | null = null;

  for (const e of events) {
    if (e?.type !== 'item.completed' || !e.item) continue;
    const item = e.item;
    if (item.type === 'command_execution') {
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : '';
      const truncated = output.length > 400 ? `${output.slice(0, 400)}…(截断)` : output;
      steps.push({
        text: `\`${item.command}\` (exit ${item.exit_code ?? '?'})${truncated ? `\n   输出: ${truncated}` : ''}`,
      });
    } else if (item.type === 'agent_message' && typeof item.text === 'string') {
      lastAgentMessage = item.text;
    } else if (item.type === 'error' && typeof item.message === 'string') {
      steps.push({ text: `[错误] ${item.message}` });
    }
  }

  const stepsSection = steps.length
    ? steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')
    : '(未捕获到具体操作记录,可能在第一步就失败了)';

  return `你在接手一个从 Codex 切换过来的任务,因为 Codex 侧运行故障中断(通道限流/超时/连接失败等)。工作目录里已经发生的文件改动是真实落盘的,不是幻觉——请先用 git status / git diff 确认当前实际状态,再决定怎么继续,不要假设下面的记录和磁盘状态完全一致。

## 原始任务
${task.prompt}

## Codex 已执行的操作
${stepsSection}

## Codex 中断前的最后状态
${lastAgentMessage ?? '(没有捕获到最后的消息)'}

## 你的任务
请先确认当前工作目录的真实状态,然后继续完成上述原始任务。`;
}
