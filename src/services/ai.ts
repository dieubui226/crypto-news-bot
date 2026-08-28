import { GoogleGenerativeAI } from '@google/generative-ai';
import { Article } from '../types';

export interface AIAnalysisResult {
  relevant: boolean;
  title?: string;
  summary?: string;
  category?: 'regulation' | 'market' | 'business' | 'technology' | 'other';
  importance?: 'high' | 'medium' | 'low';
}

/** Why a Gemini call failed, which decides whether retrying can help at all. */
export type AIErrorKind = 'quota' | 'unavailable' | 'notFound' | 'other';

const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const MAX_ATTEMPTS_PER_MODEL = 2;
/** Beyond this, the quota window is too far off to be worth blocking the run. */
const MAX_RETRY_DELAY_MS = 30000;

export class AIService {
  private aiClient: GoogleGenerativeAI | null = null;
  private models: string[];
  /** Models that answered 404 in this process; retrying them only burns time. */
  private deadModels: Set<string> = new Set();
  /** Models that ran out of quota; skipped for the rest of the run instead of re-failing per article. */
  private exhaustedModels: Set<string> = new Set();
  /** True once every model is out of quota, so the caller can stop the run early. */
  private quotaExhausted = false;

  constructor() {
    this.models = (process.env.GEMINI_MODELS || DEFAULT_MODELS.join(','))
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);

    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'your_gemini_api_key_here') {
      try {
        // Initialize the client
        this.aiClient = new GoogleGenerativeAI(apiKey);
        console.log(`[AI] Service initialized. Model chain: ${this.models.join(' -> ')}`);
      } catch (err) {
        console.error('[AI] Failed to initialize Gemini API Client:', err);
      }
    } else {
      console.log('[AI] GEMINI_API_KEY not provided or default. Running in pass-through mode (no AI filtering/summaries).');
    }
  }

  /** True when every model has run out of quota for now. */
  get isQuotaExhausted(): boolean {
    return this.quotaExhausted;
  }

  /**
   * Maps a Gemini SDK error message onto a retry strategy.
   */
  private classifyError(message: string): AIErrorKind {
    if (message.includes('404') || message.includes('is not found') || message.includes('no longer available')) {
      return 'notFound';
    }
    if (message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
      return 'quota';
    }
    if (message.includes('503') || message.includes('500') || message.includes('high demand') || message.includes('overloaded')) {
      return 'unavailable';
    }
    return 'other';
  }

  /**
   * Reads the server-suggested cooldown, e.g. "retryDelay": "27s".
   */
  private parseRetryDelayMs(message: string): number | null {
    const match = message.match(/"?retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/);
    return match ? Math.round(parseFloat(match[1]) * 1000) : null;
  }

  /** A daily cap will not recover during this run, so waiting for it is pointless. */
  private isDailyQuota(message: string): boolean {
    return message.includes('PerDay') || message.includes('per day');
  }

  private failure(article: Article, errorKind: AIErrorKind): AIAnalysisResult & { error: boolean; errorKind: AIErrorKind } {
    return {
      relevant: false,
      title: article.title,
      summary: '',
      category: 'other',
      importance: 'low',
      error: true,
      errorKind
    };
  }

  /**
   * Processes a crawled article: determines relevance, translates, and summarizes.
   * Retries transient failures, and gives up immediately on quota or retired models.
   */
  async analyzeArticle(article: Article): Promise<AIAnalysisResult & { error?: boolean; errorKind?: AIErrorKind }> {
    if (!this.aiClient) {
      // Pass-through mode: all articles are considered relevant
      return {
        relevant: true,
        title: article.title,
        summary: article.contentSnippet || 'Không có bản tóm tắt.',
        category: 'other',
        importance: 'low'
      };
    }

    if (this.quotaExhausted) {
      return this.failure(article, 'quota');
    }

    const prompt = `
Bạn là một trợ lý AI chuyên phân tích tin tức về thị trường tài sản số, bao gồm crypto, blockchain, Web3, token hóa tài sản, RWA (Real World Asset), stablecoin, quy định pháp lý, fintech, kinh tế vĩ mô và các sự kiện có thể ảnh hưởng đến thị trường crypto.

Hãy phân tích tin tức dưới đây và chỉ trả về kết quả bằng JSON hợp lệ. Không giải thích thêm, không dùng markdown, không bọc trong code block.

Tin tức cần phân tích:
- Tiêu đề gốc: ${article.title}
- Nguồn tin: ${article.source}
- Nội dung tóm tắt gốc: ${article.contentSnippet || 'Không có tóm tắt'}

Nhiệm vụ:

1. Xác định mức độ liên quan của tin tức với thị trường tài sản số.

Một tin được xem là liên quan nếu thuộc một trong các nhóm sau:
- Tin tức về Bitcoin (BTC), Solana (SOL) hoặc RWA (Real World Asset) / token hóa tài sản thực (ví dụ: cập nhật công nghệ, sự kiện, dòng tiền, hạ tầng, sản phẩm hoặc khung pháp lý liên quan).
- Chính sách, pháp luật, quản lý nhà nước liên quan đến crypto, blockchain, tài sản số, tài sản ảo, tài sản mã hóa, fintech sandbox (đặc biệt tại Việt Nam hoặc các quốc gia lớn như Mỹ/EU/Trung Quốc).
- Tin về Việt Nam có liên quan trực tiếp đến tài sản số, tài sản ảo, tài sản mã hóa, blockchain, RWA, token hóa tài sản thực, chính sách quản lý tài sản mã hóa của chính phủ, các sàn giao dịch hoạt động tại Việt Nam, các tổ chức như VIFC (Hiệp hội các nhà đầu tư tài chính Việt Nam).
- Các sự kiện, hội thảo lớn, chuyển biến và xu hướng quan trọng về tài chính công nghệ (Fintech) tại Việt Nam.
- Tin vĩ mô quốc tế có tác động rõ ràng đến thị trường crypto nói chung (ví dụ: lãi suất FED, báo cáo CPI Mỹ, tin tức về SEC, ETF crypto giao ngay...).
- Công nghệ blockchain, hạ tầng kỹ thuật on-chain, Web3 nói chung.

Một tin KHÔNG được xem là liên quan nếu:
- Tin tức giá cả, biến động giá chỉ mang tính chất báo cáo bề mặt hoặc phân tích kỹ thuật sơ sài của BTC và Solana (ví dụ: 'Giá BTC tăng 2% hôm nay', 'Chỉ số RSI cho thấy BTC quá mua'...). Chỉ giữ lại tin về giá nếu bài viết mang tính phân tích chuyên sâu, giải thích được bản chất gốc rễ của sự việc (đáp ứng nguyên lý phân tích '3 Whys': Tại sao giá biến động? Tại sao điều này quan tím? Và Tại sao lại vào lúc này/tác động tiếp theo là gì?).
- Tin tức giá cả, biến động giá, phân tích kỹ thuật của các đồng coin khác ngoài BTC và Solana (ví dụ: giá ETH tăng/giảm, biến động BNB, XRP, meme coins...).
- Tin tức dự án, cập nhật công nghệ, tin nội bộ của các đồng coin/token khác ngoài BTC và Solana (ví dụ: tin về mạng lưới Ethereum, Cardano, Ripple, các dự án DeFi nhỏ khác).
- Chỉ nói chung về công nghệ, AI, ngân hàng truyền thống, chứng khoán, bất động sản, vàng, tỷ giá ngoại tệ mà không có liên hệ rõ với crypto/blockchain/tài sản số.
- Là tin PR, quảng cáo dự án, sự kiện doanh nghiệp/dự án nhỏ lẻ không có thông tin thị trường đáng kể.
- Nội dung quá mơ hồ, không đủ dữ kiện để kết luận liên quan.

2. Trả về "relevant":
- true nếu tin liên quan trực tiếp.
- false nếu không liên quan hoặc không đủ dữ kiện.

3. Giữ tiêu đề:
- Trả về tiêu đề trong thuộc tính "title".
- Giữ nguyên tiêu đề gốc.
- Chỉ chỉnh rất nhẹ nếu tiêu đề bị lỗi định dạng, lỗi khoảng trắng hoặc ký tự thừa.
- Không dịch tiêu đề.
- Không thêm thông tin không có trong tiêu đề hoặc tóm tắt gốc.

4. Tóm tắt bằng tiếng Việt:
- Nếu relevant = true: viết 2-3 gạch đầu dòng ngắn gọn.
- Mỗi gạch đầu dòng phải nêu thông tin chính hoặc tác động đáng chú ý.
- Không suy đoán quá mức, không bịa số liệu, không thêm dữ kiện ngoài nội dung được cung cấp.
- Nếu relevant = false: summary để chuỗi rỗng "".

5. Phân loại tin vào một nhóm chính:
- "regulation" nếu là pháp lý/chính sách/quản lý nhà nước.
- "market" nếu là biến động thị trường, giá, dòng tiền, ETF, vĩ mô ảnh hưởng crypto.
- "business" nếu là doanh nghiệp, sàn giao dịch, ngân hàng, fintech, hợp tác, sản phẩm.
- "technology" nếu là blockchain, Web3, hạ tầng kỹ thuật, bảo mật, protocol.
- "other" nếu không thuộc các nhóm trên.
- Nếu relevant = false, dùng "other".

6. Đánh giá mức độ quan trọng:
- "high": Bắt buộc CHỈ được đánh giá là "high" đối với:
  + Các tin tức về Việt Nam liên quan đến pháp lý, chính sách chính phủ, tài sản ảo/tài sản số/tài sản mã hóa, các sự kiện tài chính công nghệ (Fintech) lớn, hoạt động hoặc xử phạt các sàn giao dịch trong nước, và các tổ chức tài chính tại Việt Nam (như VIFC, đề án trung tâm tài chính, sandbox).
  + Các tin tức về Token hóa tài sản (RWA - Real World Asset) / Chứng khoán hóa tài sản tại Việt Nam hoặc các chính sách RWA lớn toàn cầu có tác động trực tiếp đến Việt Nam.
  + Tuyệt đối KHÔNG đánh giá là "high" đối với các tin vĩ mô quốc tế thông thường (lãi suất FED, CPI), tin tức công nghệ/bảo mật nước ngoài (lỗ hổng ví cứng, hack/tấn công dự án DeFi quốc tế, nâng cấp blockchain Ethereum/Bitcoin), tin kinh doanh của các sàn giao dịch nước ngoài (Coinbase, Robinhood, Binance), hoặc tin tức giá cả biến động thị trường toàn cầu. Tất cả các tin này chỉ được đánh giá là "medium" hoặc "low".
- "medium": Đáng chú ý nhưng tác động vừa phải. Hầu hết các tin tức vĩ mô quốc tế, bảo mật nước ngoài, dòng vốn ETF, và các vụ kiện tụng thông thường của SEC phải được đánh giá là "medium" hoặc "low".
- "low": Thông tin phụ, tác động thấp hoặc tin phân tích giá cả thông thường.
- Nếu relevant = false, dùng "low".

*LƯU Ý ĐẶC BIỆT*: 
- Bắt buộc đánh giá mức độ quan trọng là "high" đối với các tin tức về Việt Nam liên quan đến pháp lý, chính sách chính phủ, tài sản số, tài sản ảo, tài sản mã hóa, các sự kiện tài chính công nghệ (Fintech) lớn, sàn giao dịch trong nước, và các tổ chức tài chính tại Việt Nam (như VIFC). Không được đánh giá các tin này là "medium" hoặc "low".
- Các tin tức vĩ mô/chính sách quốc tế thông thường, tin bảo mật ví cứng, tin hack dự án nước ngoài, tin sàn giao dịch ngoại... KHÔNG được đánh giá là "high". Chỉ đánh giá chúng tối đa là "medium" hoặc "low".

JSON kết quả bắt buộc đúng schema sau:

{
  "relevant": true,
  "title": "Tiêu đề gốc",
  "summary": "• Nội dung tóm tắt 1\\n• Nội dung tóm tắt 2",
  "category": "regulation",
  "importance": "high"
}
`;

    const { data, errorKind } = await this.generateJson<AIAnalysisResult>(prompt, article.title);
    if (!data) {
      return this.failure(article, errorKind);
    }

    return {
      relevant: data.relevant,
      title: data.title || article.title,
      summary: data.summary || '',
      category: data.category || 'other',
      importance: data.importance || 'low'
    };
  }

  /**
   * Decides whether two headlines report the same underlying event.
   * Used only for pairs whose headline overlap is ambiguous, so the extra AI
   * calls stay rare.
   */
  async isSameStory(
    candidateTitle: string,
    candidateSnippet: string | undefined,
    existingTitle: string,
    existingSummary?: string
  ): Promise<{ duplicate: boolean; decided: boolean }> {
    if (!this.aiClient || this.quotaExhausted) {
      return { duplicate: false, decided: false };
    }

    const prompt = `
Bạn là trợ lý biên tập tin tức. Xác định xem HAI bản tin dưới đây có nói về CÙNG MỘT sự kiện/sự việc hay không.

Bản tin A (đã gửi trước đó):
- Tiêu đề: ${existingTitle}
- Tóm tắt: ${existingSummary || 'Không có'}

Bản tin B (bản tin mới):
- Tiêu đề: ${candidateTitle}
- Tóm tắt: ${candidateSnippet || 'Không có'}

Quy tắc:
- "duplicate": true nếu hai bản tin tường thuật CÙNG một sự kiện, cùng một thông báo, cùng một quyết định hoặc cùng một số liệu công bố — kể cả khi khác nguồn, khác cách giật tít, khác ngôn ngữ.
- "duplicate": false nếu bản tin B có diễn biến MỚI, số liệu MỚI, quyết định tiếp theo, phản ứng của bên thứ ba, hoặc thực chất là một sự việc khác dù cùng chủ đề.
- Nếu không đủ dữ kiện để kết luận chắc chắn, trả về false.

Chỉ trả về JSON hợp lệ, không markdown, không giải thích:
{"duplicate": true, "reason": "ngắn gọn 1 câu"}
`;

    const { data } = await this.generateJson<{ duplicate: boolean; reason?: string }>(
      prompt,
      `so sánh trùng lặp: "${candidateTitle}"`
    );

    if (!data || typeof data.duplicate !== 'boolean') {
      return { duplicate: false, decided: false };
    }

    if (data.duplicate && data.reason) {
      console.log(`[AI] Duplicate confirmed: ${data.reason}`);
    }
    return { duplicate: data.duplicate, decided: true };
  }

  /**
   * Runs a JSON prompt through the model chain, walking down to the next model
   * on quota exhaustion or retirement and retrying transient failures.
   */
  private async generateJson<T>(prompt: string, label: string): Promise<{ data: T | null; errorKind: AIErrorKind }> {
    const usableModels = this.models.filter(m => !this.deadModels.has(m) && !this.exhaustedModels.has(m));
    if (usableModels.length === 0) {
      console.error('[AI] No usable models left: every configured model is retired or out of quota. Check GEMINI_MODELS.');
      return { data: null, errorKind: this.deadModels.size === this.models.length ? 'notFound' : 'quota' };
    }

    let lastKind: AIErrorKind = 'other';

    for (const modelToTry of usableModels) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
        try {
          const model = this.aiClient!.getGenerativeModel({
            model: modelToTry,
            generationConfig: { responseMimeType: 'application/json' }
          });

          const response = await model.generateContent(prompt);
          const responseText = response.response.text() || '';
          return { data: JSON.parse(responseText) as T, errorKind: 'other' };
        } catch (err: any) {
          const message = err.message || String(err);
          const kind = this.classifyError(message);
          lastKind = kind;
          console.error(`[AI] Attempt ${attempt} with model ${modelToTry} failed (${kind}) for "${label}":`, message);

          if (kind === 'notFound') {
            // The model has been retired, so never call it again in this process.
            this.deadModels.add(modelToTry);
            break;
          }

          if (kind === 'quota') {
            const isDaily = this.isDailyQuota(message);
            const suggestedDelay = this.parseRetryDelayMs(message);
            if (!isDaily && suggestedDelay !== null && suggestedDelay <= MAX_RETRY_DELAY_MS && attempt < MAX_ATTEMPTS_PER_MODEL) {
              console.log(`[AI] Rate limited on ${modelToTry}. Waiting ${suggestedDelay}ms as suggested by the API...`);
              await new Promise(r => setTimeout(r, suggestedDelay));
              continue;
            }
            // Every later article would hit the same wall, so stop calling this model this run.
            this.exhaustedModels.add(modelToTry);
            console.warn(`[AI] ${modelToTry} is out of ${isDaily ? 'daily' : 'short-term'} quota. Skipping it for the rest of this run.`);
            break;
          }

          if (kind === 'unavailable' && attempt < MAX_ATTEMPTS_PER_MODEL) {
            const delayMs = attempt * 2000;
            console.log(`[AI] ${modelToTry} temporarily unavailable. Retrying in ${delayMs}ms...`);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }

          break; // Malformed response or unknown error: fall through to the next model
        }
      }
    }

    if (this.models.every(m => this.deadModels.has(m) || this.exhaustedModels.has(m))) {
      this.quotaExhausted = true;
      console.error('[AI] Quota exhausted on every model. Remaining articles are left untouched for the next run.');
    }

    console.error(`[AI] All models and retries failed for "${label}". Flagging as analysis error.`);
    return { data: null, errorKind: lastKind };
  }
}

export default AIService;
