import * as fs from 'fs/promises';
import * as path from 'path';
import { ProcessedArticle } from '../types';
import { fingerprint, similarity, CANDIDATE_THRESHOLD, TitleFingerprint } from '../services/dedup';

export interface DuplicateCandidate {
  record: ProcessedArticle;
  score: number;
}

export class JSONDatabase {
  private dbPath: string;
  private subscribersPath: string;
  private memoryCache: Map<string, ProcessedArticle> = new Map();
  private subscribersCache: Set<number> = new Set();
  /**
   * Token fingerprints for broadcast articles only, keyed by URL. One entry
   * per headline we know for that story (the original and, when the AI
   * produced one, the Vietnamese translation).
   */
  private sentFingerprints: Map<string, TitleFingerprint[]> = new Map();
  /** True when memoryCache holds changes not yet written to disk. */
  private dirty = false;

  constructor(dbPath: string = 'db.json') {
    this.dbPath = path.resolve(dbPath);
    // Determine subscribers path in the same directory
    const dir = path.dirname(this.dbPath);
    this.subscribersPath = path.join(dir, 'subscribers.json');
  }

  /**
   * Initializes the database, loading existing records from disk
   */
  async init(): Promise<void> {
    // 1. Initialize Articles DB
    try {
      await fs.access(this.dbPath);
      const data = await fs.readFile(this.dbPath, 'utf8');
      const records: ProcessedArticle[] = JSON.parse(data);
      this.memoryCache.clear();
      this.sentFingerprints.clear();
      for (const record of records) {
        // Records written before dedup existed have no flags. A stored summary
        // only ever came from a broadcast, so it identifies the sent ones.
        if (record.sent === undefined) {
          record.sent = Boolean(record.summary);
        }
        if (!record.titleNorm) {
          record.titleNorm = fingerprint(record.title).normalized;
        }
        this.memoryCache.set(record.url, record);
        this.indexIfSent(record);
      }
      console.log(`[DB] Articles loaded. Tracking ${this.memoryCache.size} articles (${this.sentFingerprints.size} previously broadcast).`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('[DB] Articles file not found. Initializing a new one...');
        await this.saveArticles([]);
      } else {
        console.error('[DB] Failed to initialize articles:', error);
        throw error;
      }
    }

    // 2. Initialize Subscribers DB
    try {
      await fs.access(this.subscribersPath);
      const data = await fs.readFile(this.subscribersPath, 'utf8');
      const list: number[] = JSON.parse(data);
      this.subscribersCache = new Set(list);
      console.log(`[DB] Subscribers loaded. Tracking ${this.subscribersCache.size} users.`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('[DB] Subscribers file not found. Initializing a new one...');
        await this.saveSubscribers([]);
      } else {
        console.error('[DB] Failed to initialize subscribers:', error);
        throw error;
      }
    }
  }

