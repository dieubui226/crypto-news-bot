import * as dotenv from 'dotenv';
import { SOURCES } from './config/sources';
import { JSONDatabase, DuplicateCandidate } from './database/db';
import { CrawlerService } from './services/crawler';
import { AIService } from './services/ai';
import { TelegramService } from './services/telegram';
import { fingerprint, AUTO_DUPLICATE_THRESHOLD } from './services/dedup';
import { Article } from './types';

// Load environment variables
dotenv.config();

const pollIntervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10);
const dbPath = process.env.DB_PATH || 'db.json';
// Caps AI calls per run so a large backlog cannot burn the whole daily quota in one cycle.
const maxArticlesPerRun = parseInt(process.env.MAX_ARTICLES_PER_RUN || '40', 10);
// How far back duplicate detection looks. One event gets re-reported for days,
// so the window has to outlive the news cycle, not just the run.
const dedupWindowDays = parseInt(process.env.DEDUP_WINDOW_DAYS || '7', 10);
// Cap on AI same-story comparisons per article, so a crowded topic cannot
// trigger a dozen extra calls for one headline.
const maxDuplicateChecks = parseInt(process.env.MAX_DUPLICATE_CHECKS || '3', 10);
// Broadcast records have to outlive the dedup window or a repeat of an older
// story matches nothing. "Already seen this URL" notes only have to outlive the
// source feed's own listing, which is a few days at most.
const sentRetentionDays = parseInt(process.env.SENT_RETENTION_DAYS || '14', 10);
const seenRetentionDays = parseInt(process.env.SEEN_RETENTION_DAYS || '3', 10);

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

    let analyzedCount = 0;
    let deferredCount = 0;
    let duplicateCount = 0;

    // Pass 1: collapse identical headlines inside this batch. Aggregators and
    // syndicated feeds hand us the same story under different URLs, and paying
    // for AI analysis on each copy is pure waste.
    const seenInBatch = new Map<string, string>();
    const batchDeduped: Article[] = [];
    for (const article of newArticles) {
      const { normalized } = fingerprint(article.title);
      const firstSource = normalized ? seenInBatch.get(normalized) : undefined;
      if (firstSource) {
        console.log(`[Dedup] Same headline as [${firstSource}] earlier in this batch: "${article.title}". Skipping.`);
        await db.add(article.url, article.title, article.source);
        duplicateCount++;
        continue;
      }
      if (normalized) seenInBatch.set(normalized, article.source);
      batchDeduped.push(article);
    }

    for (const article of batchDeduped) {
      const isDedicated = dedicatedSources.some(ds => article.source.includes(ds));
      const textToTest = `${article.title} ${article.contentSnippet || ''}`.toLowerCase();
      const hasKeyword = CRYPTO_KEYWORDS.some(kw => textToTest.includes(kw));

      if (!isDedicated && !hasKeyword) {
        // Skip non-crypto articles from general sources without wasting AI calls
        await db.add(article.url, article.title, article.source);
        continue;
      }

      // Pass 2: compare against what was actually broadcast in the last
      // `dedupWindowDays`. A near-identical headline needs no AI to settle.
      const fp = fingerprint(article.title);
      const similar = db.findSimilarSent(fp, dedupWindowDays);
      const strongest = similar[0];

      if (strongest && strongest.score >= AUTO_DUPLICATE_THRESHOLD) {
        console.log(
          `[Dedup] "${article.title}" repeats an article already sent (${(strongest.score * 100).toFixed(0)}% headline match with "${strongest.record.title}"). Skipping.`
        );
        await db.add(article.url, article.title, article.source);
        duplicateCount++;
        continue;
      }

      // Leave the rest of the backlog untouched so the next run can pick it up.
      if (aiService.isQuotaExhausted || analyzedCount >= maxArticlesPerRun) {
        deferredCount++;
        continue;
      }
      analyzedCount++;

      console.log(`[Orchestrator] Processing: "${article.title}" from [${article.source}]`);
      
      // Analyze with AI (relevance, translation, summary)
      const analysis = await aiService.analyzeArticle(article);

      if (analysis.relevant && analysis.importance === 'high') {
        // Pass 3: the check above compared raw headlines, which never matches
        // an English report against a Vietnamese one about the same event.
        // Re-run it with the Vietnamese title the AI just produced.
        let candidates = similar;
        const translatedTitle = analysis.title;
        if (translatedTitle && translatedTitle !== article.title) {
          const byUrl = new Map<string, DuplicateCandidate>();
          const translatedMatches = db.findSimilarSent(fingerprint(translatedTitle), dedupWindowDays);
          for (const match of [...similar, ...translatedMatches]) {
            const best = byUrl.get(match.record.url);
            if (!best || match.score > best.score) byUrl.set(match.record.url, match);
          }
          candidates = Array.from(byUrl.values()).sort((a, b) => b.score - a.score);
        }

        const strongestTranslated = candidates[0];
        if (strongestTranslated && strongestTranslated.score >= AUTO_DUPLICATE_THRESHOLD) {
          console.log(
            `[Dedup] Vietnamese headline for "${article.title}" repeats an article already sent (${(strongestTranslated.score * 100).toFixed(0)}% match with "${strongestTranslated.record.title}"). Skipping.`
          );
          await db.add(article.url, article.title, article.source, analysis.summary);
          duplicateCount++;
          continue;
        }

        // Pass 4: headlines that only partly overlap get an AI verdict, using
        // the summary we just generated. Cheaper than the alternative: sending
        // the same event twice under two different titles.
        let isDuplicate = false;
        for (const candidate of candidates.slice(0, maxDuplicateChecks)) {
          const verdict = await aiService.isSameStory(
            analysis.title || article.title,
            analysis.summary || article.contentSnippet,
            candidate.record.title,
            candidate.record.summary
          );
          if (!verdict.decided) break; // AI unavailable: fall through and send rather than lose the news
          if (verdict.duplicate) {
            console.log(
              `[Dedup] AI judged "${article.title}" to be the same story as "${candidate.record.title}" (already sent). Skipping.`
            );
            isDuplicate = true;
            break;
          }
        }

        if (isDuplicate) {
          await db.add(article.url, article.title, article.source, analysis.summary);
          duplicateCount++;
          continue;
        }

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

        // Save to DB with summary, flagged as sent so later articles dedupe
        // against it. The translated title is stored too, so a later report of
        // the same event in the other language still matches.
        await db.add(article.url, article.title, article.source, analysis.summary, true, analysis.title);

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

    if (duplicateCount > 0) {
      console.log(`[Dedup] Suppressed ${duplicateCount} duplicate article(s) this cycle (window: ${dedupWindowDays} days).`);
    }

    if (deferredCount > 0) {
      const reason = aiService.isQuotaExhausted ? 'AI quota exhausted' : `per-run limit of ${maxArticlesPerRun} reached`;
      console.log(`[Orchestrator] Analyzed ${analyzedCount} articles. Deferred ${deferredCount} to the next run (${reason}).`);
    } else {
      console.log(`[Orchestrator] Analyzed ${analyzedCount} articles. No backlog left.`);
    }

    await db.prune(sentRetentionDays, seenRetentionDays);
    await db.flush();

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
  await db.flush();
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
