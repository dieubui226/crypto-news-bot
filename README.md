# 🤖 Real-time Telegram Digital Asset News Bot for Vietnam

Bot Telegram quét tin tức tự động và realtime (thời gian thực) về thị trường tài sản số (Crypto, Blockchain, Web3, Kinh tế vĩ mô ảnh hưởng tới Crypto) dành riêng cho thị trường Việt Nam. Hệ thống tích hợp **Google Gemini API** để dịch tin từ nguồn nước ngoài, phân loại độ liên quan và tóm tắt thành các ý chính ngắn gọn bằng tiếng Việt trước khi gửi qua Telegram.

---

## 🌟 Tính Năng Nổi Bật

1. **Quét Tin Realtime Đa Nguồn**: Hỗ trợ nguồn tin tức trong nước (Coin68, BlogTienAo, VnExpress, CafeF) và quốc tế tốc độ cao (CryptoPanic RSS, Cointelegraph, CoinDesk).
2. **Bộ Lọc Thông Minh (AI Filter)**: Sử dụng Gemini AI (`gemini-1.5-flash`) để xác định tin tức rác và chỉ giữ lại những tin có tác động lớn đến thị trường crypto.
3. **Tóm Tắt & Dịch Thuật Tự Động**: Tự động dịch tiêu đề tiếng Anh sang tiếng Việt mượt mà và tóm tắt thành 2-3 gạch đầu dòng cô đọng nhất.
4. **Bảo Mật & Riêng Tư (Private Bot)**: Chỉ gửi tin đến danh sách Chat ID của bạn được thiết lập cấu hình trong file `.env`. Từ chối tất cả người lạ chat với bot.
5. **Dễ Dàng Thêm Nguồn Mới**: Cấu hình các nguồn tin (RSS hoặc HTML Scraper) được module hóa trong file `src/config/sources.ts`.
6. **Không Trùng Lặp Tin**: Sử dụng database JSON nội bộ siêu nhẹ để ghi nhớ các tin đã gửi, tự động dọn dẹp các tin cũ hơn 14 ngày để tối ưu bộ nhớ.

---

## 🛠️ Yêu Cầu Hệ Thống

- **Node.js** (Phiên bản 18 trở lên được khuyến nghị)
- **NPM** hoặc **Yarn**

---

## 🚀 Hướng Dẫn Cài Đặt

### Bước 1: Khởi tạo Project & Cài đặt thư viện
Mở terminal tại thư mục chứa source code và chạy lệnh:
```bash
npm install
```

### Bước 2: Cấu hình biến môi trường (`.env`)
1. Nhân bản file `.env.example` thành `.env`:
   ```bash
   cp .env.example .env
   ```
2. Mở file `.env` và điền các thông tin:
   - `TELEGRAM_BOT_TOKEN`: Token lấy từ [@BotFather](https://t.me/BotFather) trên Telegram.
   - `GEMINI_API_KEY`: API Key từ Google AI Studio (miễn phí hoặc trả phí).
   - `TELEGRAM_CHAT_IDS`: Chat ID của bạn (xem hướng dẫn lấy Chat ID ở phần dưới).

### Bước 3: Cách lấy Telegram Chat ID của bạn
1. Sau khi điền `TELEGRAM_BOT_TOKEN` vào `.env`, hãy chạy bot ở chế độ thử nghiệm:
   ```bash
   npm run dev
   ```
2. Tìm kiếm tên bot của bạn trên Telegram và nhấn **Start** (hoặc gửi tin `/start`).
3. Bot sẽ nhận diện bạn chưa được cấp quyền và phản hồi tin nhắn kèm theo **Chat ID của bạn**. Ví dụ: `Chat ID của bạn: 123456789`.
4. Copy dãy số này, mở file `.env` ra dán vào biến `TELEGRAM_CHAT_IDS` (Nếu có nhiều người nhận, ngăn cách bằng dấu phẩy `,`).
5. Khởi động lại bot. Nhấn `/start` lần nữa để xác nhận quyền truy cập thành công!

---

## 🔧 Cách Sử Dụng & Lệnh Chạy

### Chế độ Development (Nhà phát triển)
Chạy hot-reload và debug log trực tiếp:
```bash
npm run dev
```

### Chế độ Production (Triển khai chính thức)
Build TypeScript sang JavaScript và chạy bằng Node:
```bash
npm run build
npm start
```

### Chế độ Dry-Run (Chạy thử không gửi tin)
Nếu bạn muốn thử quét tin mà không gửi tin nhắn spam lên Telegram chat thực tế, hãy chỉnh biến sau trong `.env`:
```env
DRY_RUN=true
```
Bot sẽ in toàn bộ kết quả quét tin tức và tóm tắt của Gemini AI ra console của bạn.

---

## 📁 Cách Thêm/Sửa Nguồn Tin Tức

Các nguồn tin được cấu hình tại file `src/config/sources.ts`. Bạn có thể dễ dàng thêm nguồn mới theo cấu trúc:

```typescript
{
  name: 'Tên Nguồn',
  type: 'rss', // Có thể là 'rss' hoặc 'html'
  url: 'https://website-goc.com',
  rssUrl: 'https://website-goc.com/feed' // Đường dẫn RSS feed
}
```

Nếu một trang tin không hỗ trợ RSS, bạn có thể chuyển `type` thành `'html'` và thiết lập CSS Selector để bot crawl (cào dữ liệu) bằng `cheerio`:
```typescript
{
  name: 'Tên Trang Tin',
  type: 'html',
  url: 'https://vietnambiz.vn/blockchain.htm',
  selector: 'div.list-news-item',      // Selector cho mỗi thẻ tin
  titleSelector: 'a.title-news',       // Selector cho tiêu đề bên trong thẻ tin
  linkSelector: 'a.title-news'         // Selector cho link bên trong thẻ tin
}
```
