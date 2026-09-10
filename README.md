# GoldZone API v2

Backend TypeScript cho GoldZone, sử dụng Express 5, MySQL và Prisma ORM. Số dư và kết quả game chỉ được thay đổi trong transaction ở server. Đây là nền tảng game điểm/vàng nội bộ; không phải cổng tiền thật.

## Khởi động (dev, MySQL của Laragon)

Mở Laragon, bấm **Start All** để chạy MySQL ở `localhost:3306` (user `root`, mật khẩu trống). Tạo database và dựng schema:

```powershell
mysql -u root -e "CREATE DATABASE IF NOT EXISTS goldzone CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

- API dev: `http://localhost:3000/api`
- Web dev: `http://localhost:5173` (FE proxy `/api` sang cổng 3000)
- MySQL dev: `localhost:3306`, database `goldzone`

`npm run db:seed` nạp vài tài khoản người chơi mẫu từ `prisma/seed.ts`; bỏ qua bước này nếu muốn database trống.

## Khởi động (Docker)

```powershell
docker compose up -d
```

Lệnh trên build và chạy đủ MySQL, backend và frontend. Migration tự chạy trước khi backend nhận request.

- Web Docker: `http://localhost:8080`
- API Docker: `http://localhost:3001/api`
- MySQL Docker: `localhost:3307`

Các cổng Docker dùng `8080/3001/3307` để có thể chạy song song với FE/BE dev tại `5173/3000` và MySQL của Laragon tại `3306`.

Xem trạng thái/log:

```powershell
docker compose ps
docker compose logs -f backend
```

## Kiến trúc

- `prisma/schema.prisma`: user, session, sổ cái ví, ván game, yêu cầu rút, giao dịch nạp từ ngân hàng, tài khoản nhận tiền và quà ngày.
- `prisma/migrations`: SQL migration có thể deploy trên các môi trường.
- `src/services`: xác thực, game, transaction ví và duyệt thanh toán.
- `src/routes`: validate request bằng Zod và ánh xạ REST API.
- `src/middleware`: access token, phân quyền admin và rate limit.

## API chính

| Method | Endpoint | Chức năng |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | Tài khoản, nhận 50.000 vàng chào mừng và access/refresh token |
| POST | `/auth/refresh`, `/auth/logout` | Xoay vòng/thu hồi session |
| GET/PATCH | `/me` | Hồ sơ |
| GET | `/transactions` | Sổ cái số dư |
| POST | `/games/slot/spin` | Slot, RTP thiết kế 95% |
| POST | `/games/dice/play` | Tài Xỉu, trả 1.98x |
| POST | `/games/fish/shoot` | Bắn cá, RTP thiết kế 92% |
| GET | `/games/history`, `/games/verify/:id` | Lịch sử và proof |
| POST | `/wallet/daily-bonus` | Quà duy nhất mỗi ngày |
| GET | `/wallet` | Số dư: tổng / khả dụng / đang khoá |
| GET | `/wallet/deposit-info` | Tài khoản Timo và nội dung chuyển khoản |
| GET | `/wallet/transactions`, `/wallet/deposits`, `/wallet/withdrawals` | Lịch sử ví |
| POST | `/wallet/withdraw` | Tạo yêu cầu rút (khoá tiền ngay) |
| GET | `/games/catalog` | Danh sách game admin đang bật, kèm hạn mức cược |
| GET/POST | `/admin/withdrawals`, `/admin/withdrawals/:id/approve|reject` | Duyệt hoặc từ chối yêu cầu rút |
| GET/POST | `/admin/deposits`, `/admin/deposits/:id/match` | Giao dịch nạp và khớp tay giao dịch chưa khớp |
| GET/PUT | `/admin/bank-account` | Tài khoản Timo nhận tiền |
| PATCH | `/admin/users/:id/status` | Khóa/mở tài khoản |
| GET | `/admin/stats`, `/admin/users` | Số liệu tổng quan và danh sách người chơi |
| GET/PATCH | `/admin/games`, `/admin/games/:key` | Ẩn/hiện, đổi tên, hạn mức cược và tỉ lệ trả thưởng từng game |
| POST | `/admin/games/:key/reset` | Khôi phục cấu hình mặc định của một game |
| GET | `/admin/games/:key/rounds` | Ván chơi gần đây của một game |

