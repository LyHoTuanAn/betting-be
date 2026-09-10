/**
 * Bóc thông tin giao dịch tiền vào từ email thông báo của ngân hàng (Timo).
 *
 * Module này cố ý không chạm vào CSDL hay hộp thư: nó chỉ nhận một email đã đọc
 * sẵn và trả về giao dịch, nhờ vậy toàn bộ phần dễ sai — regex — kiểm thử được
 * mà không cần mail server. Mẫu email thật nằm ở `test/fixtures/timo-credit.html`.
 *
 * Email thật của Timo có dạng:
 *   "Tài khoản Spend Account vừa tăng 5.000 VND vào 10/09/2026 09:38.
 *    Số dư hiện tại: 5.000 VND.
 *    Mô tả: gghbb FT26253904002496."
 *
 * Ba điểm quyết định cách viết các mẫu dưới đây:
 *  - Số tiền KHÔNG có nhãn, nó nằm ngay sau chữ "tăng"; và ngay dòng dưới còn
 *    một số tiền thứ hai ("Số dư hiện tại") tuyệt đối không được bắt nhầm.
 *  - Ngân hàng nối mã tham chiếu FT… vào cuối nội dung người chuyển tự ghi, nên
 *    nội dung gần như không bao giờ khớp nguyên chuỗi với username.
 *  - Chữ tiếng Việt có dấu ("Mô tả", "vừa tăng") nên mọi so khớp đều chạy trên
 *    bản đã bỏ dấu, thay vì nhồi lớp dấu vào từng regex.
 */

export type RawEmail={from?:string;subject?:string;text?:string;html?:string;date:Date};
export type ParsedDeposit={bankTransactionId:string;amount:number;transferContent:string;transactionTime:Date;emailSubject:string};

/** Giới hạn username ở auth.routes.ts — dùng lại để dò username trong nội dung CK. */
const USERNAME_RE=/^[a-z0-9_]{4,24}$/;
/** Mã tham chiếu liên ngân hàng (FT + số) do ngân hàng tự nối vào nội dung. */
const BANK_REF_RE=/^ft\d{6,}$/i;

/**
 * Bỏ dấu tiếng Việt nhưng GIỮ NGUYÊN độ dài chuỗi, để vị trí khớp trên bản đã
 * bỏ dấu trỏ đúng vào bản gốc — nhờ đó nội dung chuyển khoản lưu lại vẫn còn dấu.
 */
function fold(value:string){
  let out='';
  for(const ch of value){
    if(ch==='đ'){out+='d';continue}
    if(ch==='Đ'){out+='D';continue}
    const base=ch.normalize('NFD').replace(/[̀-ͯ]/g,'');
    out+=base.length===ch.length?base:ch;
  }
  return out;
}

// Cách Timo diễn đạt tiền vào / tiền ra. Số tiền bám ngay sau động từ nên không
// thể lẫn với "Số dư hiện tại" ở dòng kế tiếp.
const TIMO_CREDIT=/(?:vua\s+)?tang\s+([\d.,]+)\s*(?:vnd|d)\b/i;
const TIMO_DEBIT=/(?:vua\s+)?(?:giam|tru)\s+([\d.,]+)\s*(?:vnd|d)\b/i;

/** Các ngân hàng khác thường có nhãn rõ ràng; giữ lại để không khoá cứng vào Timo. */
const AMOUNT_LABEL=/(?:so\s*tien|amount|credit\s*amount|gia\s*tri\s*giao\s*dich)\s*[:\-]?\s*([+\-]?\s*[\d.,]+)\s*(?:vnd|d)?/i;

const CREDIT_HINTS=[/tien\s*vao/i,/ghi\s*co/i,/bao\s*co/i,/nhan\s*duoc/i,/vua\s*tang/i,/credit(ed)?/i,/money\s*in/i,/incoming/i,/\+\s*[\d.,]+/];
const DEBIT_HINTS=[/tien\s*ra/i,/ghi\s*no\b/i,/tru\s*tien/i,/thanh\s*toan/i,/vua\s*giam/i,/debit(ed)?/i,/money\s*out/i,/outgoing/i,/chuyen\s*di\b/i];

// `d` để lấy được vị trí nhóm bắt, phục vụ cắt lại từ chuỗi gốc còn dấu.
const CONTENT_LABEL=/(?:noi\s*dung(?:\s*chuyen\s*khoan|\s*giao\s*dich)?|dien\s*giai|mo\s*ta|content|description|message|remark)\s*[:\-]?\s*(.+)/di;

