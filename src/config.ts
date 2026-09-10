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
  DATABASE_URL: z.string().min(1).default('mysql://3f88VeV8J4CXs9C.root:iIcJhD13NgCTIVmI@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/goldzone?sslaccept=strict'),
  JWT_ACCESS_SECRET: z.string().min(32).default('goldzone-super-secret-jwt-key-minimum-32-chars-prod-2026'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  FRONTEND_ORIGIN: z.string().default('https://betting-fe-sable.vercel.app'),

  // Email Reader (SRS mục 18). Mặc định bật khi deploy.
  EMAIL_READER_ENABLED: envBoolean(true),
  IMAP_HOST: z.string().default('imap.gmail.com'),
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
  IMAP_SECURE: envBoolean(true),
  IMAP_USER: z.string().default('lyhotuanan2004@gmail.com'),
  IMAP_PASSWORD: z.string().default('czuq lhfe laad dyeh'),
  IMAP_MAILBOX: z.string().default('INBOX'),
  EMAIL_SENDER_FILTER: z.string().default('timo.vn'),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  EMAIL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  // Hạn mức rút tiền
  WITHDRAW_MIN: z.coerce.number().int().min(1).default(50_000),
  WITHDRAW_MAX: z.coerce.number().int().min(1).default(100_000_000),

  // Phòng bắn cá
  FISH_ROOM_CAPACITY: z.coerce.number().int().min(1).default(6),
  FISH_READY_TO_START: z.coerce.number().int().min(1).default(4),
  FISH_START_COUNTDOWN_MS: z.coerce.number().int().min(1000).default(30_000)
}).parse(process.env);
