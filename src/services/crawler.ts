import axios from 'axios';
import * as cheerio from 'cheerio';
import { Article, CrawlerConfig } from '../types';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

/**
 * Service to fetch and parse articles from various configured sources
 */
export class CrawlerService {
  /**
   * Fetches articles for a single crawler config
   */
  async fetchArticles(config: CrawlerConfig): Promise<Article[]> {
    console.log(`[Crawler] Fetching news from ${config.name}...`);
    try {
      const url = config.type === 'rss' && config.rssUrl ? config.rssUrl : config.url;
      const response = await axios.get(url, {
        headers: DEFAULT_HEADERS,
        timeout: 10000 // 10s timeout
      });

      if (config.type === 'rss') {
        return this.parseRSS(response.data, config.name);
      } else {
        return this.parseHTML(response.data, config);
      }
    } catch (error: any) {
      console.error(`[Crawler] Error fetching from ${config.name}:`, error.message);
      return [];
    }
  }

  /**
   * Parses RSS (XML) content using cheerio
   */
  private parseRSS(xmlData: string, sourceName: string): Article[] {
    const articles: Article[] = [];
    const $ = cheerio.load(xmlData, { xmlMode: true });

    $('item').each((_, element) => {
      try {
        const title = $(element).find('title').text().trim();
        // Sometimes link is within <link> or <guid>
        let url = $(element).find('link').text().trim();
        if (!url) {
          url = $(element).find('guid').text().trim();
        }

        const pubDateStr = $(element).find('pubDate').text().trim();
        const description = $(element).find('description').text().trim();

        // Strip HTML tags from description if any
        const cleanSnippet = cheerio.load(description).text().trim();

        if (title && url) {
          articles.push({
            title,
            url,
            source: sourceName,
            pubDate: pubDateStr ? new Date(pubDateStr) : undefined,
            contentSnippet: cleanSnippet.substring(0, 300), // Limit size
            rawContent: description
          });
        }
      } catch (err) {
        console.error(`[Crawler] Error parsing RSS item for ${sourceName}:`, err);
      }
    });

    return articles;
  }

  /**
   * Parses custom HTML content
   */
  private parseHTML(htmlData: string, config: CrawlerConfig): Article[] {
    const articles: Article[] = [];
    const $ = cheerio.load(htmlData);

    const selector = config.selector || 'article';
    const titleSelector = config.titleSelector || 'h3, h2, a';
    const linkSelector = config.linkSelector || 'a';

    $(selector).each((_, element) => {
      try {
        const titleEl = $(element).find(titleSelector).first();
        const title = titleEl.text().trim();
        
        let link = $(element).find(linkSelector).first().attr('href');
        if (!link && $(element).is('a')) {
          link = $(element).attr('href');
        }

        if (title && link) {
          const fullUrl = link.startsWith('http') ? link : new URL(link, config.url).toString();
          articles.push({
            title,
            url: fullUrl,
            source: config.name
          });
        }
      } catch (err) {
        console.error(`[Crawler] Error parsing HTML element for ${config.name}:`, err);
      }
    });

    return articles;
  }
}

export default CrawlerService;
