import {PrismaClient} from '@prisma/client';
const prisma = new PrismaClient();
const rows = await prisma.user.findMany({
  where: {username: {in: ['player1','player2','player3','player4','player5']}},
  select: {username: true, displayName: true, status: true, balance: true}
});
console.log('Da ton tai:', rows.length ? JSON.stringify(rows, (k,v)=>typeof v==='bigint'?Number(v):v) : 'khong co tai khoan nao');
console.log('Tong so user:', await prisma.user.count());
await prisma.$disconnect();
