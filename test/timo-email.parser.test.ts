import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {parseBankEmail,extractUsernameCandidates} from '../src/services/timo-email.parser.js';

/** Email thật do Timo gửi (đã giải mã quoted-printable như mailparser trả về). */
const timoHtml=readFileSync(fileURLToPath(new URL('./fixtures/timo-credit.html',import.meta.url)),'utf8');
const timoEmail={
  from:'support@timo.vn',
  subject:'Thông báo thay đổi số dư tài khoản',
  date:new Date('2026-09-10T02:38:42.000Z'),
  html:timoHtml
};

const received=new Date('2026-09-10T07:32:05.000Z');

/** Định dạng nêu trong SRS mục 4. */
const srsEmail={
  from:'no-reply@timo.vn',
  subject:'Timo - Bien dong so du',
  date:received,
  text:`Quy khach vua nhan duoc mot khoan tien vao tai khoan.

Amount: 1,000,000 VND
Content: teddy123
Transaction ID: FT123456789
Time: 10/09/2026 14:32:05`
};

describe('parseBankEmail',()=>{
 it('đọc được đủ 4 trường từ email đúng định dạng SRS',()=>{
  const parsed=parseBankEmail(srsEmail);
  expect(parsed).toEqual({
   bankTransactionId:'FT123456789',
   amount:1_000_000,
   transferContent:'teddy123',
   transactionTime:new Date('2026-09-10T14:32:05+07:00'),
   emailSubject:'Timo - Bien dong so du'
  });
 });

 it('đọc được email tiếng Việt có dấu, số tiền dùng dấu chấm',()=>{
  const parsed=parseBankEmail({
   from:'notification@timo.vn',
   subject:'Thông báo biến động số dư',
   date:received,
   text:`Tài khoản: 9021 0000 1234
Số tiền: +1.500.000 VNĐ
Nội dung: teddy123 chuyen tien
Mã giao dịch: FT2609100001
Thời gian: 10/09/2026 14:32:05
Số dư khả dụng: 12.500.000 VNĐ`
  });
  expect(parsed?.amount).toBe(1_500_000);
  expect(parsed?.transferContent).toBe('teddy123 chuyen tien');
  expect(parsed?.bankTransactionId).toBe('FT2609100001');
 });

 it('lấy nội dung từ HTML khi email không có phần text',()=>{
  const parsed=parseBankEmail({
   from:'no-reply@timo.vn',
   subject:'Timo',
   date:received,
   html:`<html><body><table>
     <tr><td>Số tiền</td><td>+2.000.000 VND</td></tr>
     <tr><td>Nội dung</td><td>abcxyz</td></tr>
     <tr><td>Mã giao dịch</td><td>FT777</td></tr>
   </table></body></html>`
  });
  expect(parsed?.amount).toBe(2_000_000);
  expect(parsed?.transferContent).toBe('abcxyz');
  expect(parsed?.bankTransactionId).toBe('FT777');
 });

 it('bỏ qua giao dịch tiền ra — chỉ tiền vào mới được cộng',()=>{
  expect(parseBankEmail({
   from:'no-reply@timo.vn',
   subject:'Timo - Giao dich tru tien',
   date:received,
   text:`Số tiền: -500.000 VND
Nội dung: thanh toan hoa don
Mã giao dịch: FT888`
  })).toBeNull();

  expect(parseBankEmail({
   from:'no-reply@timo.vn',
   subject:'Timo',
   date:received,
   text:`Ghi nợ tài khoản
Số tiền: 500.000 VND
Nội dung: teddy123
Mã giao dịch: FT889`
  })).toBeNull();
 });

 it('bỏ qua email không phải thông báo giao dịch',()=>{
  expect(parseBankEmail({
   from:'marketing@timo.vn',
   subject:'Ưu đãi tháng 9 từ Timo',
   date:received,
   text:'Mở thẻ ngay hôm nay để nhận quà.'
  })).toBeNull();
 });

 it('thiếu mã giao dịch thì trả null, không bịa mã',()=>{
  expect(parseBankEmail({
   from:'no-reply@timo.vn',
   subject:'Timo',
   date:received,
   text:`Số tiền: +1.000.000 VND
Nội dung: teddy123`
  })).toBeNull();
 });

 it('thiếu thời gian thì dùng ngày nhận email',()=>{
  const parsed=parseBankEmail({
   from:'no-reply@timo.vn',
   subject:'Timo',
   date:received,
   text:`Số tiền: +1.000.000 VND
Nội dung: teddy123
Mã giao dịch: FT555`
  });
  expect(parsed?.transactionTime).toEqual(received);
 });

 it('số tiền 0 hoặc âm không được coi là giao dịch hợp lệ',()=>{
  expect(parseBankEmail({
   from:'no-reply@timo.vn',
   subject:'Timo',
   date:received,
   text:`Số tiền: +0 VND
Nội dung: teddy123
Mã giao dịch: FT000`
  })).toBeNull();
 });
});

