import type {NextFunction, Request, Response} from 'express';
import {randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import jwt from 'jsonwebtoken';
import {z, ZodError} from 'zod';
import {config} from '../config.js';

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'REQUEST_ERROR',
    /** Thông tin bổ sung (trường nào sai, chờ bao lâu…) để client hiển thị đúng chỗ. */
    public details?: unknown
  ) { super(message); }
}

export const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res)).catch(next);
export const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? Number(item) : item));

/**
 * Mỗi request có một mã riêng, trả về trong header `X-Request-Id` và trong thân
 * lỗi 5xx. Người dùng báo lỗi kèm mã này là tìm được đúng dòng log, thay vì chỉ
 * biết "server báo lỗi" như trước.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  req.requestId = req.get('x-request-id')?.slice(0, 64) || randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

// ---------------------------------------------------------------------------
// Thông báo lỗi kiểm tra dữ liệu (Zod) bằng tiếng Việt
// ---------------------------------------------------------------------------

/** Tên trường theo cách người dùng nhìn thấy, để lỗi không đọc như log kỹ thuật. */
const FIELD_LABELS: Record<string, string> = {
  amount: 'Số tiền', bet: 'Mức cược', power: 'Mức bắn', side: 'Cửa đặt', fishKind: 'Loại cá',
  requestId: 'Mã chống trùng giao dịch', username: 'Tên đăng nhập', password: 'Mật khẩu',
  displayName: 'Tên hiển thị', refreshToken: 'Phiên đăng nhập', status: 'Trạng thái',
  note: 'Ghi chú', limit: 'Số bản ghi', search: 'Từ khoá tìm kiếm', key: 'Mã game',
  name: 'Tên', subtitle: 'Mô tả ngắn', enabled: 'Trạng thái bật/tắt', sortOrder: 'Thứ tự hiển thị',
  minBet: 'Cược tối thiểu', maxBet: 'Cược tối đa', maintenanceNote: 'Ghi chú bảo trì',
  config: 'Cấu hình game', rtp: 'RTP', payoutX: 'Hệ số trả thưởng',
  title: 'Tiêu đề', image: 'Ảnh', tag: 'Nhãn', category: 'Danh mục', badge: 'Huy hiệu',
  reward: 'Phần thưởng', desc: 'Nội dung', startDate: 'Ngày bắt đầu', endDate: 'Ngày kết thúc',
  actionScreen: 'Màn hình đích', actionUrl: 'Đường dẫn', actionLabel: 'Nhãn nút', actionType: 'Kiểu hành động'
};

const TYPE_NAMES: Record<string, string> = {
  string: 'chuỗi ký tự', number: 'số', int: 'số nguyên', bigint: 'số nguyên',
  boolean: 'true hoặc false', date: 'ngày tháng', array: 'danh sách', object: 'đối tượng'
};

/** Đơn vị đi kèm giới hạn min/max, phụ thuộc kiểu dữ liệu bị chặn. */
const LIMIT_UNITS: Record<string, string> = {string: ' ký tự', array: ' phần tử', set: ' phần tử', file: ' byte'};

export const fieldLabel = (name: string) => FIELD_LABELS[name] || name;

const labelOfPath = (path: readonly PropertyKey[] = []) => {
  const named = [...path].reverse().find(segment => typeof segment === 'string') as string | undefined;
  return named ? fieldLabel(named) : path.length ? path.join('.') : 'Dữ liệu gửi lên';
};

const formatNumber = (value: unknown) =>
  typeof value === 'number' || typeof value === 'bigint' ? Number(value).toLocaleString('vi-VN') : String(value);

/**
 * Zod mặc định trả câu tiếng Anh kiểu "Too small: expected number to be >=50000",
 * còn bản dịch sẵn của Zod thì ghép máy ("mong đợi number >=50000"). Hook này
 * dựng câu tiếng Việt nói rõ trường nào sai và ngưỡng hợp lệ là bao nhiêu.
 * Thông báo khai báo trực tiếp trên schema vẫn được ưu tiên hơn hook này.
 */
