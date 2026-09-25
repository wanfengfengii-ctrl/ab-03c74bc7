// 控制台界面：每槽本轮趋势、下一步资格、修订号、不可改写事件过程
import type { Event, State, TankState } from '../domain/types.ts';
import { DomainError, RevisionConflictError } from '../domain/types.ts';
import { qualifyTank } from '../domain/qualification.ts';
import { store } from '../state/store.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { style?: string } = {},
  children: Node[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(node, rest);
  if (style !== undefined) node.setAttribute('style', style);
  node.append(...children);
  return node;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function trendArrow(curr: number, prev: number | undefined): string {
  if (prev === undefined) return '';
  if (curr < prev) return '<span class="arrow-down">▼</span>';
  if (curr > prev) return '<span class="arrow-up">▲</span>';
  return '<span class="arrow-flat">＝</span>';
}

let flash: { kind: 'error' | 'conflict'; text: string } | null = null;
function flashError(err: unknown): void {
  if (err instanceof RevisionConflictError) {
    flash = {
      kind: 'conflict',
      text: `操作被拒绝：${err.message}。页面已更新为其他标签页写入的最新状态，请在最新状态上重新操作。`
    };
  } else if (err instanceof DomainError) {
    flash = { kind: 'error', text: err.message };
  } else {
    flash = { kind: 'error', text: String(err) };
  }
  render();
}

function renderCreatePanel(): HTMLElement {
  const panel = el('section', { className: 'panel' });
  panel.append(el('h2', { textContent: '建立槽位' }));

  const nameInput = el('input', { type: 'text', placeholder: '如：三号浸泡槽', required: true }) as HTMLInputElement;
  const limitInput = el('input', { type: 'number', min: '1', step: '1', value: '50', placeholder: '上限 μS/cm' }) as HTMLInputElement;
  const roundsInput = el('input', { type: 'number', min: '1', step: '1', value: '3' }) as HTMLInputElement;

  const namesWrap = el('div', { className: 'artifact-names' });
  function addArtifactName(value = ''): void {
    const input = el('input', {
      type: 'text',
      placeholder: '器物名称',
      value
    }) as HTMLInputElement;
    input.style.minWidth = '140px';
    namesWrap.append(input);
  }
  addArtifactName();
  addArtifactName();

  const addBtn = el('button', {
    className: 'secondary',
    type: 'button',
    textContent: '＋ 增加器物'
  });
  addBtn.addEventListener('click', () => addArtifactName());

  const createBtn = el('button', { type: 'button', textContent: '建立槽位' });
  createBtn.addEventListener('click', () => {
    const names = Array.from(namesWrap.querySelectorAll<HTMLInputElement>('input'))
      .map((i) => i.value.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
    try {
      store.dispatch({
        kind: 'CreateTank',
        expectedRevision: store.getRevision(),
        name: nameInput.value,
        limit: Number(limitInput.value),
        requiredRounds: Number(roundsInput.value),
        artifacts: names.length > 0 ? names : [{ name: '' }]
      });
      flash = null;
    } catch (err) {
      flashError(err);
    }
  });

  panel.append(
    el('div', { className: 'row' }, [
      el('div', { className: 'field' }, [el('label', { textContent: '槽位名称' }), nameInput]),
      el('div', { className: 'field' }, [
        el('label', { textContent: '电导率目标上限（μS/cm，整数）' }),
        limitInput
      ]),
      el('div', { className: 'field' }, [el('label', { textContent: '所需连续轮数' }), roundsInput])
    ]),
    namesWrap,
    el('div', { className: 'row', style: 'margin-top:10px' }, [addBtn, createBtn])
  );
  return panel;
}

function valueAt(ts: TankState, roundSeqIndex: number, artifactId: string): number | undefined {
  const r = ts.rounds[roundSeqIndex];
  if (!r) return undefined;
  const reading = r.readings.find((x) => x.artifactId === artifactId);
  return reading?.value;
}

function renderTankCard(state: State, ts: TankState): HTMLElement {
  const card = el('article', { className: 'tank-card' });
  const revision = state.revision;
  const q = qualifyTank(state, ts.tank.id);

  card.append(
    el('div', { className: 'tank-head' }, [
      el('h3', { textContent: ts.tank.name }),
      el('span', {
        className: 'meta',
        textContent: `修订号 r${revision} · 上限 ${ts.tank.limit} · 连续要求 ${ts.tank.requiredRounds} 轮`
      })
    ])
  );

  // 器物清单与状态
  const artifactLine = el('div', { className: 'meta' });
  for (const a of ts.artifacts) {
    const tag = `<span class="tag ${a.status}">${a.status === 'soaking' ? '浸泡中' : '已出槽'}</span>`;
    artifactLine.insertAdjacentHTML('beforeend', `${escapeHtml(a.name)}${tag} `);
  }
  card.append(artifactLine);

  // 本轮趋势表
  if (ts.rounds.length > 0) {
    const table = el('table', { className: 'rounds' });
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', { textContent: '轮次' }), el('th', { textContent: '采样时间' }));
    for (const a of ts.artifacts) headRow.append(el('th', { textContent: a.name }));
    thead.append(headRow);
    table.append(thead);

    const tbody = el('tbody');
    ts.rounds.forEach((r, idx) => {
      const tr = el('tr');
      tr.append(el('td', { textContent: `#${r.seq}` }));
      tr.append(el('td', { textContent: new Date(r.measuredAt).toLocaleString('zh-CN') }));
      for (const a of ts.artifacts) {
        const v = valueAt(ts, idx, a.id);
        const td = el('td');
        if (v === undefined) {
          td.textContent = '—';
        } else {
          const prev = valueAt(ts, idx - 1, a.id);
          const over = idx === ts.rounds.length - 1 && v > ts.tank.limit;
          td.innerHTML = `${over ? '<span class="over-limit">' : ''}${v}${over ? '</span>' : ''} ${trendArrow(v, prev)}`;
        }
        tr.append(td);
      }
      tbody.append(tr);
    });
    table.append(tbody);
    card.append(table);
  } else {
    card.append(el('div', { className: 'meta', textContent: '自上次换液以来尚无复测轮次。' }));
  }

  // 逐器物连续计数
  const streakLine = el('div', { className: 'streak-line' });
  streakLine.innerHTML = q.artifacts
    .map((a) => {
      const last = a.lastValue === null ? '—' : a.lastValue;
      const okMark = a.qualified ? '✅' : '…';
      return `${escapeHtml(a.name)}：连续↓${a.streak}轮 / 末值${last}${
        a.lastValue !== null && a.lastValue > q.limit ? '（超上限）' : ''
      } ${okMark}`;
    })
    .join('　');
  if (q.artifacts.length === 0) streakLine.textContent = '槽内器物均已出槽。';
  card.append(streakLine);

  // 下一步资格
  const qualClass = q.allQualified ? 'ok' : ts.rounds.length === 0 ? 'idle' : 'wait';
  card.append(
    el('div', { className: `qual ${qualClass}` }, [
      el('strong', {
        textContent: q.allQualified
          ? '✔ 整槽合格'
          : `下一资格：提交第 ${ts.rounds.length + 1} 轮读数（共同连续 ${q.streak}/${q.requiredRounds}）`
      }),
      el('div', { textContent: q.nextActionReason })
    ])
  );

  const soaking = ts.artifacts.filter((a) => a.status === 'soaking');

  // 提交一轮读数：恰好每件浸泡器物一次
  if (soaking.length > 0) {
    const form = el('div', { className: 'submit-form' });
    const inputsWrap = el('div', { className: 'reading-inputs' });
    const inputs = new Map<string, HTMLInputElement>();
    for (const a of soaking) {
      const input = el('input', {
        type: 'number',
        min: '0',
        step: '1',
        placeholder: '整数',
        value: ''
      }) as HTMLInputElement;
      const label = el('label');
      label.append(document.createTextNode(a.name), input);
      inputsWrap.append(label);
      inputs.set(a.id, input);
    }

    const submitBtn = el('button', { type: 'button', textContent: `提交第 ${ts.rounds.length + 1} 轮（覆盖全部 ${soaking.length} 件）` });
    submitBtn.addEventListener('click', () => {
      const readings = soaking.map((a) => ({
        artifactId: a.id,
        value: Number(inputs.get(a.id)!.value)
      }));
      const lastMeasuredAt = ts.rounds.length > 0 ? ts.rounds[ts.rounds.length - 1].measuredAt : 0;
      const measuredAt = Math.max(Date.now(), lastMeasuredAt + 1);
      try {
        store.dispatch({
          kind: 'SubmitRound',
          expectedRevision: revision,
          tankId: ts.tank.id,
          readings,
          measuredAt
        });
        flash = null;
      } catch (err) {
        flashError(err);
      }
    });

    form.append(
      el('div', { className: 'meta', textContent: '一轮整数读数，每件浸泡器物恰好一次；采样时间须严格递增。' }),
      inputsWrap,
      submitBtn
    );
    card.append(form);
  }

  // 换液 / 出槽
  const actions = el('div', { className: 'actions' });
  const changeBtn = el('button', {
    type: 'button',
    className: 'secondary',
    textContent: '换液（清空该槽轮次）',
    disabled: !q.allQualified
  });
  changeBtn.title = q.allQualified ? '换液后轮次清零，器物继续浸泡' : q.nextActionReason;
  changeBtn.addEventListener('click', () => {
    try {
      store.dispatch({ kind: 'ChangeSolution', expectedRevision: revision, tankId: ts.tank.id });
      flash = null;
    } catch (err) {
      flashError(err);
    }
  });

  const completeBtn = el('button', {
    type: 'button',
    className: 'danger',
    textContent: '完成出槽',
    disabled: !q.allQualified || soaking.length === 0
  });
  completeBtn.title = q.allQualified ? '全部浸泡器物出槽，之后不再接受读数' : q.nextActionReason;
  completeBtn.addEventListener('click', () => {
    if (!window.confirm(`确认让「${ts.tank.name}」中全部 ${soaking.length} 件器物完成出槽？出槽后不可再提交读数。`)) {
      return;
    }
    try {
      store.dispatch({ kind: 'CompleteArtifacts', expectedRevision: revision, tankId: ts.tank.id });
      flash = null;
    } catch (err) {
      flashError(err);
    }
  });

  actions.append(changeBtn, completeBtn);
  card.append(actions);
  return card;
}

function eventSummary(e: Event): string {
  switch (e.type) {
    case 'TankCreated':
      return `建立槽位「${e.name}」上限${e.limit} 连续${e.requiredRounds}轮，器物：${Object.values(e.artifactNames).join('、')}`;
    case 'RoundSubmitted':
      return `槽位 ${e.tankId} 第${e.roundSeq}轮 ${new Date(e.measuredAt).toLocaleString('zh-CN')} 读数 ${e.readings
        .map((r) => `${r.artifactId}=${r.value}`)
        .join(' ')}`;
    case 'SolutionChanged':
      return `槽位 ${e.tankId} 换液，轮次清空`;
    case 'ArtifactCompleted':
      return `槽位 ${e.tankId} 出槽器物：${e.artifactIds.join('、')}`;
  }
}

function renderEventLog(events: Event[]): HTMLElement {
  const details = el('details', { className: 'panel eventlog' });
  details.open = true;
  details.append(
    el('summary', {
      textContent: `不可改写过程（从首项记录重放，共 ${events.length} 个事件 / 修订号 r${events.length}）`
    })
  );
  if (events.length === 0) {
    details.append(el('div', { className: 'empty', textContent: '尚无任何记录。' }));
    return details;
  }
  const list = el('ul', { className: 'event-list' });
  for (const e of events) {
    const li = el('li');
    li.append(
      el('span', { className: 'eid', textContent: `#${e.eventId}` }),
      el('span', { className: 'etype', textContent: e.type }),
      el('code', { className: 'payload', textContent: eventSummary(e) })
    );
    list.append(li);
  }
  details.append(list);
  return details;
}

function render(): void {
  const state = store.getState();
  const events = store.getEvents();

  app.innerHTML = '';
  const header = el('header', { className: 'topbar' });
  header.append(
    el('h1', { textContent: '金属文物脱盐换液控制台' }),
    el('span', { className: 'rev-badge', textContent: `当前修订号 r${state.revision}` })
  );
  app.append(header);

  const main = el('main');

  if (flash) {
    const div = el('div', { className: `flash ${flash.kind}`, textContent: flash.text });
    main.append(div);
  }

  main.append(renderCreatePanel());

  const tankStates = Object.values(state.tanks);
  if (tankStates.length > 0) {
    const grid = el('div', { className: 'tank-grid' });
    for (const ts of tankStates) grid.append(renderTankCard(state, ts));
    main.append(grid);
  } else {
    main.append(el('div', { className: 'panel empty', textContent: '还没有槽位。先建立槽位、器物初始归属、目标上限与所需连续轮数。' }));
  }

  main.append(renderEventLog(events));
  app.append(main);
}

store.subscribe(() => render());
render();
