import {prisma} from '../lib/prisma.js';

export const DEFAULT_BANNERS = [
  {
    title: 'KHO BÁU HOÀNG KIM',
    subtitle: 'Nổ Hũ Jackpot Cực Khủng - Thưởng Lớn Hàng Giờ',
    image: '/assets/home-banner.webp',
    tag: 'HOT',
    actionScreen: 'slot',
    actionUrl: '',
    actionLabel: 'Chơi Ngay',
    enabled: true,
    sortOrder: 1
  },
  {
    title: 'ĐẠI CHIẾN TÀI XỈU',
    subtitle: 'Tỉ Lệ Trả Thưởng 1:1 Cực Cao - Rút Vàng Siêu Tốc',
    image: '/assets/home-dice.webp',
    tag: 'VIP',
    actionScreen: 'dice',
    actionUrl: '',
    actionLabel: 'Cược Ngay',
    enabled: true,
    sortOrder: 2
  },
  {
    title: 'BẮN CÁ ĐẠI DƯƠNG',
    subtitle: 'Săn Boss Rồng Vàng Nhận Hàng Triệu Xu',
    image: '/assets/home-fish.webp',
    tag: 'MỚI',
    actionScreen: 'fish',
    actionUrl: '',
    actionLabel: 'Săn Boss',
    enabled: true,
    sortOrder: 3
  }
];

export const DEFAULT_EVENTS = [
  {
    title: 'Nạp Lần Đầu Nhân Đôi Thưởng',
    category: 'deposit',
    badge: 'HOT',
    reward: '+100% Giá Trị',
    desc: 'Tặng ngay 100% giá trị nạp cho giao dịch nạp đầu tiên của thành viên mới.',
    image: '/assets/home-banner.webp',
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    actionType: 'wallet',
    actionUrl: '',
    actionLabel: 'Nạp vàng ngay',
    enabled: true,
    sortOrder: 2
  },
  {
    title: 'Đua Top Nổ Hũ Tuần',
    category: 'tournament',
    badge: 'GIẢI ĐẤU',
    reward: '50,000,000 Vàng',
    desc: 'Top 10 người chơi có tổng số điểm thắng Nổ Hũ cao nhất tuần sẽ nhận phần thưởng trị giá lên tới 50 triệu vàng.',
    image: '/assets/home-slot.webp',
    status: 'ACTIVE',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    actionType: 'slot',
    actionUrl: '',
    actionLabel: 'Tham gia quay',
    enabled: true,
    sortOrder: 3
  },
  {
    title: 'Săn Boss Thần Long Bắn Cá',
    category: 'fish',
    badge: 'ĐẶC BIỆT',
    reward: 'X500 Giá Trị Đạn',
    desc: 'Tiêu diệt Boss Thần Long Vàng trong khung giờ vàng 20:00 - 22:00 mỗi ngày để nhận hệ số nhân x500.',
    image: '/assets/home-fish.webp',
    status: 'ACTIVE',
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    actionType: 'fish',
    actionUrl: '',
    actionLabel: 'Vào săn Boss',
    enabled: true,
    sortOrder: 4
  },
  {
    title: 'Tài Xỉu Hoàn Trả 2% Cược Thua',
    category: 'dice',
    badge: 'HOÀN TIỀN',
    reward: '2% Không Giới Hạn',
    desc: 'Hoàn trả tự động 2% tổng tiền cược không thắng trong ngày cho tất cả bàn Tài Xỉu.',
    image: '/assets/home-dice.webp',
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    actionType: 'dice',
    actionUrl: '',
    actionLabel: 'Chơi Tài Xỉu',
    enabled: true,
    sortOrder: 5
  }
];

export async function ensureDefaultContent() {
  const [bannerCount, eventCount] = await Promise.all([
    prisma.banner.count(),
    prisma.event.count()
  ]);

  if (bannerCount === 0) {
    for (const b of DEFAULT_BANNERS) {
      await prisma.banner.create({data: b});
    }
  }

  if (eventCount === 0) {
    for (const e of DEFAULT_EVENTS) {
      await prisma.event.create({data: e});
    }
  }
}

export async function getPublicBanners() {
  await ensureDefaultContent();
  return prisma.banner.findMany({
    where: {enabled: true},
    orderBy: [{sortOrder: 'asc'}, {createdAt: 'desc'}]
  });
}

export async function getPublicEvents() {
  await ensureDefaultContent();
  return prisma.event.findMany({
    where: {enabled: true},
    orderBy: [{sortOrder: 'asc'}, {createdAt: 'desc'}]
  });
}

export async function getAllBannersAdmin() {
  await ensureDefaultContent();
  return prisma.banner.findMany({
    orderBy: [{sortOrder: 'asc'}, {createdAt: 'desc'}]
  });
}

export async function getAllEventsAdmin() {
  await ensureDefaultContent();
  return prisma.event.findMany({
    orderBy: [{sortOrder: 'asc'}, {createdAt: 'desc'}]
  });
}