function vietnameseIssue(issue: any): string | undefined {
  const label = labelOfPath(issue.path ?? []);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null) return `${label} là bắt buộc`;
      return `${label} phải là ${TYPE_NAMES[String(issue.expected)] ?? String(issue.expected)}`;
    case 'too_small': {
      const unit = LIMIT_UNITS[String(issue.origin)] ?? '';
      if (issue.origin === 'number' && issue.minimum === 0 && issue.inclusive) return `${label} không được là số âm`;
      return issue.inclusive === false
        ? `${label} phải lớn hơn ${formatNumber(issue.minimum)}${unit}`
        : `${label} phải từ ${formatNumber(issue.minimum)}${unit} trở lên`;
    }
    case 'too_big': {
      const unit = LIMIT_UNITS[String(issue.origin)] ?? '';
      return issue.inclusive === false
        ? `${label} phải nhỏ hơn ${formatNumber(issue.maximum)}${unit}`
        : `${label} tối đa ${formatNumber(issue.maximum)}${unit}`;
    }
    case 'invalid_value': {
      const values = (issue.values ?? []).map((value: unknown) => `"${String(value)}"`).join(', ');
      return values ? `${label} chỉ nhận một trong các giá trị: ${values}` : `${label} không hợp lệ`;
    }
    case 'invalid_format':
      return issue.format === 'regex' ? `${label} sai định dạng cho phép` : `${label} sai định dạng ${issue.format}`;
    case 'not_multiple_of':
      return `${label} phải là bội số của ${formatNumber(issue.divisor)}`;
    case 'unrecognized_keys':
      return `Không nhận diện được trường: ${(issue.keys ?? []).join(', ')}`;
    case 'invalid_union':
      return `${label} không khớp định dạng nào được chấp nhận`;
    case 'invalid_key':
    case 'invalid_element':
      return `${label} chứa phần tử không hợp lệ`;
    default:
      return undefined;
  }
}

z.config({customError: vietnameseIssue});

/** Gom các issue của Zod thành một câu tóm tắt + danh sách chi tiết theo trường. */
export function describeZodError(error: ZodError) {
  const details = error.issues.map(issue => ({
    field: issue.path.join('.') || '(body)',
    label: labelOfPath(issue.path),
    message: issue.message
  }));
  const unique = [...new Set(details.map(detail => detail.message))];
  const summary = unique.slice(0, 3).join('; ') + (unique.length > 3 ? `; và ${unique.length - 3} lỗi khác` : '');
  return {error: summary || 'Dữ liệu không hợp lệ', code: 'VALIDATION_ERROR', details};
}

// ---------------------------------------------------------------------------
// Lỗi từ Prisma / body-parser / JWT → câu trả lời có nghĩa thay vì 500 chung chung
// ---------------------------------------------------------------------------

const targetLabel = (meta: unknown) => {
  const target = (meta as {target?: unknown} | undefined)?.target;
  const names = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  return names.map(name => fieldLabel(String(name))).join(', ');
};