  /**
   * Saves article records to disk
   */
  private async saveArticles(records: ProcessedArticle[]): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
    // Written compact: this file is a machine-read cache, and indenting a few
    // thousand records only inflates it.
    await fs.writeFile(this.dbPath, JSON.stringify(records), 'utf8');
    this.dirty = false;
  }

  /**
   * Writes pending changes to disk. Cheap to call when nothing changed.
   */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.saveArticles(Array.from(this.memoryCache.values()));
  }

  /**
   * Saves subscribers to disk
   */
  private async saveSubscribers(list: number[]): Promise<void> {
    const dir = path.dirname(this.subscribersPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.subscribersPath, JSON.stringify(list, null, 2), 'utf8');
  }

  /**
   * Checks if an article URL has already been processed
   */
  has(url: string): boolean {
    return this.memoryCache.has(url);
  }

  /**
   * Returns the number of articles currently tracked
   */
  get size(): number {
    return this.memoryCache.size;
  }

  /**
   * Adds an article to the processed database.
   * `sent` marks articles actually broadcast, which are the only ones later
   * articles are deduplicated against.
   */
  async add(
    url: string,
    title: string,
    source: string,
    summary?: string,
    sent: boolean = false,
    translatedTitle?: string
  ): Promise<void> {
    const record: ProcessedArticle = {
      url,
      title,
      source,
      processedAt: new Date().toISOString(),
      summary,
      titleNorm: fingerprint(title).normalized,
      translatedTitle,
      sent,
    };

    this.memoryCache.set(url, record);
    this.indexIfSent(record);
    this.dirty = true;

    // Broadcast records are the ones that must survive a crash: losing one
    // means the story goes out again next run. A plain "already seen this URL"
    // note costs at most one wasted AI call to rebuild, so those wait for the
    // end-of-cycle flush instead of rewriting a multi-megabyte file per article.
    if (sent) {
      await this.flush();
    }
  }

  /** Keeps the fingerprint index in sync with the broadcast records. */
  private indexIfSent(record: ProcessedArticle): void {
    if (!record.sent) {
      this.sentFingerprints.delete(record.url);
      return;
    }

    const prints: TitleFingerprint[] = [];
    const seen = new Set<string>();
    for (const title of [record.title, record.translatedTitle]) {
      if (!title) continue;
      const fp = fingerprint(title);
      if (!fp.normalized || seen.has(fp.normalized)) continue;
      seen.add(fp.normalized);
      prints.push(fp);
    }

    if (prints.length === 0) {
      this.sentFingerprints.delete(record.url);
      return;
    }
    this.sentFingerprints.set(record.url, prints);
  }

  /**
   * Finds previously broadcast articles from the last `days` whose headline
   * overlaps enough to plausibly be the same story, best match first.
   */
  findSimilarSent(candidate: TitleFingerprint, days: number): DuplicateCandidate[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const matches: DuplicateCandidate[] = [];

    for (const [url, storedPrints] of this.sentFingerprints.entries()) {
      const record = this.memoryCache.get(url);
      if (!record) continue;
      if (new Date(record.processedAt).getTime() < cutoff) continue;

      // A story may be indexed under several headlines. The closest one
      // decides the pair.
      let score = 0;
      for (const stored of storedPrints) {
        const pairScore = stored.normalized === candidate.normalized
          ? 1
          : similarity(stored.tokens, candidate.tokens);
        if (pairScore > score) score = pairScore;
      }

      if (score >= CANDIDATE_THRESHOLD) {
        matches.push({ record, score });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Drops records the bot no longer needs.
   *
   * The two kinds of record have very different lifetimes. Broadcast records
   * are what later articles are deduplicated against, so they must outlive the
   * dedup window. Everything else is only a note that a URL has been looked at,
   * which stops mattering once the source feed stops listing it — a few days.
   * Giving both the same fortnight left 93% of the file as dead weight.
   */
  async prune(sentDays: number, seenDays: number): Promise<void> {
    const now = Date.now();
    const sentCutoff = now - sentDays * 24 * 60 * 60 * 1000;
    const seenCutoff = now - seenDays * 24 * 60 * 60 * 1000;

    let deletedCount = 0;
    for (const [url, record] of this.memoryCache.entries()) {
      const processedTime = new Date(record.processedAt).getTime();
      const cutoff = record.sent ? sentCutoff : seenCutoff;
      if (processedTime < cutoff) {
        this.memoryCache.delete(url);
        this.sentFingerprints.delete(url);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      this.dirty = true;
      console.log(`[DB] Pruned ${deletedCount} record(s): broadcasts older than ${sentDays} days, other records older than ${seenDays}.`);
    }
  }

  // --- SUBSCRIBER MANAGEMENT ---

  /**
   * Adds a subscriber chat ID
   */
  async addSubscriber(chatId: number): Promise<boolean> {
    if (this.subscribersCache.has(chatId)) {
      return false; // Already subscribed
    }
    this.subscribersCache.add(chatId);
    await this.saveSubscribers(Array.from(this.subscribersCache));
    console.log(`[DB] Added subscriber chat ID: ${chatId}`);
    return true;
  }

  /**
   * Removes a subscriber chat ID
   */
  async removeSubscriber(chatId: number): Promise<boolean> {
    if (!this.subscribersCache.has(chatId)) {
      return false; // Not subscribed
    }
    this.subscribersCache.delete(chatId);
    await this.saveSubscribers(Array.from(this.subscribersCache));
    console.log(`[DB] Removed subscriber chat ID: ${chatId}`);
    return true;
  }

  /**
   * Gets list of all subscriber chat IDs
   */
  getSubscribers(): number[] {
    return Array.from(this.subscribersCache);
  }

  /**
   * Checks if chat ID is subscribed
   */
  hasSubscriber(chatId: number): boolean {
    return this.subscribersCache.has(chatId);
  }
}

export default JSONDatabase;
