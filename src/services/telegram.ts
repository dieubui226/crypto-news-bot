import { Telegraf } from 'telegraf';

export class TelegramService {
  private bot: Telegraf | null = null;
  private db: any = null;
  private authorizedChatIds: (number | string)[] = [];
  private dryRun: boolean = false;

  constructor(db: any) {
    this.db = db;
    this.dryRun = process.env.DRY_RUN === 'true';
    
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (token && token !== 'your_telegram_bot_token_here') {
      try {
        this.bot = new Telegraf(token);
        this.setupBotCommands();
        // Start bot in the background
        this.bot.launch().catch(err => {
          console.error('[Telegram] Failed to launch bot:', err);
        });
        console.log('[Telegram] Bot initialized successfully.');
      } catch (err) {
        console.error('[Telegram] Error creating Telegram client:', err);
      }
    } else {
      console.log('[Telegram] TELEGRAM_BOT_TOKEN not provided or default. Running in dry-run/console-only mode.');
    }

    // Parse authorized chat IDs/channels from .env
    const chatIdsStr = process.env.TELEGRAM_CHAT_IDS || '';
    this.authorizedChatIds = chatIdsStr
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
      .map(id => {
        // Channels starting with @ are kept as string usernames, numbers are parsed as integers
        if (id.startsWith('@')) {
          return id;
        }
        const num = parseInt(id, 10);
        return isNaN(num) ? id : num;
      });
      
    if (this.authorizedChatIds.length > 0) {
      console.log(`[Telegram] Loaded ${this.authorizedChatIds.length} static target(s) from .env:`, this.authorizedChatIds);
    }
  }