function fromPrisma(error: unknown): AppError | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const target = targetLabel(error.meta);
    switch (error.code) {
      case 'P2000': return new AppError(422, `${target || 'Dữ liệu'} dài quá giới hạn cho phép`, 'VALUE_TOO_LONG');
      case 'P2002': return new AppError(409, target ? `${target} đã tồn tại` : 'Dữ liệu này đã tồn tại', 'DUPLICATE');
      case 'P2003': return new AppError(409, 'Dữ liệu đang được tham chiếu ở nơi khác nên không thể thao tác', 'FOREIGN_KEY_CONFLICT');
      case 'P2025': return new AppError(404, 'Không tìm thấy dữ liệu cần thao tác', 'RECORD_NOT_FOUND');
      case 'P2034': return new AppError(409, 'Hệ thống đang xử lý một giao dịch khác, vui lòng thử lại', 'TRANSACTION_CONFLICT');
      case 'P1001':
      case 'P1002':
      case 'P1008': return new AppError(503, 'Không kết nối được cơ sở dữ liệu, vui lòng thử lại sau ít phút', 'DATABASE_UNAVAILABLE');
    }
    return undefined;
  }
  if (error instanceof Prisma.PrismaClientInitializationError) return new AppError(503, 'Không kết nối được cơ sở dữ liệu, vui lòng thử lại sau ít phút', 'DATABASE_UNAVAILABLE');
  if (error instanceof Prisma.PrismaClientValidationError) return undefined; // lỗi lập trình, giữ nguyên 500 để lộ ra khi test
  return undefined;
}

/** body-parser gắn `type` cho lỗi của nó; nếu không dịch thì JSON hỏng cũng ra "Lỗi máy chủ". */
const BODY_PARSER_ERRORS: Record<string, [number, string, string]> = {
  'entity.parse.failed': [400, 'Nội dung gửi lên không phải JSON hợp lệ', 'INVALID_JSON'],
  'entity.too.large': [413, 'Dữ liệu gửi lên quá lớn (tối đa 100KB)', 'PAYLOAD_TOO_LARGE'],
  'encoding.unsupported': [415, 'Kiểu nén nội dung không được hỗ trợ', 'UNSUPPORTED_ENCODING'],
  'charset.unsupported': [415, 'Bảng mã không được hỗ trợ, hãy dùng UTF-8', 'UNSUPPORTED_CHARSET'],
  'request.aborted': [400, 'Kết nối bị ngắt khi đang gửi dữ liệu', 'REQUEST_ABORTED']
};

function fromKnownLibraries(error: unknown): AppError | undefined {
  const type = (error as {type?: string} | null)?.type;
  const mapped = type ? BODY_PARSER_ERRORS[type] : undefined;
  if (mapped) return new AppError(mapped[0], mapped[1], mapped[2]);
  if (error instanceof jwt.TokenExpiredError) return new AppError(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại', 'ACCESS_TOKEN_EXPIRED');
  if (error instanceof jwt.JsonWebTokenError) return new AppError(401, 'Token không hợp lệ, vui lòng đăng nhập lại', 'INVALID_ACCESS_TOKEN');
  if (error instanceof SyntaxError && 'body' in (error as object)) return new AppError(400, 'Nội dung gửi lên không phải JSON hợp lệ', 'INVALID_JSON');
  return undefined;
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const id = req.requestId || String(res.getHeader('X-Request-Id') || '');

  if (error instanceof ZodError) return res.status(422).json({...describeZodError(error), requestId: id});

  const known = error instanceof AppError ? error : fromKnownLibraries(error) ?? fromPrisma(error);
  if (known) {
    if (known.status >= 500) console.error(`[${id}] ${req.method} ${req.originalUrl} → ${known.status} ${known.code}`, error);
    return res.status(known.status).json({
      error: known.message,
      code: known.code,
      requestId: id,
      ...(known.details === undefined ? {} : {details: known.details})
    });
  }

  // Còn lại là lỗi ngoài dự kiến: log đầy đủ kèm mã request, trả về câu trả lời
  // nói rõ phải làm gì tiếp theo. Ngoài production kèm luôn nguyên nhân kỹ thuật
  // để dev không phải mò log.
  console.error(`[${id}] ${req.method} ${req.originalUrl} → 500 INTERNAL_ERROR`, error);
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return res.status(500).json({
    error: `Lỗi máy chủ ngoài dự kiến. Vui lòng thử lại; nếu vẫn lỗi hãy gửi mã ${id} cho bộ phận kỹ thuật.`,
    code: 'INTERNAL_ERROR',
    requestId: id,
    ...(config.NODE_ENV === 'production' ? {} : {cause})
  });
}
