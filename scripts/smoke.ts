// 业务模块冒烟：端到端走通 建槽 → 多轮共同下降 → 换液 → 再泡 → 出槽，
// 并校验构建产物中的静态站点与健康检查页。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replay } from '../src/domain/replay.ts';
import { decideEvent } from '../src/domain/commands.ts';
import { qualifyTank } from '../src/domain/qualification.ts';
import { RevisionConflictError } from '../src/domain/types.ts';
import type { Command, Event } from '../src/domain/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ---- 业务流程冒烟 ----
const events: Event[] = [];
function dispatch(cmd: Command): void {
  const state = replay(events);
  const { state: next, event } = decideEvent(state, cmd, new Date().toISOString());
  events.push(event);
  void next;
}

console.log('业务模块冒烟：');

// 建槽：2 件器物、上限 50、需连续 3 轮
dispatch({
  kind: 'CreateTank',
  expectedRevision: 0,
  name: '三号浸泡槽',
  limit: 50,
  requiredRounds: 3,
  artifacts: [{ name: '青铜鼎' }, { name: '铁剑' }]
});
let state = replay(events);
const tankId = Object.keys(state.tanks)[0];
const ids = state.tanks[tankId].artifacts.map((a) => a.id);
check('建槽后修订号为 1', state.revision === 1);

function round(v1: number, v2: number, at: number): void {
  dispatch({
    kind: 'SubmitRound',
    expectedRevision: replay(events).revision,
    tankId,
    readings: [
      { artifactId: ids[0], value: v1 },
      { artifactId: ids[1], value: v2 }
    ],
    measuredAt: at
  });
}

round(120, 130, 1000);
round(90, 100, 2000);
check('两轮共同下降时尚不合格', qualifyTank(replay(events), tankId).allQualified === false);

// 陈旧修订号必须被拒绝
let conflict: unknown = null;
try {
  decideEvent(replay(events), {
    kind: 'SubmitRound',
    expectedRevision: 1,
    tankId,
    readings: [
      { artifactId: ids[0], value: 80 },
      { artifactId: ids[1], value: 90 }
    ],
    measuredAt: 3000
  }, new Date().toISOString());
} catch (err) {
  conflict = err;
}
check('陈旧修订号操作被拒绝', conflict instanceof RevisionConflictError);

round(70, 80, 3000);
// 连续 3 轮（120→90→70、130→100→80）严格下降，但末值高于上限
check('末值超上限时不合格', qualifyTank(replay(events), tankId).allQualified === false);

round(45, 48, 4000);
const q = qualifyTank(replay(events), tankId);
check('共同连续严格下降且末值达标时整槽合格', q.allQualified && q.streak === 4);

// 换液
dispatch({ kind: 'ChangeSolution', expectedRevision: replay(events).revision, tankId });
state = replay(events);
check('换液清空该槽轮次', state.tanks[tankId].rounds.length === 0);
check('换液后不可立即再换', qualifyTank(state, tankId).allQualified === false);

// 再浸泡并合格后出槽
round(40, 42, 5000);
round(30, 32, 6000);
round(20, 22, 7000);
check('换液后重新累计三轮合格', qualifyTank(replay(events), tankId).allQualified === true);
dispatch({ kind: 'CompleteArtifacts', expectedRevision: replay(events).revision, tankId });
state = replay(events);
check(
  '出槽后器物标记完成且不再接受读数',
  state.tanks[tankId].artifacts.every((a) => a.status === 'completed')
);

let rejected: unknown = null;
try {
  dispatch({
    kind: 'SubmitRound',
    expectedRevision: replay(events).revision,
    tankId,
    readings: [
      { artifactId: ids[0], value: 10 },
      { artifactId: ids[1], value: 10 }
    ],
    measuredAt: 8000
  });
} catch (err) {
  rejected = err;
}
check('出槽后提交读数被拒绝', rejected instanceof Error);

// 仅凭事件日志重放，修订号连续
const reopened = replay(events);
check('重放后修订号等于事件总数', reopened.revision === events.length);

// ---- 构建产物冒烟 ----
console.log('构建产物冒烟：');
const distIndex = join(root, 'dist', 'index.html');
const distHealth = join(root, 'dist', 'health.html');
check('dist/index.html 存在', existsSync(distIndex));
check('健康检查页 dist/health.html 存在', existsSync(distHealth));
if (existsSync(distHealth)) {
  check('健康检查页内容可读取', readFileSync(distHealth, 'utf8').trim().length > 0);
}

if (failures.length > 0) {
  console.error(`\n冒烟失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('\n全部冒烟检查通过。');
