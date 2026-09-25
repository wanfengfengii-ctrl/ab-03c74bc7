// 资格判定：自上次换液以来，每件浸泡器物最近连续严格下降的轮数达到规定轮数，且末值不高于上限
import type {
  ArtifactQualification,
  RoundRecord,
  State,
  TankQualification,
  TankState
} from './types.ts';

export function qualifyArtifact(
  name: string,
  artifactId: string,
  rounds: RoundRecord[],
  limit: number,
  requiredRounds: number
): ArtifactQualification {
  const points = rounds.map((r) => {
    const reading = r.readings.find((x) => x.artifactId === artifactId);
    return {
      seq: r.seq,
      measuredAt: r.measuredAt,
      value: reading ? reading.value : Number.NaN
    };
  });

  // 全程是否每一步严格下降（趋势展示用）
  const strictlyDecreasing =
    points.length >= 2 &&
    points.every((p, i) => i === 0 || p.value < points[i - 1].value);

  // 连续严格下降后缀长度：末轮向前数，直到出现反弹/持平
  let streak = points.length;
  for (let i = points.length - 1; i >= 1; i--) {
    if (!(points[i].value < points[i - 1].value)) {
      streak = points.length - i;
      break;
    }
  }

  const lastValue = points.length > 0 ? points[points.length - 1].value : null;
  const lastWithinLimit = lastValue !== null && lastValue <= limit;
  const enoughRounds = streak >= requiredRounds;
  const qualified = points.length > 0 && enoughRounds && lastWithinLimit;

  return {
    artifactId,
    name,
    points,
    strictlyDecreasing,
    streak,
    lastValue,
    lastWithinLimit,
    enoughRounds,
    qualified
  };
}

export function qualifyTank(state: State, tankId: string): TankQualification {
  const ts: TankState = state.tanks[tankId];
  const soaking = ts.artifacts.filter((a) => a.status === 'soaking');
  const artifacts = soaking.map((a) =>
    qualifyArtifact(a.name, a.id, ts.rounds, ts.tank.limit, ts.tank.requiredRounds)
  );
  const allQualified = artifacts.length > 0 && artifacts.every((a) => a.qualified);

  // 整槽共同连续轮数 = 各浸泡器物连续严格下降后缀长度的最小值
  const streak =
    artifacts.length === 0
      ? 0
      : Math.min(
          ...artifacts.map((a) => {
            let s = a.points.length;
            for (let i = a.points.length - 1; i >= 1; i--) {
              if (!(a.points[i].value < a.points[i - 1].value)) {
                s = a.points.length - i;
                break;
              }
            }
            return s;
          })
        );

  let nextAction: TankQualification['nextAction'];
  let nextActionReason: string;
  if (allQualified) {
    nextAction = 'change';
    nextActionReason = '全部仍在浸泡器物已共同连续达标，可换液（清空轮次后继续复测）或完成出槽';
  } else if (ts.rounds.length === 0) {
    nextAction = 'submit';
    nextActionReason = '换液后尚未开始复测，请提交覆盖全部浸泡器物的第一轮读数';
  } else {
    nextAction = 'submit';
    const missing = Math.max(0, ts.tank.requiredRounds - streak);
    const limitOk = artifacts.every((a) => a.lastWithinLimit);
    if (missing > 0) {
      nextActionReason = `整槽共同连续严格下降 ${streak}/${ts.tank.requiredRounds} 轮，还需 ${missing} 轮连续严格下降`;
    } else if (!limitOk) {
      nextActionReason = `连续轮数已满足，但末值仍高于上限 ${ts.tank.limit} μS/cm，需继续下降`;
    } else {
      nextActionReason = '趋势尚未连续达标，出现反弹或持平；须重新形成连续严格下降序列';
    }
  }

  return {
    tankId,
    artifacts,
    allQualified,
    streak,
    requiredRounds: ts.tank.requiredRounds,
    limit: ts.tank.limit,
    nextAction,
    nextActionReason
  };
}
