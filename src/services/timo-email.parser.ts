/**
 * Bóc thông tin giao dịch tiền vào từ email thông báo của ngân hàng (Timo).
 *
 * Module này cố ý không chạm vào CSDL hay hộp thư: nó chỉ nhận một email đã đọc
 * sẵn và trả về giao dịch, nhờ vậy toàn bộ phần dễ sai — regex — kiểm thử được
 * mà không cần mail server.
 *
 * Chưa có mẫu email thật của Timo nên các mẫu regex dưới đây được viết rộng để
 * bắt cả những cách trình bày phổ biến của ngân hàng Việt Nam (tiếng Việt lẫn
 * tiếng Anh, số tiền dùng dấu chấm hoặc dấu phẩy). Khi có email thật, chỉnh
 * trong đúng file này là đủ — không nơi nào khác phụ thuộc vào định dạng email.
 */

export type RawEmail={from?:string;subject?:string;text?:string;html?:string;date:Date};
export type ParsedDeposit={bankTransactionId:string;amount:number;transferContent:string;transactionTime:Date;emailSubject:string};

/** Giới hạn username ở auth.routes.ts — dùng lại để dò username trong nội dung CK. */
const USERNAME_RE=/^[a-z0-9_]{4,24}$/;

/** Email phải có ít nhất một dấu hiệu là tiền VÀO, nếu không sẽ bị bỏ qua. */
const CREDIT_HINTS=[/ti[eề]n\s*v[aà]o/i,/ghi\s*c[oó]/i,/nh[aậ]n\s*[dđ]C?[uư][oợ]c/i,/b[aá]o\s*c[oó]/i,/credit(ed)?/i,/money\s*in/i,/incoming/i,/\+\s*[\d.,]+/];
/** Dấu hiệu tiền RA — thấy là loại ngay, tránh cộng nhầm giao dịch trừ tiền. */
const DEBIT_HINTS=[/ti[eề]n\s*ra/i,/ghi\s*n[ợo]\b/i,/tr[ừu]\s*ti[eề]n/i,/thanh\s*to[aá]n/i,/debit(ed)?/i,/money\s*out/i,/outgoing/i,/chuy[eể]n\s*[dđ]i\b/i];

const AMOUNT_LABEL=/(?:s[oố]\s*ti[eề]n|amount|credit\s*amount|gi[aá]\s*tr[iị]\s*giao\s*d[iị]ch)\s*[:\-]?\s*([+\-]?\s*[\d.,]+)\s*(?:vn[dđ]|đ|vnd)?/i;
const CONTENT_LABEL=/(?:n[oộ]i\s*dung(?:\s*chuy[eể]n\s*kho[aả]n|\s*giao\s*d[iị]ch)?|di[eễ]n\s*gi[aả]i|content|description|message|remark|mo\s*ta)\s*[:\-]?\s*(.+)/i;
const TXN_LABEL=/(?:m[aã]\s*(?:giao\s*d[iị]ch|gd|tham\s*chi[eế]u)|s[oố]\s*tham\s*chi[eế]u|transaction\s*(?:id|no|code)|trans\s*id|reference(?:\s*no)?|ref)\s*[:\-]?\s*([A-Za-z0-9._\-\/]{4,80})/i;
const TIME_LABEL=/(?:th[oờ]i\s*gian(?:\s*giao\s*d[iị]ch)?|ng[aà]y\s*gi[oờ]|date\s*&?\s*time|time|date)\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4}(?:[\s,]+[\d]{1,2}:[\d]{2}(?::[\d]{2})?)?)/i;
/** Mã dạng FT… thường xuất hiện trần trong nội dung, không kèm nhãn. */
const BARE_TXN=/\b(FT[A-Z0-9]{6,40})\b/i;

/**
 * Ngân hàng Việt Nam ghi giờ theo giờ Việt Nam nhưng hiếm khi ghi kèm múi giờ.
 * Diễn dịch cứng theo +07:00, nếu không giao dịch sẽ lệch 7 tiếng khi máy chủ
 * chạy ở UTC.
 */
const VN_OFFSET='+07:00';

/** Gỡ thẻ HTML thành văn bản có xuống dòng, để các regex theo dòng vẫn khớp. */
function htmlToText(html:string){
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ')
    .replace(/<\/(?:tr|div|p|li|h[1-6]|table)>/gi,'\n')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi,': ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,code)=>String.fromCharCode(Number(code)))
    .replace(/[ \t ]+/g,' ')
    .replace(/\n\s*\n+/g,'\n');
}

