import { Telegraf } from 'telegraf';

export class TelegramService {
  private bot: Telegraf | null = null;
  private authorizedChatIds: number[] = [];
  private dryRun: boolean = false;

  constructor() {
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

    // Parse authorized chat IDs
    const chatIdsStr = process.env.TELEGRAM_CHAT_IDS || '';
    this.authorizedChatIds = chatIdsStr
      .split(',')
      .map(id => parseInt(id.trim(), 10))
      .filter(id => !isNaN(id));
      
    if (this.authorizedChatIds.length > 0) {
      console.log(`[Telegram] Loaded ${this.authorizedChatIds.length} authorized Chat ID(s):`, this.authorizedChatIds);
    } else {
      console.log('[Telegram] WARNING: No authorized Chat IDs loaded. Configure TELEGRAM_CHAT_IDS in .env.');
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
   * Listen to bot commands, especially for getting the user's Chat ID
   */
  private setupBotCommands() {
    if (!this.bot) return;

    this.bot.start((ctx) => {
      const chatId = ctx.chat.id;
      const isAuthorized = this.authorizedChatIds.includes(chatId);

      if (isAuthorized) {
        ctx.reply(
          `🔔 <b>Hệ thống quét tin tức tài sản số realtime đã sẵn sàng!</b>\n\n` +
          `Bạn đã được ủy quyền nhận tin tức tại đây. Chat ID của bạn là: <code>${chatId}</code>`,
          { parse_mode: 'HTML' }
        );
      } else {
        ctx.reply(
          `🔒 <b>Yêu cầu truy cập bị từ chối!</b>\n\n` +
          `Bạn chưa được cấp quyền nhận tin tức. Hãy sao chép Chat ID bên dưới và thêm nó vào biến <code>TELEGRAM_CHAT_IDS</code> trong file <code>.env</code>:\n\n` +
          `<b>Chat ID của bạn:</b> <code>${chatId}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    });
  }

  /**
   * Broadcasts a news article to all authorized Telegram chat IDs
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
      // Split summary by newlines and clean it
      const summaryLines = summary
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => line.startsWith('•') || line.startsWith('-') ? line : `• ${line}`)
        .join('\n');
        
      message += `📝 <b>Tóm tắt cốt lõi:</b>\n${this.escapeHTML(summaryLines)}\n\n`;
    }
    
    message += `🔗 <a href="${url}">Xem chi tiết bài báo gốc</a>`;

    if (this.dryRun || !this.bot) {
      console.log('\n--- [DRY RUN - TELEGRAM BROADCAST] ---');
      console.log(`To: ${this.authorizedChatIds.join(', ') || 'No Subscribers'}`);
      console.log(message);
      console.log('-------------------------------------\n');
      return;
    }

    if (this.authorizedChatIds.length === 0) {
      console.log('[Telegram] Aborted sending: No authorized Chat IDs configured.');
      return;
    }

    for (const chatId of this.authorizedChatIds) {
      try {
        await this.bot.telegram.sendMessage(chatId, message, {
          parse_mode: 'HTML'
        });
        console.log(`[Telegram] News successfully sent to Chat ID: ${chatId}`);
      } catch (error: any) {
        console.error(`[Telegram] Error sending to Chat ID ${chatId}:`, error.message);
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