describe('extractUsernameCandidates',()=>{
 it('nội dung sạch trả về đúng một ứng viên',()=>{
  expect(extractUsernameCandidates('teddy123')).toEqual(['teddy123']);
 });

 it('tách được username khi ngân hàng chèn thêm tiền tố/hậu tố',()=>{
  const candidates=extractUsernameCandidates('CT DEN:0123456789 teddy123 FT26091012345678');
  expect(candidates).toContain('teddy123');
 });

 it('chuẩn hoá chữ hoa và bỏ dấu tiếng Việt',()=>{
  expect(extractUsernameCandidates('TEDDY123')).toContain('teddy123');
  expect(extractUsernameCandidates('nạp tiền teddy123')).toContain('teddy123');
 });

 it('bỏ các token quá ngắn hoặc quá dài so với luật username',()=>{
  const candidates=extractUsernameCandidates('ab teddy123 ' + 'x'.repeat(30));
  expect(candidates).toContain('teddy123');
  expect(candidates).not.toContain('ab');
  expect(candidates).not.toContain('x'.repeat(30));
 });

 it('ứng viên khớp cả chuỗi được ưu tiên đứng đầu',()=>{
  expect(extractUsernameCandidates('teddy123')[0]).toBe('teddy123');
 });
});

describe('email thật của Timo',()=>{
 it('bóc đúng cả bốn trường từ email Timo thật',()=>{
  expect(parseBankEmail(timoEmail)).toEqual({
   bankTransactionId:'FT26253904002496',
   amount:5_000,
   transferContent:'gghbb FT26253904002496',
   transactionTime:new Date('2026-09-10T09:38:00+07:00'),
   emailSubject:'Thông báo thay đổi số dư tài khoản'
  });
 });

 it('không nhầm "Số dư hiện tại" thành số tiền giao dịch',()=>{
  // Email Timo có hai số tiền bằng nhau; đổi số dư để lộ ra nếu bắt nhầm dòng.
  const parsed=parseBankEmail({...timoEmail,html:timoHtml.replace('Số dư hiện tại: 5.000 VND','Số dư hiện tại: 12.345.000 VND')});
  expect(parsed?.amount).toBe(5_000);
 });

 it('email báo tiền ra ("vừa giảm") bị bỏ qua',()=>{
  const parsed=parseBankEmail({...timoEmail,html:timoHtml.replace('vừa tăng 5.000 VND','vừa giảm 5.000 VND')});
  expect(parsed).toBeNull();
 });

 it('lấy được username người chơi từ mô tả có mã FT ngân hàng nối thêm',()=>{
  const candidates=extractUsernameCandidates('gghbb FT26253904002496');
  expect(candidates).toContain('gghbb');
  // Mã tham chiếu ngân hàng không được coi là ứng viên username: nó chỉ làm
  // tăng nguy cơ khớp nhầm chứ không bao giờ là tên người chơi thật.
  expect(candidates).not.toContain('ft26253904002496');
 });

 it('tên khách hàng trong lời chào không bị nhầm thành nội dung chuyển khoản',()=>{
  expect(parseBankEmail(timoEmail)?.transferContent).not.toMatch(/Ly Ho Tuan An/i);
 });
});