## Quản lý game

Bảng `Game` là nguồn sự thật cho từng game: tên hiển thị, mô tả, thứ tự ngoài sảnh,
`enabled`, hạn mức cược và `config` (tỉ lệ thắng, bội số trả thưởng). `game-catalog.service.ts`
cache 5 giây và validate `config` theo schema riêng của từng game — bản ghi hỏng rơi
về mặc định thay vì làm sập ván chơi.

Ẩn một game không chỉ là giấu thẻ ngoài sảnh: `requireEnabledGame` chặn mọi request
vào API của game đó (kể cả gõ thẳng URL), và phòng bắn cá qua WebSocket từ chối cả
kết nối mới lẫn phát bắn tiếp theo của phòng đang chạy.

Tạo tài khoản quản trị đầu tiên hoặc nâng quyền một tài khoản đã có:

```bash
npm run db:admin -- <tài_khoản> <mật_khẩu>
```

Giao diện quản trị nằm ở repo `goldzone-fe`, entry riêng tại `/admin`.

Mọi endpoint game cần `X-Idempotency-Key`. Unique constraint `(userId, requestId)` và transaction `Serializable` ngăn trừ tiền hai lần. `SHA256(serverSeed)` của ván phải khớp `serverProof`.

Tiền lưu bằng `BIGINT`; mọi biến động tạo một dòng `WalletLedger`. Quà ngày có unique constraint `(userId, claimDate)`.

**Nạp tiền** chạy tự động: người chơi chuyển khoản vào tài khoản Timo của hệ
thống với nội dung là chính `username` của mình. Worker `email-reader.service`
đọc email thông báo giao dịch qua IMAP, `timo-email.parser` bóc ra số tiền / nội
dung / mã giao dịch, rồi `bank-deposit.service` cộng tiền trong một transaction.
Chống cộng trùng dựa vào `UNIQUE(BankDeposit.bankTransactionId)`, nên đọc lại
cùng một email bao nhiêu lần cũng không cộng hai lần. Nội dung không khớp được
người chơi nào (hoặc khớp nhiều người) thì lưu `UNMATCHED` để admin xử lý tay.

Parser đã khớp với email thật của Timo (`test/fixtures/timo-credit.html`):
số tiền nằm sau chữ "vừa tăng" chứ không có nhãn, ngay dưới là "Số dư hiện tại"
không được bắt nhầm, và nội dung chuyển khoản bị ngân hàng nối thêm mã tham
chiếu — ví dụ `Mô tả: gghbb FT26253904002496`, trong đó `gghbb` là username còn
`FT26253904002496` là `bankTransactionId`.

Worker mặc định TẮT; bật bằng `EMAIL_READER_ENABLED=1` cùng các biến `IMAP_*`
trong `.env` (Gmail cần App Password). Xem `.env.example`.

**Rút tiền** làm tay: người chơi gửi yêu cầu kèm thông tin ngân hàng, hệ thống
khoá tiền bằng `User.lockedBalance` (số tiêu được = `balance - lockedBalance`,
áp dụng cho cả tiền cược game). Admin chuyển khoản bằng Timo rồi bấm duyệt —
lúc đó mới trừ hẳn `balance`; nếu từ chối thì chỉ nhả khoá.

Trước production, đổi secret/mật khẩu trong `.env`, dùng HTTPS và thay rate limiter bộ nhớ bằng Redis nếu chạy nhiều instance.

## Kiểm thử an toàn

Test tích hợp chỉ tạo/xóa tài khoản có tiền tố `it_`; tuyệt đối không xóa dữ liệu người dùng trong database dev. Với CI/production nên cấp `DATABASE_URL` riêng cho database test.
