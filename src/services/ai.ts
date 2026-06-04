import { GoogleGenerativeAI } from '@google/generative-ai';
import { Article } from '../types';

export interface AIAnalysisResult {
  relevant: boolean;
  title?: string;
  summary?: string;
  category?: 'regulation' | 'market' | 'business' | 'technology' | 'other';
  importance?: 'high' | 'medium' | 'low';
}

export class AIService {
  private aiClient: GoogleGenerativeAI | null = null;
  private modelName: string = 'gemini-3.5-flash';

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'your_gemini_api_key_here') {
      try {
        // Initialize the client
        this.aiClient = new GoogleGenerativeAI(apiKey);
        console.log(`[AI] Service initialized using model: ${this.modelName}`);
      } catch (err) {
        console.error('[AI] Failed to initialize Gemini API Client:', err);
      }
    } else {
      console.log('[AI] GEMINI_API_KEY not provided or default. Running in pass-through mode (no AI filtering/summaries).');
    }
  }

  /**
   * Processes a crawled article: determines relevance, translates, and summarizes.
   * Falls back to pass-through if Gemini is not configured.
   */
  async analyzeArticle(article: Article): Promise<AIAnalysisResult> {
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

    try {
      const prompt = `
Bạn là một trợ lý AI chuyên phân tích tin tức về thị trường tài sản số, bao gồm crypto, blockchain, Web3, token hóa tài sản, stablecoin, quy định pháp lý, fintech, kinh tế vĩ mô và các sự kiện có thể ảnh hưởng đến thị trường crypto.

Hãy phân tích tin tức dưới đây và chỉ trả về kết quả bằng JSON hợp lệ. Không giải thích thêm, không dùng markdown, không bọc trong code block.

Tin tức cần phân tích:
- Tiêu đề gốc: ${article.title}
- Nguồn tin: ${article.source}
- Nội dung tóm tắt gốc: ${article.contentSnippet || 'Không có tóm tắt'}

Nhiệm vụ:

1. Xác định mức độ liên quan của tin tức với thị trường tài sản số.

Một tin được xem là liên quan nếu thuộc một trong các nhóm sau:
- Crypto, Bitcoin, Ethereum, altcoin, stablecoin, DeFi, NFT, token, sàn giao dịch crypto.
- Blockchain, Web3, ví điện tử blockchain, hạ tầng on-chain, bảo mật crypto.
- Tài sản mã hóa, tài sản số, token hóa tài sản, khung pháp lý tài sản số.
- Chính sách, pháp luật, quản lý nhà nước liên quan đến crypto, blockchain, tài sản số, fintech sandbox.
- Tin về Việt Nam có liên quan trực tiếp đến tài sản số, blockchain, fintech, ngân hàng số hoặc chính sách quản lý tài sản mã hóa.
- Tin vĩ mô quốc tế có tác động rõ ràng đến crypto, ví dụ FED, lãi suất, CPI Mỹ, ETF crypto, SEC, quy định lớn tại Mỹ/EU/Trung Quốc.

Một tin KHÔNG được xem là liên quan nếu:
- Chỉ nói chung về công nghệ, AI, ngân hàng, chứng khoán, bất động sản, vàng, tỷ giá mà không có liên hệ rõ với crypto/blockchain/tài sản số.
- Là tin PR, quảng cáo, sự kiện doanh nghiệp không có thông tin thị trường đáng kể.
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
- "high": có tác động lớn đến thị trường, pháp lý, nhà đầu tư hoặc tổ chức.
- "medium": đáng chú ý nhưng tác động vừa phải.
- "low": thông tin phụ, tác động thấp.
- Nếu relevant = false, dùng "low".

JSON kết quả bắt buộc đúng schema sau:

{
  "relevant": true,
  "title": "Tiêu đề gốc",
  "summary": "• Nội dung tóm tắt 1\\n• Nội dung tóm tắt 2",
  "category": "regulation",
  "importance": "high"
}
`;

      const model = this.aiClient.getGenerativeModel({
        model: this.modelName,
        generationConfig: { responseMimeType: 'application/json' }
      });

      const response = await model.generateContent(prompt);
      const responseText = response.response.text() || '';
      const result: AIAnalysisResult = JSON.parse(responseText);

      return {
        relevant: result.relevant,
        title: result.title || article.title,
        summary: result.summary || '',
        category: result.category || 'other',
        importance: result.importance || 'low'
      };
    } catch (err: any) {
      console.error(`[AI] Error analyzing article "${article.title}":`, err.message);
      // Fallback in case of API failure
      return {
        relevant: true,
        title: article.title,
        summary: article.contentSnippet || '',
        category: 'other',
        importance: 'low'
      };
    }
  }
}

export default AIService;
