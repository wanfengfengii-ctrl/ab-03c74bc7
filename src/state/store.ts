// 事件存储：本地工作台持久化的不可改写事件日志
// - 所有提交先从 localStorage 中的最新事件日志重放，再校验修订号，杜绝陈旧写入
// - 跨标签页通过 storage 事件实时同步；刷新/重开后从首项记录重放还原全过程
import type { Command, Event, State } from '../domain/types.ts';
import { RevisionConflictError } from '../domain/types.ts';
import { replay } from '../domain/replay.ts';
import { decideEvent } from '../domain/commands.ts';

const STORAGE_KEY = 'desalination.eventLog.v1';

type Listener = (state: State, events: Event[]) => void;

function loadEvents(): Event[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Event[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEvents(events: Event[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

export class EventStore {
  private events: Event[];
  private state: State;
  private listeners = new Set<Listener>();
  private lastConflictedRevision: number | null = null;

  constructor() {
    this.events = loadEvents();
    this.state = replay(this.events);
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        // 其他标签页写入：重新加载并重放
        this.events = loadEvents();
        this.state = replay(this.events);
        this.lastConflictedRevision = null;
        this.emit();
      }
    });
  }

  getState(): State {
    return this.state;
  }

  getEvents(): Event[] {
    return this.events;
  }

  getRevision(): number {
    return this.state.revision;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 以所见修订号提交命令。
   * 提交前强制以存储中的最新日志重放；修订号不符则拒绝写入并抛出 RevisionConflictError。
   */
  dispatch(command: Command): Event {
    // 关键：始终基于最新持久化日志重放，避免本标签页内存状态滞后
    this.events = loadEvents();
    this.state = replay(this.events);

    if (command.expectedRevision !== this.state.revision) {
      this.lastConflictedRevision = this.state.revision;
      this.emit();
      throw new RevisionConflictError(command.expectedRevision, this.state.revision);
    }

    const nowIso = new Date().toISOString();
    const { state: nextState, event } = decideEvent(this.state, command, nowIso);

    // 临保存前再次核对：若其他标签页已写入，则本次为陈旧操作，拒绝写入
    const fresh = replay(loadEvents());
    if (fresh.revision !== this.state.revision) {
      this.events = loadEvents();
      this.state = replay(this.events);
      this.lastConflictedRevision = this.state.revision;
      this.emit();
      throw new RevisionConflictError(command.expectedRevision, this.state.revision);
    }

    this.events = [...this.events, event];
    saveEvents(this.events);
    this.state = nextState;
    this.lastConflictedRevision = null;
    this.emit();
    return event;
  }

  /** 最近一次冲突时服务端（其他标签页）的修订号，用于界面提示 */
  get conflictedRevision(): number | null {
    return this.lastConflictedRevision;
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state, this.events);
  }
}

export const store = new EventStore();
