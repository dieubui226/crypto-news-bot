import * as fs from 'fs/promises';
import * as path from 'path';
import { ProcessedArticle } from '../types';

export class JSONDatabase {
  private dbPath: string;
  private subscribersPath: string;
  private memoryCache: Map<string, ProcessedArticle> = new Map();
  private subscribersCache: Set<number> = new Set();

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
      for (const record of records) {
        this.memoryCache.set(record.url, record);
      }
      console.log(`[DB] Articles loaded. Tracking ${this.memoryCache.size} articles.`);
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
   * Adds an article to the processed database
   */
  async add(url: string, title: string, source: string, summary?: string): Promise<void> {
    const record: ProcessedArticle = {
      url,
      title,
      source,
      processedAt: new Date().toISOString(),
      summary,
    };
    
    this.memoryCache.set(url, record);
    const records = Array.from(this.memoryCache.values());
    await this.saveArticles(records);
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