  /**
   * Safe HTML Escaper to prevent Telegram parser errors
   */
  private escapeHTML(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Listen to bot commands, enabling public interactive subscription
   */
  private setupBotCommands() {
    if (!this.bot) return;

    // Start / Subscribe Command
    this.bot.start(async (ctx) => {
      const chatId = ctx.chat.id;
      const username = ctx.from?.first_name || 'bạn';

      if (this.db) {
        const added = await this.db.addSubscriber(chatId);
        if (added) {
          ctx.reply(
            `🔔 <b>Chào ${username}! Đăng ký thành công!</b>\n\n` +
            `Bạn đã đăng ký nhận tin tức chọn lọc chất lượng cao (độ quan trọng CAO) về thị trường tài sản số tại Việt Nam & quốc tế.\n\n` +
            `Để dừng nhận tin, bất kỳ lúc nào hãy gửi lệnh /stop.`,
            { parse_mode: 'HTML' }
          );
        } else {
          ctx.reply(
            `🔔 <b>Bạn đã đăng ký trước đó rồi!</b>\n\n` +
            `Hệ thống sẽ tiếp tục gửi tin tức nóng hổi trực tiếp tại đây khi có diễn biến mới.`,
            { parse_mode: 'HTML' }
          );
        }
      } else {
        ctx.reply('🔒 Hệ thống cơ sở dữ liệu tạm thời chưa sẵn sàng, vui lòng thử lại sau.');
      }
    });

    // Unsubscribe Command
    this.bot.command('stop', async (ctx) => {
      const chatId = ctx.chat.id;
      if (this.db) {
        const removed = await this.db.removeSubscriber(chatId);
        if (removed) {
          ctx.reply(
            `🔕 <b>Đã hủy đăng ký nhận tin!</b>\n\n` +
            `Hệ thống đã loại bỏ tài khoản của bạn khỏi danh sách phát sóng. Để đăng ký lại, hãy gửi /start.`,
            { parse_mode: 'HTML' }
          );
        } else {
          ctx.reply('Bạn chưa đăng ký nhận tin từ hệ thống. Gửi /start để đăng ký.', { parse_mode: 'HTML' });
        }
      } else {
        ctx.reply('🔒 Hệ thống cơ sở dữ liệu tạm thời chưa sẵn sàng, vui lòng thử lại sau.');
      }
    });
  }

  /**
   * Broadcasts a news article to all static targets (.env) and interactive subscribers (DB)
   */
  async sendNews(
    title: string,
    originalTitle: string,
    source: string,
    summary: string,
    url: string,
    category?: string,
    importance?: string
  ): Promise<void> {
    const formattedTitle = this.escapeHTML(title);
    const escapedSource = this.escapeHTML(source);
    const escapedOriginalTitle = this.escapeHTML(originalTitle);

    const categoryMap: Record<string, string> = {
      regulation: '⚖️ #PhapLy',
      market: '📊 #ThiTruong',
      business: '💼 #DoanhNghiep',
      technology: '⚙️ #CongNghe',
      other: '🌐 #Khac'
    };

    const importanceMap: Record<string, string> = {
      high: '🔴 <b>QUAN TRỌNG: CAO</b>',
      medium: '🟡 <b>QUAN TRỌNG: TRUNG BÌNH</b>',
      low: '🟢 <b>QUAN TRỌNG: THẤP</b>'
    };
    
    // Build premium looking HTML message
    let message = '';
    
    if (importance && importanceMap[importance]) {
      message += `${importanceMap[importance]}\n`;
    }
    
    message += `🔥 <b>${formattedTitle}</b>\n`;
    
    if (category && categoryMap[category]) {
      message += `🏷️ <b>Phân loại:</b> ${categoryMap[category]}\n`;
    }
    
    if (originalTitle && originalTitle !== title) {
      message += `🇬🇧 <i>Title gốc: ${escapedOriginalTitle}</i>\n`;
    }
    
    message += `📰 <b>Nguồn:</b> ${escapedSource}\n\n`;
    
    if (summary) {
      const summaryLines = summary
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.startsWith('•') || line.startsWith('-') ? line : `• ${line}`)
        .join('\n');
        
      message += `📝 <b>Tóm tắt cốt lõi:</b>\n${this.escapeHTML(summaryLines)}\n\n`;
    }
    
    message += `🔗 <a href="${url}">Xem chi tiết bài báo gốc</a>`;

    // Retrieve database interactive subscribers
    const dbSubscribers = this.db ? this.db.getSubscribers() : [];
    
    // Combine static targets (.env) and interactive subscribers (DB)
    const targets = Array.from(new Set([...this.authorizedChatIds, ...dbSubscribers]));

    if (this.dryRun || !this.bot) {
      console.log('\n--- [DRY RUN - TELEGRAM BROADCAST] ---');
      console.log(`To: ${targets.join(', ') || 'No Subscribers'}`);
      console.log(message);
      console.log('-------------------------------------\n');
      return;
    }

    if (targets.length === 0) {
      console.log('[Telegram] Aborted sending: No subscribers or channel targets configured.');
      return;
    }

    for (const chatId of targets) {
      try {
        await this.bot.telegram.sendMessage(chatId, message, {
          parse_mode: 'HTML'
        });
        console.log(`[Telegram] News successfully sent to: ${chatId}`);
      } catch (error: any) {
        console.error(`[Telegram] Error sending to ${chatId}:`, error.message);
        
        // Self-cleaning: if user blocked the bot or chat not found, remove them
        if (
          error.message.includes('forbidden') || 
          error.message.includes('blocked') || 
          error.message.includes('chat not found')
        ) {
          console.log(`[Telegram] Destination ${chatId} invalid/blocked. Removing from subscribers list.`);
          if (this.db && typeof chatId === 'number') {
            await this.db.removeSubscriber(chatId);
          }
        }
      }
    }
  }

  /**
   * Closes the bot connection gracefully
   */
  async stop() {
    if (this.bot) {
      console.log('[Telegram] Stopping bot...');
      try {
        await this.bot.stop();
      } catch (err) {
        console.error('[Telegram] Error stopping bot:', err);
      }
    }
  }
}

export default TelegramService;
