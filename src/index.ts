import * as dotenv from 'dotenv';
import { SOURCES } from './config/sources';
import { JSONDatabase } from './database/db';
import { CrawlerService } from './services/crawler';
import { AIService } from './services/ai';
import { TelegramService } from './services/telegram';
import { Article } from './types';

// Load environment variables
dotenv.config();

const pollIntervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10);
const dbPath = process.env.DB_PATH || 'db.json';

// Initialize services
const db = new JSONDatabase(dbPath);
const crawlerService = new CrawlerService();
const aiService = new AIService();
const telegramService = new TelegramService(db);

let isRunning = false;
let checkTimeout: NodeJS.Timeout | null = null;

/**
 * Utility delay function
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Main orchestrator check loop
 */
async function checkNews() {
  if (isRunning) return;
  isRunning = true;

  console.log(`\n==================================================`);
  console.log(`[Orchestrator] Starting check cycle at ${new Date().toLocaleString()}`);
  console.log(`==================================================`);

  try {
    const isFirstRun = db.size === 0;
    if (isFirstRun) {
      console.log('[Orchestrator] Database is empty. Seeding existing news feeds to prevent duplicate/old spam...');
    }

    const allArticles: Article[] = [];

    // Fetch news from all sources in parallel
    const crawlPromises = SOURCES.map(async (source) => {
      try {
        const fetched = await crawlerService.fetchArticles(source);
        return fetched;
      } catch (err) {
        console.error(`[Orchestrator] Error crawling ${source.name}:`, err);
        return [];
      }
    });

    const results = await Promise.all(crawlPromises);
    for (const articles of results) {
      allArticles.push(...articles);
    }

    console.log(`[Orchestrator] Found total of ${allArticles.length} articles across all sources.`);

    // Filter out already processed articles
    const newArticles = allArticles.filter(article => !db.has(article.url));
    console.log(`[Orchestrator] Detected ${newArticles.length} new articles to process.`);

    if (newArticles.length === 0) {
      console.log('[Orchestrator] No new articles found in this cycle.');
      isRunning = false;
      return;
    }

    if (isFirstRun) {
      // Only seed silently when the database is empty. Scheduled single-run jobs must still process new articles.
      console.log(`[Orchestrator] First run with empty database: silently indexing ${newArticles.length} existing articles.`);
      for (const article of newArticles) {
        await db.add(article.url, article.title, article.source);
      }
      console.log('[Orchestrator] Database synchronization complete. Future news will be sent real-time.');
      isRunning = false;
      return;
    }

    // Process new articles chronologically (oldest first) if we have dates
    newArticles.sort((a, b) => {
      const dateA = a.pubDate ? a.pubDate.getTime() : 0;
      const dateB = b.pubDate ? b.pubDate.getTime() : 0;
      return dateA - dateB;
    });

    // Keywords for pre-filtering general news feeds
    const CRYPTO_KEYWORDS = [
      'btc', 'bitcoin', 'sol', 'solana', 'crypto', 'blockchain', 'web3', 'rwa', 'stablecoin',
      'token', 'nft', 'vifc', 'tài sản số', 'tài sản ảo', 'tài sản mã hóa', 'tiền ảo', 'tiền mã hóa',
      'fintech', 'sandbox', 'bộ tài chính', 'ngân hàng nhà nước', 'sec', 'fed', 'cpi', 'etf',
      'binance', 'coinbase', 'bybit', 'coindesk', 'cointelegraph', 'decrypt', 'blogtienao', 'coin68',
      'unlicensed', 'fine', 'fines', 'quy định', 'pháp lý', 'xử phạt', 'sàn giao dịch'
    ];

    const dedicatedSources = [
      'CoinDesk', 'Cointelegraph', 'Decrypt', 'BlogTienAo', 'Coin68',
      'The Block', 'Blockworks', 'The Tokenist',
      'Google News - Tai san ma hoa VN', 'Google News - Vietnam Digital Asset Policy', 'Google News - RWA Tokenization',
      'Google News - Vietnam Crypto & Fintech (English)',
      'Coin68 (TG)', 'VNCointele (TG)', 'Cointelegraph (TG)', 'CoinMarketCap Announcements (TG)',
      'Cryptoholic Vietnam (TG)', 'Denome Announcements (TG)', 'GFI Research Channel (TG)',
      'Unfolded (TG)', 'CryptoQuant Official (TG)', 'Ah Boy Ash Reads (TG)', 'Wu Blockchain English (TG)'
    ];

    for (const article of newArticles) {
      const isDedicated = dedicatedSources.some(ds => article.source.includes(ds));
      const textToTest = `${article.title} ${article.contentSnippet || ''}`.toLowerCase();
      const hasKeyword = CRYPTO_KEYWORDS.some(kw => textToTest.includes(kw));

      if (!isDedicated && !hasKeyword) {
        // Skip non-crypto articles from general sources without wasting AI calls
        await db.add(article.url, article.title, article.source);
        continue;
      }

      console.log(`[Orchestrator] Processing: "${article.title}" from [${article.source}]`);
      
      // Analyze with AI (relevance, translation, summary)
      const analysis = await aiService.analyzeArticle(article);

      if (analysis.relevant && analysis.importance === 'high') {
        console.log(`[Orchestrator] -> Article is RELEVANT (${analysis.importance}). Broadcasting to Telegram...`);
        
        await telegramService.sendNews(
          analysis.title || article.title,
          article.title,
          article.source,
          analysis.summary || '',
          article.url,
          analysis.category,
          analysis.importance
        );

        // Save to DB with summary
        await db.add(article.url, article.title, article.source, analysis.summary);

        // Sleep to avoid rate limiting or spamming the chat
        await delay(3000);
      } else {
        if (analysis.error) {
          console.log(`[Orchestrator] -> Analysis failed for "${article.title}" due to AI API errors. Skipping DB commit to retry later.`);
        } else {
          console.log(`[Orchestrator] -> Article is IRRELEVANT or has insufficient importance (${analysis.importance}). Skipping Telegram, adding to DB...`);
          // Save to DB anyway so we don't process it in subsequent runs
          await db.add(article.url, article.title, article.source);
        }
      }
    }

    // Auto-clean database articles older than 14 days
    await db.cleanOlderThan(14);

  } catch (error) {
    console.error('[Orchestrator] Critical error in check cycle:', error);
  } finally {
    isRunning = false;
    console.log(`[Orchestrator] Check cycle complete. Sleeping for ${pollIntervalMinutes} minutes...\n`);
    // Schedule next run or exit if single-run mode is active
    if (process.env.SINGLE_RUN === 'true') {
      console.log('[Orchestrator] Single run completed successfully. Exiting.');
      // Wait a moment for database saves and logs to flush before exiting
      setTimeout(() => process.exit(0), 1000);
    } else {
      checkTimeout = setTimeout(checkNews, pollIntervalMinutes * 60 * 1000);
    }
  }
}

/**
 * Main application entrypoint
 */
async function start() {
  console.log('==================================================');
  console.log('🚀 DIGITAL ASSET NEWS REAL-TIME TELEGRAM BOT      ');
  console.log('==================================================');
  
  // Initialize Database
  await db.init();

  // Run first check immediately
  await checkNews();
}

/**
 * Handle Graceful Shutdown
 */
async function shutdown(signal: string) {
  console.log(`\n[System] Received ${signal}. Shutting down gracefully...`);
  if (checkTimeout) {
    clearTimeout(checkTimeout);
  }
  await telegramService.stop();
  console.log('[System] Shutdown complete. Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