/**
 * "1.000.000" và "1,000,000" đều là một triệu. Chỉ coi là phần thập phân khi
 * dấu phân cách cuối cùng còn đúng 1–2 chữ số phía sau — cách duy nhất phân biệt
 * hai quy ước mà không cần biết trước locale của email.
 */
function parseAmount(raw:string){
  const cleaned=raw.replace(/\s/g,'');
  const sign=cleaned.startsWith('-')?-1:1;
  const digits=cleaned.replace(/^[+\-]/,'');
  const lastSep=Math.max(digits.lastIndexOf('.'),digits.lastIndexOf(','));
  if(lastSep>-1){
    const tail=digits.slice(lastSep+1);
    if(tail.length<=2&&!/[.,]/.test(tail))return sign*Number(digits.slice(0,lastSep).replace(/[.,]/g,'')+'.'+tail);
  }
  return sign*Number(digits.replace(/[.,]/g,''));
}

function parseVnTime(raw:string,fallback:Date){
  const match=raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if(!match)return fallback;
  const [day,month,year,hour='00',minute='00',second='00']=match.slice(1).map(part=>part??undefined) as (string|undefined)[];
  if(!day||!month||!year)return fallback;
  const iso=`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${minute}:${second}${VN_OFFSET}`;
  const date=new Date(iso);
  return Number.isNaN(date.getTime())?fallback:date;
}

/** Chỉ lấy phần giá trị trên cùng một dòng với nhãn, tránh nuốt cả dòng kế tiếp. */
function firstLineValue(value:string){
  return (value.split('\n')[0]||'').trim().replace(/\s{2,}/g,' ');
}

export function parseBankEmail(email:RawEmail):ParsedDeposit|null{
  const body=[email.subject||'',email.text||(email.html?htmlToText(email.html):'')].join('\n');
  if(!body.trim())return null;

  const amountMatch=body.match(AMOUNT_LABEL);
  const txnMatch=body.match(TXN_LABEL)||body.match(BARE_TXN);
  const contentMatch=body.match(CONTENT_LABEL);
  // Thiếu bất kỳ mảnh nào trong ba mảnh này thì không đủ căn cứ để cộng tiền,
  // và cũng không được đoán — bỏ qua email, để nó nằm lại hộp thư cho admin.
  if(!amountMatch||!txnMatch||!contentMatch)return null;

  const rawAmount=amountMatch[1];
  const rawContent=contentMatch[1];
  const rawTxn=txnMatch[1];
  if(!rawAmount||!rawContent||!rawTxn)return null;

  const amount=parseAmount(rawAmount);
  if(!Number.isFinite(amount)||amount<=0)return null;

  const signedNegative=/^\s*-/.test(rawAmount);
  const isDebit=signedNegative||DEBIT_HINTS.some(pattern=>pattern.test(body));
  const isCredit=CREDIT_HINTS.some(pattern=>pattern.test(body));
  if(isDebit||!isCredit)return null;

  const transferContent=firstLineValue(rawContent);
  if(!transferContent)return null;

  const timeMatch=body.match(TIME_LABEL);
  return {
    bankTransactionId:rawTxn.trim().toUpperCase(),
    amount:Math.round(amount),
    transferContent:transferContent.slice(0,255),
    transactionTime:timeMatch?.[1]?parseVnTime(timeMatch[1],email.date):email.date,
    emailSubject:(email.subject||'').slice(0,255)
  };
}

const stripDiacritics=(value:string)=>value.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D');

/**
 * SRS mục 5 khớp `users.username = transfer_content`. Thực tế ngân hàng hay chèn
 * thêm tiền tố ("CT DEN:...") và hậu tố (mã tham chiếu) vào nội dung, nên ngoài
 * ứng viên khớp nguyên chuỗi — luôn được ưu tiên đầu danh sách đúng như SRS —
 * hàm này trả thêm từng token hợp lệ để service dò tiếp. Nếu không, gần như mọi
 * lần chuyển khoản thật đều rơi vào UNMATCHED.
 */
export function extractUsernameCandidates(transferContent:string):string[]{
  const normalized=stripDiacritics(transferContent).toLowerCase();
  const whole=normalized.trim().replace(/\s+/g,' ');
  const candidates:string[]=[];
  if(USERNAME_RE.test(whole))candidates.push(whole);
  for(const token of normalized.split(/[^a-z0-9_]+/)){
    if(USERNAME_RE.test(token)&&!candidates.includes(token))candidates.push(token);
  }
  return candidates;
}
