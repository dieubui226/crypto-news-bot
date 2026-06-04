import * as fs from 'fs/promises';
import * as path from 'path';
import { ProcessedArticle } from '../types';

export class JSONDatabase {
  private dbPath: string;
  private memoryCache: Map<string, ProcessedArticle> = new Map();

  constructor(dbPath: string = 'db.json') {
    this.dbPath = path.resolve(dbPath);
  }

  /**
   * Initializes the database, loading existing records from disk
   */
  async init(): Promise<void> {
    try {
      await fs.access(this.dbPath);
      const data = await fs.readFile(this.dbPath, 'utf8');
      const records: ProcessedArticle[] = JSON.parse(data);
      this.memoryCache.clear();
      for (const record of records) {
        this.memoryCache.set(record.url, record);
      }
      console.log(`[DB] Loaded. Tracking ${this.memoryCache.size} articles.`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('[DB] File not found. Initializing a new one...');
        await this.save([]);
      } else {
        console.error('[DB] Failed to initialize:', error);
        throw error;
      }
    }
  }

  /**
   * Saves records to disk
   */
  private async save(records: ProcessedArticle[]): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.dbPath, JSON.stringify(records, null, 2), 'utf8');
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
    await this.save(records);
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
      await this.save(Array.from(this.memoryCache.values()));
    }
  }
}
export default JSONDatabase;
