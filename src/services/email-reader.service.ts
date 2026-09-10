import {ImapFlow} from 'imapflow';
import {simpleParser} from 'mailparser';
import {config} from '../config.js';
import {parseBankEmail} from './timo-email.parser.js';
import {recordBankDeposit} from './bank-deposit.service.js';

/**
 * Worker đọc email thông báo giao dịch của ngân hàng (SRS mục 18).
 *
 * Vòng chạy: kết nối IMAP → lấy thư chưa đọc → lọc thư của ngân hàng → bóc giao
 * dịch → giao cho bank-deposit.service xử lý. Việc chống cộng trùng nằm ở tầng
 * CSDL (UNIQUE bankTransactionId), nên worker này được phép đọc lại cùng một
 * email bao nhiêu lần cũng không gây cộng tiền hai lần — cờ \Seen chỉ để đỡ tốn
 * công đọc lại, không phải để bảo đảm đúng đắn.
 */

export type ReaderStats={runs:number;processed:number;completed:number;unmatched:number;duplicates:number;skipped:number;errors:number;lastRunAt:Date|null;lastError:string|null};

const stats:ReaderStats={runs:0,processed:0,completed:0,unmatched:0,duplicates:0,skipped:0,errors:0,lastRunAt:null,lastError:null};
export const readerStats=()=>({...stats});

const processedUids = new Set<number>();

let running=false;
let timer:NodeJS.Timeout|null=null;

function client(){
  return new ImapFlow({
    host:config.IMAP_HOST,port:config.IMAP_PORT,secure:config.IMAP_SECURE,
    auth:{user:config.IMAP_USER,pass:config.IMAP_PASSWORD},
    logger:false
  });
}

const fromBank=(address:string)=>!config.EMAIL_SENDER_FILTER||address.toLowerCase().includes(config.EMAIL_SENDER_FILTER.toLowerCase());

/** Một vòng quét. Trả về số email đã bóc được giao dịch, để test gọi trực tiếp. */
export async function pollOnce():Promise<ReaderStats>{
  const imap=client();
  await imap.connect();
  try{
    const lock=await imap.getMailboxLock(config.IMAP_MAILBOX);
    try{
      const since=new Date(Date.now()-config.EMAIL_LOOKBACK_DAYS*86_400_000);
      const searchCriteria: {since: Date; from?: string} = {since};
      if(config.EMAIL_SENDER_FILTER){
        searchCriteria.from = config.EMAIL_SENDER_FILTER;
      }
      const uids=(await imap.search(searchCriteria,{uid:true}))||[];
      if(!uids||!uids.length)return readerStats();

      for(const uid of uids){
        if(processedUids.has(Number(uid)))continue;
        try{
          const message=await imap.fetchOne(String(uid),{source:true},{uid:true});
          if(!message||!message.source)continue;
          const mail=await simpleParser(message.source);
          const from=mail.from?.value?.[0]?.address||'';

          if(!fromBank(from)){stats.skipped++;continue;}

          const parsed=parseBankEmail({
            from,subject:mail.subject,text:mail.text,
            html:typeof mail.html==='string'?mail.html:undefined,
            date:mail.date||new Date()
          });
          if(!parsed){
            stats.skipped++;
            processedUids.add(Number(uid));
            // Đánh dấu đã đọc kể cả khi không bóc được: nếu không, mọi thư quảng
            // cáo của ngân hàng sẽ bị parse lại mỗi phút cho đến hết đời.
            await imap.messageFlagsAdd(String(uid),['\\Seen'],{uid:true});
            continue;
          }

          const outcome=await recordBankDeposit(parsed);
          stats.processed++;
          if(outcome.result==='COMPLETED')stats.completed++;
          else if(outcome.result==='UNMATCHED')stats.unmatched++;
          else stats.duplicates++;

          processedUids.add(Number(uid));
          await imap.messageFlagsAdd(String(uid),['\\Seen'],{uid:true});
        }catch(error){
          // Một email hỏng không được làm chết cả vòng quét: các thư còn lại vẫn
          // phải được xử lý, và thư này sẽ được thử lại ở vòng sau vì chưa \Seen.
          stats.errors++;
          stats.lastError=error instanceof Error?error.message:String(error);
          console.error('[email-reader] không xử lý được email',uid,error);
        }
      }
      if(processedUids.size > 5000) processedUids.clear();
      return readerStats();
    }finally{lock.release();}
  }finally{
    await imap.logout().catch(()=>imap.close());
  }
}

async function tick(){
  if(running)return; // Vòng trước còn chạy — bỏ nhịp này thay vì chồng kết nối.
  running=true;
  try{
    stats.runs++;stats.lastRunAt=new Date();
    await pollOnce();
    stats.lastError=null;
  }catch(error){
    stats.errors++;
    stats.lastError=error instanceof Error?error.message:String(error);
    console.error('[email-reader] vòng quét thất bại:',stats.lastError);
  }finally{running=false;}
}

export function startEmailReader(){
  if(!config.EMAIL_READER_ENABLED)return console.log('[email-reader] đang tắt (EMAIL_READER_ENABLED=0)');
  if(!config.IMAP_HOST||!config.IMAP_USER||!config.IMAP_PASSWORD)
    return console.warn('[email-reader] thiếu IMAP_HOST/IMAP_USER/IMAP_PASSWORD — worker không khởi động');
  console.log(`[email-reader] quét ${config.IMAP_USER} mỗi ${config.EMAIL_POLL_INTERVAL_MS/1000}s`);
  void tick();
  timer=setInterval(()=>void tick(),config.EMAIL_POLL_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export function stopEmailReader(){if(timer){clearInterval(timer);timer=null;}}
