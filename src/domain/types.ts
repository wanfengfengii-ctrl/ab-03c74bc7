// 领域类型定义

export type ArtifactStatus = 'soaking' | 'completed';

export interface Artifact {
  id: string;
  name: string;
  status: ArtifactStatus;
  /** 完成出槽的事件序号，出槽后不再接受读数 */
  completedAtEvent?: number;
}

export interface Tank {
  id: string;
  name: string;
  /** 电导率目标上限（μS/cm），末值须不高于此值 */
  limit: number;
  /** 所需连续合格轮数 */
  requiredRounds: number;
  artifactIds: string[];
  /** 自上次换液以来已记录的轮次序号（不含被换液清空的轮次） */
  roundSeq: number;
}

export interface Reading {
  artifactId: string;
  /** 电导率整数读数（μS/cm），必须为整数 */
  value: number;
}

// ---- 事件（不可改写，从首项记录重放） ----

export type Event =
  | {
      type: 'TankCreated';
      eventId: number;
      at: string;
      tankId: string;
      name: string;
      limit: number;
      requiredRounds: number;
      artifactIds: string[];
      artifactNames: Record<string, string>;
    }
  | {
      type: 'RoundSubmitted';
      eventId: number;
      at: string;
      tankId: string;
      /** 提交时的严格递增时间戳（ms） */
      measuredAt: number;
      roundSeq: number;
      readings: Reading[];
    }
  | {
      type: 'SolutionChanged';
      eventId: number;
      at: string;
      tankId: string;
    }
  | {
      type: 'ArtifactCompleted';
      eventId: number;
      at: string;
      tankId: string;
      artifactIds: string[];
    };

export interface RoundRecord {
  /** 槽内自换液后的轮次序号，从 1 开始 */
  seq: number;
  measuredAt: number;
  at: string;
  readings: Reading[];
}

export interface TankState {
  tank: Tank;
  artifacts: Artifact[];
  /** 自上次换液以来的轮次（换液会清空） */
  rounds: RoundRecord[];
}

export interface State {
  tanks: Record<string, TankState>;
  artifacts: Record<string, Artifact>;
  revision: number;
}

export interface ArtifactRoundPoint {
  seq: number;
  measuredAt: number;
  value: number;
}

export interface ArtifactQualification {
  artifactId: string;
  name: string;
  /** 自上次换液以来该器物的逐轮值 */
  points: ArtifactRoundPoint[];
  /** 是否连续每一步严格下降（全程趋势） */
  strictlyDecreasing: boolean;
  /** 末尾连续严格下降的轮数 */
  streak: number;
  /** 末值（最近一轮） */
  lastValue: number | null;
  /** 末值不高于上限 */
  lastWithinLimit: boolean;
  /** 连续达标的轮数是否已达到规定轮数 */
  enoughRounds: boolean;
  /** 该器物是否整体合格 */
  qualified: boolean;
}

export interface TankQualification {
  tankId: string;
  artifacts: ArtifactQualification[];
  /** 槽内全部仍在浸泡器物均合格 */
  allQualified: boolean;
  /** 当前连续合格轮数（取所有浸泡器物最小值） */
  streak: number;
  requiredRounds: number;
  limit: number;
  /** 下一步资格说明 */
  nextAction: 'submit' | 'change' | 'complete';
  nextActionReason: string;
}

export type Command =
  | {
      kind: 'CreateTank';
      expectedRevision: number;
      name: string;
      limit: number;
      requiredRounds: number;
      artifacts: { name: string }[];
    }
  | {
      kind: 'SubmitRound';
      expectedRevision: number;
      tankId: string;
      /** 每件仍在浸泡器物恰好一次的整数读数，按器物顺序给出 */
      readings: Reading[];
      measuredAt: number;
    }
  | {
      kind: 'ChangeSolution';
      expectedRevision: number;
      tankId: string;
    }
  | {
      kind: 'CompleteArtifacts';
      expectedRevision: number;
      tankId: string;
    };

export class RevisionConflictError extends Error {
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`修订号冲突：所见为 ${expected}，当前已为 ${actual}，请刷新到最新状态后重试`);
    this.name = 'RevisionConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 在联合类型上可分配的 Omit */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K & keyof T>
  : never;
