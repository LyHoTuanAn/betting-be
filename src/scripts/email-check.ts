import {ImapFlow} from 'imapflow';
import {simpleParser} from 'mailparser';
import {config} from '../config.js';
import {parseBankEmail} from '../services/timo-email.parser.js';
import {prisma} from '../lib/prisma.js';
import {extractUsernameCandidates} from '../services/timo-email.parser.js';

/**
 * Kiểm tra cấu hình IMAP mà KHÔNG đụng vào tiền.
 *
 * Chạy khô hoàn toàn: không đánh dấu email đã đọc, không ghi CSDL, không cộng
 * số dư. Mục đích là trả lời đúng ba câu trước khi bật worker thật:
 * đăng nhập được chưa, có thấy email Timo không, và parser bóc ra đúng chưa.
 *
 *   npm run email:check          # nhìn lại EMAIL_LOOKBACK_DAYS ngày
 *   npm run email:check -- 30    # nhìn lại 30 ngày
 */

const days=Number(process.argv[2])||config.EMAIL_LOOKBACK_DAYS;
const money=(value:number)=>value.toLocaleString('vi-VN');

function requireConfig(){
  const missing=[
    !config.IMAP_HOST&&'IMAP_HOST',
    !config.IMAP_USER&&'IMAP_USER',
    !config.IMAP_PASSWORD&&'IMAP_PASSWORD'
  ].filter(Boolean);
  if(!missing.length)return;
  console.error(`\n✖ Thiếu ${missing.join(', ')} trong .env\n`);
  if(missing.includes('IMAP_PASSWORD'))
    console.error('  IMAP_PASSWORD là App Password 16 ký tự của Gmail, không phải mật khẩu đăng nhập.\n  Tạo tại https://myaccount.google.com/apppasswords (cần bật 2FA trước).\n');
  process.exit(1);
}

async function main(){
  requireConfig();
  console.log(`\nKết nối ${config.IMAP_USER} tại ${config.IMAP_HOST}:${config.IMAP_PORT}...`);

  const imap=new ImapFlow({
    host:config.IMAP_HOST,port:config.IMAP_PORT,secure:config.IMAP_SECURE,
    auth:{user:config.IMAP_USER,pass:config.IMAP_PASSWORD},logger:false
  });

  try{await imap.connect()}
  catch(error){
    const message=error instanceof Error?error.message:String(error);
    console.error(`\n✖ Không đăng nhập được: ${message}\n`);
    if(/auth/i.test(message))
      console.error('  Gmail từ chối mật khẩu. Gần như chắc chắn IMAP_PASSWORD đang là mật khẩu\n  đăng nhập thường — phải dùng App Password 16 ký tự, dán liền không khoảng trắng.\n');
    process.exit(1);
  }
  console.log('✔ Đăng nhập thành công');

  const lock=await imap.getMailboxLock(config.IMAP_MAILBOX);
  try{
    const since=new Date(Date.now()-days*86_400_000);
    // Quét cả thư đã đọc: người dùng thường đã mở email báo có trên điện thoại.
    // imapflow trả về `false` khi tìm kiếm thất bại, không phải mảng rỗng.
    const uids=await imap.search({since},{uid:true})||[];
    console.log(`✔ Hộp ${config.IMAP_MAILBOX}: ${uids.length} email trong ${days} ngày gần nhất\n`);
    if(!uids.length)return;

    let fromBank=0,parsed=0;
    for(const uid of uids){
      const message=await imap.fetchOne(String(uid),{source:true},{uid:true});
      if(!message||!message.source)continue;
      const mail=await simpleParser(message.source);
      const from=mail.from?.value?.[0]?.address||'';
      if(config.EMAIL_SENDER_FILTER&&!from.toLowerCase().includes(config.EMAIL_SENDER_FILTER.toLowerCase()))continue;

      fromBank++;
      const deposit=parseBankEmail({
        from,subject:mail.subject,text:mail.text,
        html:typeof mail.html==='string'?mail.html:undefined,
        date:mail.date||new Date(),
        messageId:mail.messageId
      });

      console.log(`── ${mail.date?.toLocaleString('vi-VN')} · ${from}`);
      console.log(`   ${mail.subject}`);
      if(!deposit){
        console.log('   → BỎ QUA (không phải báo có, hoặc thiếu số tiền/nội dung/mã giao dịch)\n');
        continue;
      }
      parsed++;

      const candidates=extractUsernameCandidates(deposit.transferContent);
      const users=candidates.length
        ? await prisma.user.findMany({where:{username:{in:candidates}},select:{username:true}})
        : [];
      const verdict=users.length===1?`sẽ CỘNG cho @${users[0]!.username}`
        :users.length>1?`UNMATCHED — nội dung khớp ${users.length} người chơi`
        :'UNMATCHED — không có người chơi nào khớp';

      const already=await prisma.bankDeposit.findUnique({where:{bankTransactionId:deposit.bankTransactionId},select:{status:true}});
      console.log(`   → ${money(deposit.amount)} VND · mã ${deposit.bankTransactionId}`);
      console.log(`     nội dung: "${deposit.transferContent}" → ứng viên: ${candidates.join(', ')||'(không có)'}`);
      console.log(`     ${already?`ĐÃ XỬ LÝ trước đó (${already.status}), sẽ bỏ qua`:verdict}\n`);
    }

    console.log(`Tổng kết: ${fromBank} email từ ${config.EMAIL_SENDER_FILTER||'mọi người gửi'}, bóc được ${parsed} giao dịch.`);
    console.log('Đây là chạy khô — chưa có email nào bị đánh dấu đã đọc và chưa có đồng nào được cộng.\n');
  }finally{
    lock.release();
    await imap.logout().catch(()=>imap.close());
    await prisma.$disconnect();
  }
}

main().catch(error=>{console.error(error);process.exit(1)});
