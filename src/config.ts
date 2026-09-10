import 'dotenv/config';
import {z} from 'zod';

/**
 * `z.coerce.boolean()` dùng quy tắc truthy của JS nên chuỗi "0"/"false" vẫn ra
 * `true` — đúng thứ khiến một cờ tắt trong .env lại bật ở môi trường thật.
 */
const envBoolean = (fallback: boolean) => z.string().optional().transform(value =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

export const config = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),

  // Email Reader (SRS mục 18). Mặc định TẮT: máy dev không cần hộp thư thật,
  // và bật nhầm ở môi trường phụ sẽ khiến hai nơi cùng đọc một hộp thư.
  EMAIL_READER_ENABLED: envBoolean(false),
  IMAP_HOST: z.string().default(''),
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
  IMAP_SECURE: envBoolean(true),
  IMAP_USER: z.string().default(''),
  IMAP_PASSWORD: z.string().default(''),
  IMAP_MAILBOX: z.string().default('INBOX'),
  // Chỉ đọc thư từ địa chỉ chứa chuỗi này; để rỗng thì đọc mọi thư chưa đọc.
  EMAIL_SENDER_FILTER: z.string().default('timo.vn'),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  // Lần chạy đầu chỉ nhìn lại chừng này ngày, tránh quét lại cả hộp thư cũ.
  EMAIL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  WITHDRAW_MIN: z.coerce.number().int().min(1).default(50_000),
  WITHDRAW_MAX: z.coerce.number().int().min(1).default(100_000_000)
}).parse(process.env);
