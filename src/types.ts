export interface Article {
  title: string;
  url: string;
  source: string;
  pubDate?: Date;
  contentSnippet?: string;
  rawContent?: string;
}

export interface ProcessedArticle {
  title: string;
  url: string;
  source: string;
  processedAt: string;
  summary?: string;
}

export interface CrawlerConfig {
  name: string;
  type: 'rss' | 'html' | 'page';
  url: string;
  rssUrl?: string;
  // CSS selector for list of articles on HTML pages
  selector?: string;
  // Sub-selectors for elements within the item
  titleSelector?: string;
  linkSelector?: string;
  // Custom parser if needed
  customParserName?: string;
}
