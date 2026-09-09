import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

/**
 * Tạo tài khoản quản trị đầu tiên, hoặc nâng quyền một tài khoản đã có.
 * Dùng: npm run db:admin -- <tài_khoản> <mật_khẩu>
 * Mật khẩu chỉ bắt buộc khi tài khoản chưa tồn tại.
 */
const [username, password] = process.argv.slice(2);

if (!username) {
  console.error('Thiếu tên đăng nhập.\nDùng: npm run db:admin -- <tài_khoản> <mật_khẩu>');
  process.exit(1);
}

const prisma = new PrismaClient();
const existing = await prisma.user.findUnique({ where: { username } });

if (existing) {
  const user = await prisma.user.update({ where: { username }, data: { role: 'ADMIN', status: 'ACTIVE' } });
  console.log(`Đã nâng quyền quản trị cho @${user.username}`);
} else {
  if (!password || password.length < 8) {
    console.error('Tài khoản chưa tồn tại nên cần mật khẩu ít nhất 8 ký tự.\nDùng: npm run db:admin -- <tài_khoản> <mật_khẩu>');
    await prisma.$disconnect();
    process.exit(1);
  }
  const user = await prisma.user.create({
    data: { username, displayName: username, passwordHash: await bcrypt.hash(password, 12), role: 'ADMIN', balance: 0n }
  });
  console.log(`Đã tạo tài khoản quản trị @${user.username}`);
}

await prisma.$disconnect();
