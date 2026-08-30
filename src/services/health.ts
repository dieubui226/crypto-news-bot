/**
 * Silent-failure detection.
 *
 * The bot once ran for a full day producing green Actions runs and no
 * messages: a seeding bug meant every cycle rebuilt an empty database and
 * broadcast nothing. Nothing noticed, because "no news worth sending" and
 * "completely broken" look identical from outside. The three states below
 * cannot be healthy, and each pages the operator on the way in and on the way
 * out rather than once per run.
 *
 * State lives in its own file with its own cache entry, deliberately separate
 * from the article database: the failure this exists to catch is the article
 * database going missing, so sharing its fate would blind the check exactly
 * when it matters.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export type AlertId = 'state-loss' | 'dead-crawl' | 'silence';

export interface HealthAlert {
  id: AlertId;
  text: string;
  recovered: boolean;
}

interface HealthState {
  runs: number;
  lastSentAt?: string;
  emptyCrawlStreak: number;
  /** Alert id -> when it was last announced, so a standing problem re-pages. */
  activeAlerts: Record<string, string>;
}

const EMPTY_STATE: HealthState = { runs: 0, emptyCrawlStreak: 0, activeAlerts: {} };

/** One blank crawl is a network blip; several in a row is a broken source list. */
const EMPTY_CRAWL_TOLERANCE = 3;
/** A standing problem is announced again after this long, so it is not forgotten. */
const REPEAT_ALERT_HOURS = 12;

export class HealthMonitor {
  private statePath: string;
  private state: HealthState = { ...EMPTY_STATE, activeAlerts: {} };
  private existed = false;
  private silenceHours: number;

  constructor(statePath: string, silenceHours: number) {
    this.statePath = path.resolve(statePath);
    this.silenceHours = silenceHours;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HealthState>;
      this.state = {
        runs: parsed.runs ?? 0,
        lastSentAt: parsed.lastSentAt,
        emptyCrawlStreak: parsed.emptyCrawlStreak ?? 0,
        activeAlerts: parsed.activeAlerts ?? {}
      };
      this.existed = true;
      console.log(`[Health] State loaded. ${this.state.runs} previous run(s), last broadcast ${this.state.lastSentAt || 'never'}.`);
    } catch {
      // A missing or corrupt file means no history, which is not itself a fault.
      this.state = { ...EMPTY_STATE, activeAlerts: {} };
      this.existed = false;
      console.log('[Health] No previous state found. Treating this as the first run.');
    }
    this.state.runs++;
  }

  /** True when this process has no record of any earlier run. */
  get isFirstEverRun(): boolean {
    return !this.existed;
  }

  recordCrawl(articlesFound: number): void {
    this.state.emptyCrawlStreak = articlesFound === 0 ? this.state.emptyCrawlStreak + 1 : 0;
  }

  recordBroadcast(): void {
    this.state.lastSentAt = new Date().toISOString();
  }

  /**
   * Decides which alerts to raise and which to stand down, and updates the
   * record of what has already been announced.
   *
   * `databaseIsEmpty` combined with `cacheWasRestored` is the signature of lost
   * state: a run that inherited a database and still found nothing in it.
   */
  evaluate(databaseIsEmpty: boolean, cacheWasRestored: boolean): HealthAlert[] {
    const problems = new Map<AlertId, string>();

    if (cacheWasRestored && databaseIsEmpty && !this.isFirstEverRun) {
      problems.set(
        'state-loss',
        'Bot vừa khởi động với database rỗng dù đã khôi phục được cache. Toàn bộ lịch sử chống trùng đã mất, và bot sẽ nạp nền im lặng thay vì gửi tin.'
      );
    }

    if (this.state.emptyCrawlStreak >= EMPTY_CRAWL_TOLERANCE) {
      problems.set(
        'dead-crawl',
        `${this.state.emptyCrawlStreak} chu kỳ liên tiếp không lấy được bài nào từ bất kỳ nguồn nào. Nhiều khả năng mạng bị chặn hoặc toàn bộ danh sách nguồn đã hỏng.`
      );
    }

    const silentHours = this.hoursSinceLastBroadcast();
    if (silentHours !== null && silentHours >= this.silenceHours) {
      problems.set(
        'silence',
        `Bot chưa gửi tin nào trong ${Math.floor(silentHours)} giờ. Các run vẫn chạy, nên đây là lỗi thầm lặng chứ không phải hết tin.`
      );
    }

    const alerts: HealthAlert[] = [];
    const now = new Date();

    for (const [id, text] of problems) {
      const announcedAt = this.state.activeAlerts[id];
      const isNew = !announcedAt;
      const isStale =
        !isNew && (now.getTime() - new Date(announcedAt).getTime()) / 3600000 >= REPEAT_ALERT_HOURS;
      if (isNew || isStale) {
        alerts.push({ id, text, recovered: false });
        this.state.activeAlerts[id] = now.toISOString();
      }
    }

    for (const id of Object.keys(this.state.activeAlerts)) {
      if (!problems.has(id as AlertId)) {
        alerts.push({ id: id as AlertId, text: RECOVERY_TEXT[id as AlertId] || 'Sự cố đã được khắc phục.', recovered: true });
        delete this.state.activeAlerts[id];
      }
    }

    return alerts;
  }

  /** Hours since the last broadcast, or null when nothing has ever been sent. */
  private hoursSinceLastBroadcast(): number | null {
    if (!this.state.lastSentAt) {
      // Never having sent anything is only suspicious once the bot has had
      // plenty of chances. A brand new deployment has not earned an alert yet.
      return this.state.runs >= 8 ? this.silenceHours : null;
    }
    return (Date.now() - new Date(this.state.lastSentAt).getTime()) / 3600000;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(this.state), 'utf8');
  }
}

const RECOVERY_TEXT: Record<AlertId, string> = {
  'state-loss': 'Database đã có lại dữ liệu. Chống trùng hoạt động bình thường.',
  'dead-crawl': 'Đã lấy được bài từ các nguồn trở lại.',
  'silence': 'Bot đã gửi tin trở lại.'
};

export default HealthMonitor;
