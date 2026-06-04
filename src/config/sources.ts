import { CrawlerConfig } from '../types';

export const SOURCES: CrawlerConfig[] = [
  // --- USER'S REQUESTED SOURCES ---
  {
    name: "VnExpress Blockchain",
    type: "page",
    url: "https://vnexpress.net/chu-de/blockchain-3312",
    selector: 'article.item-news',
    titleSelector: 'h3.title-news a, h2.title-news a',
    linkSelector: 'h3.title-news a, h2.title-news a'
  },
  {
    name: "CafeF RSS",
    type: "rss",
    url: "https://cafef.vn",
    rssUrl: "https://cafef.vn/index.rss"
  },
  {
    name: "CoinDesk",
    type: "rss",
    url: "https://www.coindesk.com",
    rssUrl: "https://www.coindesk.com/arc/outboundfeeds/rss"
  },
  {
    name: "Cointelegraph",
    type: "rss",
    url: "https://cointelegraph.com",
    rssUrl: "https://cointelegraph.com/rss"
  },
  {
    name: "Decrypt",
    type: "rss",
    url: "https://decrypt.co",
    rssUrl: "https://decrypt.co/feed"
  },
  {
    name: "Google News - Tai san ma hoa VN",
    type: "rss",
    url: "https://news.google.com",
    rssUrl: "https://news.google.com/rss/search?q=%22t%C3%A0i%20s%E1%BA%A3n%20m%C3%A3%20h%C3%B3a%22%20OR%20%22t%C3%A0i%20s%E1%BA%A3n%20s%E1%BB%91%22%20when:1d&hl=vi&gl=VN&ceid=VN:vi"
  },
  {
    name: "VTV Money Finance",
    type: "page",
    url: "https://money.vtv.vn/tai-chinh.htm",
    selector: 'div.news-item, div.item-news, li.news-item, ul.list-news li',
    titleSelector: 'a.title, a.name, h3 a, h2 a, a',
    linkSelector: 'a'
  },

  // --- ORIGINAL DOMESTIC SOURCES ---
  {
    name: 'BlogTienAo',
    type: 'rss',
    url: 'https://blogtienao.com',
    rssUrl: 'https://blogtienao.com/feed'
  },
  {
    name: 'Coin68',
    type: 'rss',
    url: 'https://coin68.com',
    rssUrl: 'https://coin68.com/feed'
  },
  {
    name: 'VnExpress So Hoa',
    type: 'rss',
    url: 'https://vnexpress.net/so-hoa',
    rssUrl: 'https://vnexpress.net/rss/so-hoa.rss'
  },
  {
    name: 'CafeF Tai Chinh Quoc Te',
    type: 'rss',
    url: 'https://cafef.vn/tai-chinh-quoc-te',
    rssUrl: 'https://cafef.vn/tai-chinh-quoc-te.rss'
  },

  // --- TELEGRAM SOURCES ---
  {
    name: 'VNCointele (TG)',
    type: 'html',
    url: 'https://t.me/s/vncointele',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'Cointelegraph (TG)',
    type: 'html',
    url: 'https://t.me/s/cointelegraph',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'CoinMarketCap Announcements (TG)',
    type: 'html',
    url: 'https://t.me/s/CoinMarketCapAnnouncements',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'Cryptoholic Vietnam (TG)',
    type: 'html',
    url: 'https://t.me/s/cryptoholicvietnam',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'Denome Announcements (TG)',
    type: 'html',
    url: 'https://t.me/s/denome_announcements',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'GFI Research Channel (TG)',
    type: 'html',
    url: 'https://t.me/s/gfi_research_Channel',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'Unfolded (TG)',
    type: 'html',
    url: 'https://t.me/s/unfolded',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'CryptoQuant Official (TG)',
    type: 'html',
    url: 'https://t.me/s/cryptoquant_official',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  },
  {
    name: 'Ah Boy Ash Reads (TG)',
    type: 'html',
    url: 'https://t.me/s/ahboyashreads',
    selector: 'div.tgme_widget_message',
    titleSelector: 'div.tgme_widget_message_text',
    linkSelector: 'a.tgme_widget_message_date'
  }
];