const TXN_LABEL=/(?:ma\s*(?:giao\s*dich|gd|tham\s*chieu)|so\s*tham\s*chieu|transaction\s*(?:id|no|code)|trans\s*id|\breference(?:\s*no)?\b|\bref\b)\s*[:\-]?\s*([A-Za-z0-9._\-\/]{4,80})/i;
/** Mã FT… thường xuất hiện trần trong nội dung, không kèm nhãn. */
const BARE_TXN=/\b(FT[A-Z0-9]{6,40})\b/i;

const TIME_LABEL=/(?:thoi\s*gian(?:\s*giao\s*dich)?|ngay\s*gio|date\s*&?\s*time|\btime\b|\bdate\b)\s*[:\-]?\s*([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4}(?:[\s,]+[\d]{1,2}:[\d]{2}(?::[\d]{2})?)?)/i;
/** Timo viết "… vào 10/09/2026 09:38." */
const TIME_BARE=/\bvao\s+([\d]{1,2}[\/\-][\d]{1,2}[\/\-][\d]{4}(?:[\s,]+[\d]{1,2}:[\d]{2}(?::[\d]{2})?)?)/i;

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

/** Chỉ lấy phần giá trị trên cùng một dòng với nhãn, và bỏ dấu chấm cuối câu. */
function cleanContent(value:string){
  return (value.split('\n')[0]||'').trim().replace(/\s{2,}/g,' ').replace(/[.\s]+$/,'');
}

export function parseBankEmail(email:RawEmail):ParsedDeposit|null{
  const original=[email.subject||'',email.text||(email.html?htmlToText(email.html):'')].join('\n');
  if(!original.trim())return null;
  // So khớp trên bản bỏ dấu (giữ nguyên độ dài) rồi cắt lại từ bản gốc.
  const body=fold(original);

  const debitMatch=body.match(TIMO_DEBIT);
  const creditMatch=body.match(TIMO_CREDIT);
  if(debitMatch&&!creditMatch)return null;

  const amountRaw=creditMatch?.[1]??body.match(AMOUNT_LABEL)?.[1];
  const contentMatch=body.match(CONTENT_LABEL);
  const txnMatch=body.match(TXN_LABEL)||body.match(BARE_TXN);
  // Thiếu bất kỳ mảnh nào trong ba mảnh này thì không đủ căn cứ để cộng tiền,
  // và cũng không được đoán — bỏ qua email, để nó nằm lại hộp thư cho admin.
  if(!amountRaw||!contentMatch?.[1]||!txnMatch?.[1])return null;

  const amount=parseAmount(amountRaw);
  if(!Number.isFinite(amount)||amount<=0)return null;

  const signedNegative=/^\s*-/.test(amountRaw);
  const isCredit=!!creditMatch||CREDIT_HINTS.some(pattern=>pattern.test(body));
  const isDebit=signedNegative||DEBIT_HINTS.some(pattern=>pattern.test(body));
  if(isDebit||!isCredit)return null;

  // Cắt nội dung từ chuỗi gốc để giữ lại dấu tiếng Việt người chuyển đã ghi.
  const span=contentMatch.indices?.[1];
  const rawContent=span?original.slice(span[0],span[1]):contentMatch[1];
  const transferContent=cleanContent(rawContent);
  if(!transferContent)return null;

  const timeRaw=body.match(TIME_LABEL)?.[1]??body.match(TIME_BARE)?.[1];
  return {
    bankTransactionId:txnMatch[1].trim().toUpperCase(),
    amount:Math.round(amount),
    transferContent:transferContent.slice(0,255),
    transactionTime:timeRaw?parseVnTime(timeRaw,email.date):email.date,
    emailSubject:(email.subject||'').slice(0,255)
  };
}

/**
 * SRS mục 5 khớp `users.username = transfer_content`. Email Timo thật cho thấy
 * nội dung luôn bị ngân hàng nối thêm mã tham chiếu ("gghbb FT26253904002496"),
 * nên ngoài ứng viên khớp nguyên chuỗi — vẫn được ưu tiên đứng đầu đúng như SRS
 * — hàm này trả thêm từng token hợp lệ để service dò tiếp.
 */
export function extractUsernameCandidates(transferContent:string):string[]{
  const normalized=fold(transferContent).toLowerCase();
  const whole=normalized.trim().replace(/\s+/g,' ');
  const candidates:string[]=[];
  if(USERNAME_RE.test(whole))candidates.push(whole);
  for(const token of normalized.split(/[^a-z0-9_]+/)){
    if(USERNAME_RE.test(token)&&!candidates.includes(token))candidates.push(token);
  }
  // Bỏ mã tham chiếu ngân hàng, nhưng chỉ khi còn ứng viên khác: nếu nội dung
  // chỉ có mỗi mã đó thì giữ lại còn hơn không có gì để dò.
  const withoutRefs=candidates.filter(candidate=>!BANK_REF_RE.test(candidate));
  return withoutRefs.length?withoutRefs:candidates;
}
