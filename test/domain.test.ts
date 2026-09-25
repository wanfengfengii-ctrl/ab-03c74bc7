import { describe, expect, it } from 'vitest';
import { replay } from '../src/domain/replay.ts';
import { decideEvent } from '../src/domain/commands.ts';
import { qualifyTank } from '../src/domain/qualification.ts';
import { DomainError, RevisionConflictError } from '../src/domain/types.ts';
import type { Command, Event } from '../src/domain/types.ts';

// 测试夹具：维护一条不可改写事件日志，每次命令从首项重放后再决定
class Harness {
  events: Event[] = [];

  get state() {
    return replay(this.events);
  }

  commit(command: Command, t = 1_000): Event {
    const { state: next, event } = decideEvent(this.state, command, new Date(t).toISOString());
    this.events.push(event);
    // 不变量：重放结果与增量推进一致，修订号连续
    const replayed = replay(this.events);
    expect(replayed.revision).toBe(next.revision);
    expect(event.eventId).toBe(this.events.length);
    return event;
  }

  tryCommit(command: Command, t = 1_000): unknown {
    try {
      this.commit(command, t);
      return null;
    } catch (err) {
      return err;
    }
  }

  tankId(): string {
    return Object.keys(this.state.tanks)[0];
  }

  create(limit = 50, rounds = 3, names = ['青铜鼎', '铁剑']): string {
    this.commit({
      kind: 'CreateTank',
      expectedRevision: this.state.revision,
      name: '一号槽',
      limit,
      requiredRounds: rounds,
      artifacts: names.map((name) => ({ name }))
    });
    return this.tankId();
  }

  submit(tankId: string, values: number[], measuredAt: number): void {
    const soaking = this.state.tanks[tankId].artifacts.filter((a) => a.status === 'soaking');
    this.commit(
      {
        kind: 'SubmitRound',
        expectedRevision: this.state.revision,
        tankId,
        readings: soaking.map((a, i) => ({ artifactId: a.id, value: values[i] })),
        measuredAt
      },
      measuredAt
    );
  }

  trySubmit(tankId: string, values: number[], measuredAt: number): unknown {
    const soaking = this.state.tanks[tankId].artifacts.filter((a) => a.status === 'soaking');
    return this.tryCommit(
      {
        kind: 'SubmitRound',
        expectedRevision: this.state.revision,
        tankId,
        readings: soaking.map((a, i) => ({ artifactId: a.id, value: values[i] })),
        measuredAt
      },
      measuredAt
    );
  }

  trySubmitRaw(tankId: string, readings: { artifactId: string; value: number }[], measuredAt: number): unknown {
    return this.tryCommit(
      {
        kind: 'SubmitRound',
        expectedRevision: this.state.revision,
        tankId,
        readings,
        measuredAt
      },
      measuredAt
    );
  }
}

describe('建槽校验', () => {
  it('要求正整数上限与连续轮数、至少一件器物、名称非空', () => {
    const h = new Harness();
    const bad: Command[] = [
      { kind: 'CreateTank', expectedRevision: 0, name: '槽', limit: 1.5, requiredRounds: 2, artifacts: [{ name: 'a' }] },
      { kind: 'CreateTank', expectedRevision: 0, name: '槽', limit: 50, requiredRounds: 0, artifacts: [{ name: 'a' }] },
      { kind: 'CreateTank', expectedRevision: 0, name: '槽', limit: 50, requiredRounds: 2, artifacts: [] },
      { kind: 'CreateTank', expectedRevision: 0, name: '   ', limit: 50, requiredRounds: 2, artifacts: [{ name: 'a' }] }
    ];
    for (const cmd of bad) expect(h.tryCommit(cmd)).toBeInstanceOf(DomainError);
  });
});

describe('每轮读数', () => {
  it('必须恰含每件浸泡器物一次、为整数，时间严格递增', () => {
    const h = new Harness();
    const id = h.create();
    const [a, b] = h.state.tanks[id].artifacts.map((x) => x.id);

    expect((h.trySubmitRaw(id, [{ artifactId: a, value: 100 }], 1000) as Error).message).toMatch(/恰好覆盖/);
    expect(
      (h.trySubmitRaw(
        id,
        [
          { artifactId: a, value: 100 },
          { artifactId: a, value: 90 }
        ],
        1000
      ) as Error).message
    ).toMatch(/一次/);
    expect(
      (h.trySubmitRaw(
        id,
        [
          { artifactId: a, value: 100 },
          { artifactId: 'nope', value: 90 }
        ],
        1000
      ) as Error).message
    ).toMatch(/不属于/);
    expect(
      (h.trySubmitRaw(
        id,
        [
          { artifactId: a, value: 100.5 },
          { artifactId: b, value: 90 }
        ],
        1000
      ) as Error).message
    ).toMatch(/整数/);

    h.submit(id, [100, 90], 1000);
    expect(h.state.tanks[id].rounds).toHaveLength(1);
    expect((h.trySubmit(id, [90, 80], 1000) as Error).message).toMatch(/严格递增/);
    expect((h.trySubmit(id, [90, 80], 999) as Error).message).toMatch(/严格递增/);
  });
});

