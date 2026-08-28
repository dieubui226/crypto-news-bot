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
  /** Token fingerprints for broadcast articles only, keyed by URL. */
  private sentFingerprints: Map<string, TitleFingerprint> = new Map();

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
    await fs.writeFile(this.dbPath, JSON.stringify(records, null, 2), 'utf8');
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
  async add(url: string, title: string, source: string, summary?: string, sent: boolean = false): Promise<void> {
    const record: ProcessedArticle = {
      url,
      title,
      source,
      processedAt: new Date().toISOString(),
      summary,
      titleNorm: fingerprint(title).normalized,
      sent,
    };

    this.memoryCache.set(url, record);
    this.indexIfSent(record);
    const records = Array.from(this.memoryCache.values());
    await this.saveArticles(records);
  }

  /** Keeps the fingerprint index in sync with the broadcast records. */
  private indexIfSent(record: ProcessedArticle): void {
    if (record.sent) {
      this.sentFingerprints.set(record.url, fingerprint(record.title));
    } else {
      this.sentFingerprints.delete(record.url);
    }
  }

  /**
   * Finds previously broadcast articles from the last `days` whose headline
   * overlaps enough to plausibly be the same story, best match first.
   */
  findSimilarSent(candidate: TitleFingerprint, days: number): DuplicateCandidate[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const matches: DuplicateCandidate[] = [];

    for (const [url, stored] of this.sentFingerprints.entries()) {
      const record = this.memoryCache.get(url);
      if (!record) continue;
      if (new Date(record.processedAt).getTime() < cutoff) continue;

      const score = stored.normalized === candidate.normalized
        ? 1
        : similarity(stored.tokens, candidate.tokens);

      if (score >= CANDIDATE_THRESHOLD) {
        matches.push({ record, score });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Cleans records older than a certain number of days to prevent file size bloat
   */
  async cleanOlderThan(days: number): Promise<void> {
    const now = new Date();
    const limitMs = days * 24 * 60 * 60 * 1000;
    
    let deletedCount = 0;
    for (const [url, record] of this.memoryCache.entries()) {
      const processedTime = new Date(record.processedAt).getTime();
      if (now.getTime() - processedTime > limitMs) {
        this.memoryCache.delete(url);
        this.sentFingerprints.delete(url);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      console.log(`[DB] Cleaned up ${deletedCount} database records older than ${days} days.`);
      await this.saveArticles(Array.from(this.memoryCache.values()));
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
