// 事件重放（不可改写过程）：从首项事件开始 fold 出当前状态
import type { Event, State, TankState } from './types.ts';

export function emptyState(): State {
  return { tanks: {}, artifacts: {}, revision: 0 };
}

export function replay(events: Event[]): State {
  let state = emptyState();
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

export function applyEvent(state: State, event: Event): State {
  switch (event.type) {
    case 'TankCreated': {
      const tankState: TankState = {
        tank: {
          id: event.tankId,
          name: event.name,
          limit: event.limit,
          requiredRounds: event.requiredRounds,
          artifactIds: event.artifactIds,
          roundSeq: 0
        },
        artifacts: event.artifactIds.map((id) => ({
          id,
          name: event.artifactNames[id],
          status: 'soaking' as const
        })),
        rounds: []
      };
      const artifacts = { ...state.artifacts };
      for (const a of tankState.artifacts) artifacts[a.id] = a;
      return {
        ...state,
        tanks: { ...state.tanks, [event.tankId]: tankState },
        artifacts,
        revision: event.eventId
      };
    }
    case 'RoundSubmitted': {
      const prev = state.tanks[event.tankId];
      const next: TankState = {
        ...prev,
        tank: { ...prev.tank, roundSeq: event.roundSeq },
        rounds: [
          ...prev.rounds,
          {
            seq: event.roundSeq,
            measuredAt: event.measuredAt,
            at: event.at,
            readings: event.readings.map((r) => ({ ...r }))
          }
        ]
      };
      return {
        ...state,
        tanks: { ...state.tanks, [event.tankId]: next },
        revision: event.eventId
      };
    }
    case 'SolutionChanged': {
      // 换液清空该槽的轮次；器物仍继续浸泡
      const prev = state.tanks[event.tankId];
      const next: TankState = {
        ...prev,
        tank: { ...prev.tank, roundSeq: 0 },
        rounds: []
      };
      return {
        ...state,
        tanks: { ...state.tanks, [event.tankId]: next },
        revision: event.eventId
      };
    }
    case 'ArtifactCompleted': {
      const prev = state.tanks[event.tankId];
      const completedSet = new Set(event.artifactIds);
      const artifacts = prev.artifacts.map((a) =>
        completedSet.has(a.id)
          ? { ...a, status: 'completed' as const, completedAtEvent: event.eventId }
          : a
      );
      const globalArtifacts = { ...state.artifacts };
      for (const id of event.artifactIds) {
        const a = globalArtifacts[id];
        if (a) globalArtifacts[id] = { ...a, status: 'completed', completedAtEvent: event.eventId };
      }
      return {
        ...state,
        tanks: {
          ...state.tanks,
          [event.tankId]: { ...prev, artifacts }
        },
        artifacts: globalArtifacts,
        revision: event.eventId
      };
    }
  }
}