describe('整槽共同连续合格', () => {
  it('单件短暂下降不得算作整槽合格', () => {
    const h = new Harness();
    const id = h.create(50, 3);

    h.submit(id, [100, 120], 1000);
    h.submit(id, [80, 100], 2000);
    expect(qualifyTank(h.state, id).allQualified).toBe(false);
    expect(qualifyTank(h.state, id).streak).toBe(2);

    // 铁剑持平，青铜鼎继续下降：整槽仍不合格
    h.submit(id, [60, 100], 3000);
    const q = qualifyTank(h.state, id);
    expect(q.allQualified).toBe(false);
    expect(q.artifacts.find((x) => x.name === '铁剑')!.streak).toBe(1);
  });

  it('连续 N 轮严格下降且末值不高于上限才可换液，换液清空轮次', () => {
    const h = new Harness();
    const id = h.create(50, 3);

    h.submit(id, [90, 95], 1000);
    h.submit(id, [70, 80], 2000);
    h.submit(id, [55, 60], 3000); // 趋势满足但末值超上限
    expect(qualifyTank(h.state, id).allQualified).toBe(false);
    expect(
      (h.tryCommit({ kind: 'ChangeSolution', expectedRevision: h.state.revision, tankId: id }) as Error).message
    ).toMatch(/尚不可换液/);

    h.submit(id, [45, 48], 4000);
    const q = qualifyTank(h.state, id);
    expect(q.allQualified).toBe(true);
    expect(q.streak).toBe(4);

    const event = h.commit({ kind: 'ChangeSolution', expectedRevision: h.state.revision, tankId: id });
    expect(event.type).toBe('SolutionChanged');
    expect(h.state.tanks[id].rounds).toEqual([]);
    expect(h.state.tanks[id].tank.roundSeq).toBe(0);

    // 换液后需重新累计，不能立刻再换
    expect(
      (h.tryCommit({ kind: 'ChangeSolution', expectedRevision: h.state.revision, tankId: id }) as Error).message
    ).toMatch(/尚不可换液/);
  });

  it('反弹后重新形成连续严格下降后缀仍可合格', () => {
    const h = new Harness();
    const id = h.create(50, 2);
    h.submit(id, [90, 90], 1000);
    h.submit(id, [100, 80], 2000);
    expect(qualifyTank(h.state, id).allQualified).toBe(false);
    h.submit(id, [60, 70], 3000);
    h.submit(id, [45, 40], 4000);
    expect(qualifyTank(h.state, id).allQualified).toBe(true);
  });

  it('所需轮数为 1 时，一轮末值达标即可', () => {
    const h = new Harness();
    const id = h.create(50, 1);
    h.submit(id, [60, 40], 1000);
    expect(qualifyTank(h.state, id).allQualified).toBe(false);
    h.submit(id, [40, 35], 2000);
    // 单件本轮达标仍不足：两件末值都须达标（青铜鼎上一轮 60 已过去，当前末值 40 达标）
    expect(qualifyTank(h.state, id).allQualified).toBe(true);
  });
});

describe('出槽', () => {
  it('完成出槽后不再接受读数，未合格不得出槽', () => {
    const h = new Harness();
    const id = h.create(50, 1);
    h.submit(id, [40, 45], 1000);
    expect(qualifyTank(h.state, id).allQualified).toBe(true);

    const event = h.commit({ kind: 'CompleteArtifacts', expectedRevision: h.state.revision, tankId: id });
    expect(event.type).toBe('ArtifactCompleted');
    expect(h.state.tanks[id].artifacts.every((a) => a.status === 'completed')).toBe(true);
    expect((h.trySubmit(id, [30, 30], 2000) as Error).message).toMatch(/已无仍在浸泡/);

    const h2 = new Harness();
    const id2 = h2.create(10, 1);
    h2.submit(id2, [40, 45], 1000);
    expect(
      (h2.tryCommit({ kind: 'CompleteArtifacts', expectedRevision: h2.state.revision, tankId: id2 }) as Error).message
    ).toMatch(/尚不可出槽/);
  });
});

describe('修订号乐观并发', () => {
  it('陈旧修订号不得写入，最新状态不受影响', () => {
    const h = new Harness();
    const id = h.create();
    const revisionBefore = h.state.revision;
    const err = h.tryCommit({
      kind: 'SubmitRound',
      expectedRevision: 0,
      tankId: id,
      readings: h.state.tanks[id].artifacts.map((a) => ({ artifactId: a.id, value: 1 })),
      measuredAt: 1
    });
    expect(err).toBeInstanceOf(RevisionConflictError);
    // 拒绝写入：修订号与轮次均不变
    expect(h.state.revision).toBe(revisionBefore);
    expect(h.state.tanks[id].rounds).toHaveLength(0);
  });
});

describe('从首项记录重放', () => {
  it('仅凭事件日志即可还原相同过程与资格', () => {
    const h = new Harness();
    const id = h.create(50, 2);
    h.submit(id, [80, 90], 1000);
    h.submit(id, [60, 70], 2000);
    h.submit(id, [40, 45], 3000);
    h.commit({ kind: 'ChangeSolution', expectedRevision: h.state.revision, tankId: id });
    h.submit(id, [70, 75], 4000);

    // 模拟刷新/重新打开：丢弃所有内存状态，仅从首项事件重放
    const reopened = replay(h.events);
    expect(reopened.revision).toBe(h.events.length);
    const ts = reopened.tanks[id];
    expect(ts.rounds).toHaveLength(1);
    expect(ts.rounds[0].measuredAt).toBe(4000);
    expect(qualifyTank(reopened, id).streak).toBe(1);
    expect(ts.artifacts.map((a) => a.name)).toEqual(['青铜鼎', '铁剑']);
  });
});
