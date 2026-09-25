// 命令处理：校验业务规则并产出事件；以所见修订号提交，陈旧操作拒绝写入
import type { Command, DomainError as DomainErrorType, Event, State } from './types.ts';
import type { DistributiveOmit } from './types.ts';
import { DomainError, RevisionConflictError } from './types.ts';
import { applyEvent } from './replay.ts';
import { qualifyTank } from './qualification.ts';

export type EventDraft = DistributiveOmit<Event, 'eventId'>;

let idCounter = 0;
export function resetIdCounterForTest(): void {
  idCounter = 0;
}
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * 校验命令并返回将追加的事件（不含 eventId，eventId 由 store 按当前修订号分配）。
 * 任何业务规则违反都抛出 DomainError；修订号不符抛出 RevisionConflictError。
 */
export function decide(state: State, command: Command, nowIso: string): EventDraft {
  if (command.expectedRevision !== state.revision) {
    throw new RevisionConflictError(command.expectedRevision, state.revision);
  }

  switch (command.kind) {
    case 'CreateTank': {
      if (!command.name.trim()) throw new DomainError('槽位名称不能为空');
      if (!isPositiveInteger(command.limit)) throw new DomainError('目标上限必须为正整数（μS/cm）');
      if (!isPositiveInteger(command.requiredRounds)) {
        throw new DomainError('所需连续轮数必须为正整数');
      }
      if (!Array.isArray(command.artifacts) || command.artifacts.length === 0) {
        throw new DomainError('每个槽位至少要有一件初始归属器物');
      }
      if (command.artifacts.some((a) => !a.name.trim())) {
        throw new DomainError('器物名称不能为空');
      }
      const tankId = nextId('tank');
      const artifactIds: string[] = [];
      const artifactNames: Record<string, string> = {};
      for (const a of command.artifacts) {
        const id = nextId('art');
        artifactIds.push(id);
        artifactNames[id] = a.name.trim();
      }
      return {
        type: 'TankCreated',
        at: nowIso,
        tankId,
        name: command.name.trim(),
        limit: command.limit,
        requiredRounds: command.requiredRounds,
        artifactIds,
        artifactNames
      };
    }

    case 'SubmitRound': {
      const ts = state.tanks[command.tankId];
      if (!ts) throw new DomainError('槽位不存在');

      const soaking = ts.artifacts.filter((a) => a.status === 'soaking');
      if (soaking.length === 0) throw new DomainError('该槽已无仍在浸泡的器物，不能再提交读数');

      // 每轮采样必须恰含一次每件（仍在浸泡器物）读数
      const ids = command.readings.map((r) => r.artifactId);
      if (ids.length !== soaking.length) {
        throw new DomainError(
          `本轮读数必须恰好覆盖全部 ${soaking.length} 件仍在浸泡器物，当前收到 ${ids.length} 条`
        );
      }
      const expectedIds = new Set(soaking.map((a) => a.id));
      if (ids.some((id) => !expectedIds.has(id))) {
        throw new DomainError('读数中包含不属于该槽或已出槽的器物');
      }
      if (new Set(ids).size !== ids.length) {
        throw new DomainError('每件器物每轮只能有一次读数，不得重复');
      }
      if (command.readings.some((r) => !isNonNegativeInteger(r.value))) {
        throw new DomainError('电导率读数必须为非负整数（μS/cm）');
      }

      // 时间严格递增
      const lastRound = ts.rounds[ts.rounds.length - 1];
      if (lastRound && !(command.measuredAt > lastRound.measuredAt)) {
        throw new DomainError(
          `采样时间必须严格递增：须晚于上一轮 ${new Date(lastRound.measuredAt).toLocaleString('zh-CN')}`
        );
      }
      if (!Number.isFinite(command.measuredAt) || command.measuredAt <= 0) {
        throw new DomainError('采样时间无效');
      }

      return {
        type: 'RoundSubmitted',
        at: nowIso,
        tankId: command.tankId,
        measuredAt: command.measuredAt,
        roundSeq: ts.tank.roundSeq + 1,
        readings: command.readings
          .map((r) => ({ artifactId: r.artifactId, value: r.value }))
          .sort((a, b) => a.artifactId.localeCompare(b.artifactId))
      };
    }

    case 'ChangeSolution': {
      const ts = state.tanks[command.tankId];
      if (!ts) throw new DomainError('槽位不存在');
      const q = qualifyTank(state, command.tankId);
      if (!q.allQualified) {
        throw new DomainError(
          `尚不可换液：${q.nextActionReason}（共同连续 ${q.streak}/${q.requiredRounds} 轮）`
        );
      }
      return { type: 'SolutionChanged', at: nowIso, tankId: command.tankId };
    }

    case 'CompleteArtifacts': {
      const ts = state.tanks[command.tankId];
      if (!ts) throw new DomainError('槽位不存在');
      const soaking = ts.artifacts.filter((a) => a.status === 'soaking');
      if (soaking.length === 0) throw new DomainError('该槽已无仍在浸泡的器物');
      const q = qualifyTank(state, command.tankId);
      if (!q.allQualified) {
        throw new DomainError(
          `尚不可出槽：${q.nextActionReason}（共同连续 ${q.streak}/${q.requiredRounds} 轮）`
        );
      }
      return {
        type: 'ArtifactCompleted',
        at: nowIso,
        tankId: command.tankId,
        artifactIds: soaking.map((a) => a.id)
      };
    }
  }
}

/** 纯函数式推进：decide + 分配 eventId/修订号 + apply */
export function decideEvent(state: State, command: Command, nowIso: string): { state: State; event: Event } {
  const draft = decide(state, command, nowIso);
  const event: Event = { ...draft, eventId: state.revision + 1 } as Event;
  return { state: applyEvent(state, event), event };
}

export type { DomainErrorType };
