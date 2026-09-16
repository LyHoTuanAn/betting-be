import {createApp} from './app.js';
import {config} from './config.js';
import {prisma} from './lib/prisma.js';
import {WebSocketServer,type RawData} from 'ws';
import jwt from 'jsonwebtoken';
import {joinFishRoom,shootFish,tickFishRooms} from './services/fish-room.service.js';
import {
  joinRouletteRoom,
  tickRouletteRooms
} from './services/roulette-room.service.js';
import {
  joinBauCuaRoom,
  tickBauCuaRooms
} from './services/baucua-room.service.js';
import {requireEnabledGame,type GameConfig} from './services/game-catalog.service.js';
import {startEmailReader,stopEmailReader} from './services/email-reader.service.js';

const app = createApp();
const server = app.listen(config.PORT, () => console.log(`GoldZone API listening on http://localhost:${config.PORT}`));

const fishWss = new WebSocketServer({noServer: true});
const rouletteWss = new WebSocketServer({noServer: true});
const baucuaWss = new WebSocketServer({noServer: true});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
  if (pathname === '/ws/fish') {
    fishWss.handleUpgrade(request, socket, head, ws => {
      fishWss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/roulette') {
    rouletteWss.handleUpgrade(request, socket, head, ws => {
      rouletteWss.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/baucua') {
    baucuaWss.handleUpgrade(request, socket, head, ws => {
      baucuaWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Fish WebSocket Handler
fishWss.on('connection', (socket, request) => {
  try {
    const token = new URL(request.url || '', `http://${request.headers.host}`).searchParams.get('token');
    const payload = jwt.verify(token || '', config.JWT_ACCESS_SECRET, {issuer: 'goldzone-api', audience: 'goldzone-web'}) as jwt.JwtPayload;
    const pending: RawData[] = [];
    let handle = (raw: RawData) => { pending.push(raw); };
    socket.on('message', raw => handle(raw));

    void requireEnabledGame('FISH').then(async () => {
      let userMeta = { id: String(payload.sub), username: '', displayName: '' };
      try {
        const u = await prisma.user.findUnique({
          where: { id: String(payload.sub) },
          select: { id: true, username: true, displayName: true }
        });
        if (u) userMeta = u;
      } catch (_) {}

      const session = joinFishRoom(userMeta, socket);
      handle = raw => {
        let message: any;
        try { message = JSON.parse(raw.toString()); } catch { return socket.send(JSON.stringify({type: 'error', code: 'INVALID_MESSAGE', message: 'Dữ liệu không hợp lệ'})); }
        if (message.type === 'ready' || message.type === 'unready') return session.setReady(message.type === 'ready');
        if (message.type === 'leave') return socket.close(1000, 'left');
        if (message.type !== 'shoot') return socket.send(JSON.stringify({type: 'error', code: 'INVALID_MESSAGE', message: 'Dữ liệu không hợp lệ'}));
        const x = Number(message.aimX), y = Number(message.aimY), power = Number(message.power);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || !Number.isInteger(power) || power < 100 || power > 10000)
          return socket.send(JSON.stringify({type: 'error', code: 'INVALID_MESSAGE', message: 'Mức bắn không hợp lệ'}));
        void shootFish(session.room, session.player.userId, session.player.id, {x, y, power})
          .catch(error => socket.send(JSON.stringify({type: 'error', code: error?.code || 'SHOT_FAILED', message: error?.message || 'Không thể xử lý phát bắn'})));
      };
      for (const raw of pending.splice(0)) handle(raw);
      socket.on('close', session.leave);
    }).catch(error => {
      socket.send(JSON.stringify({type: 'error', code: error?.code || 'GAME_DISABLED', message: error?.message || 'Game đang tạm đóng'}));
      socket.close(1013, 'game disabled');
    });
  } catch {
    socket.close(1008, 'Unauthorized');
  }
});

// Roulette Multiplayer WebSocket Handler
rouletteWss.on('connection', (socket, request) => {
  try {
    const urlObj = new URL(request.url || '', `http://${request.headers.host}`);
    const token = urlObj.searchParams.get('token');
    const payload = jwt.verify(token || '', config.JWT_ACCESS_SECRET, {issuer: 'goldzone-api', audience: 'goldzone-web'}) as jwt.JwtPayload;
    const pending: RawData[] = [];
    let handle = (raw: RawData) => { pending.push(raw); };
    socket.on('message', raw => handle(raw));

    void requireEnabledGame('ROULETTE').then(async () => {
      let userMeta = { id: String(payload.sub), username: '', displayName: '', avatar: '/assets/home-avatar.webp', balance: 0 };
      try {
        const u = await prisma.user.findUnique({
          where: { id: String(payload.sub) },
          select: { id: true, username: true, displayName: true, balance: true }
        });
        if (u) {
          userMeta = { ...userMeta, id: u.id, username: u.username, displayName: u.displayName, balance: Number(u.balance) };
        }
      } catch (_) {}

      const session = joinRouletteRoom(userMeta, socket);
      handle = raw => {
        let message: any;
        try { message = JSON.parse(raw.toString()); } catch { return socket.send(JSON.stringify({type: 'error', code: 'INVALID_MESSAGE', message: 'Dữ liệu không hợp lệ'})); }
        if (message.type === 'ready' || message.type === 'unready') return session.setReady(message.type === 'ready');
        if (message.type === 'leave') return socket.close(1000, 'left');
        if (message.type === 'bet') return session.placeBet(String(message.target), Number(message.amount));
        if (message.type === 'clear_bets' || message.type === 'clear-bets') return session.clearBets();
      };
      for (const raw of pending.splice(0)) handle(raw);
      socket.on('close', session.leave);
    }).catch(error => {
      socket.send(JSON.stringify({type: 'error', code: error?.code || 'GAME_DISABLED', message: error?.message || 'Game Roulette đang tạm đóng'}));
      socket.close(1013, 'game disabled');
    });
  } catch {
    socket.close(1008, 'Unauthorized');
  }
});

// Bau Cua Multiplayer WebSocket Handler
baucuaWss.on('connection', (socket, request) => {
  try {
    const token = new URL(request.url || '', `http://${request.headers.host}`).searchParams.get('token');
    const payload = jwt.verify(token || '', config.JWT_ACCESS_SECRET, {issuer: 'goldzone-api', audience: 'goldzone-web'}) as jwt.JwtPayload;
    const pending: RawData[] = [];
    let handle = (raw: RawData) => { pending.push(raw); };
    socket.on('message', raw => handle(raw));

    void requireEnabledGame('BAUCUA').then(async game => {
      let userMeta = {id: String(payload.sub), username: '', displayName: '', avatar: '/assets/home-avatar.webp', balance: 0};
      try {
        const u = await prisma.user.findUnique({
          where: {id: String(payload.sub)},
          select: {id: true, username: true, displayName: true, balance: true}
        });
        if (u) userMeta = {...userMeta, id: u.id, username: u.username, displayName: u.displayName, balance: Number(u.balance)};
      } catch (_) {}

      // Hạn mức và bảng tỉ lệ lấy từ cấu hình admin, không chôn cứng trong phòng.
      const session = joinBauCuaRoom(userMeta, socket, {
        minBet: game.minBet,
        maxBet: game.maxBet,
        paytable: game.config as GameConfig<'BAUCUA'>
      });
      handle = raw => {
        let message: any;
        try { message = JSON.parse(raw.toString()); } catch { return socket.send(JSON.stringify({type: 'error', code: 'INVALID_MESSAGE', message: 'Dữ liệu không hợp lệ'})); }
        if (message.type === 'ready' || message.type === 'unready') return session.setReady(message.type === 'ready');
        if (message.type === 'leave') return socket.close(1000, 'left');
        if (message.type === 'bet') return session.placeBet(String(message.target), Number(message.amount));
        if (message.type === 'clear_bets' || message.type === 'clear-bets') return session.clearBets();
      };
      for (const raw of pending.splice(0)) handle(raw);
      // Nhịp tim: phòng ping mỗi 15s, pong về là bằng chứng máy còn nối mạng.
      socket.on('pong', session.markAlive);
      socket.on('close', session.leave);
    }).catch(error => {
      socket.send(JSON.stringify({type: 'error', code: error?.code || 'GAME_DISABLED', message: error?.message || 'Game Bầu Cua đang tạm đóng'}));
      socket.close(1013, 'game disabled');
    });
  } catch {
    socket.close(1008, 'Unauthorized');
  }
});

const fishTick = setInterval(tickFishRooms, 1000 / 60);
const rouletteTick = setInterval(() => {
  void tickRouletteRooms();
}, 1000);
const baucuaTick = setInterval(() => {
  void tickBauCuaRooms();
}, 1000);

startEmailReader();

const shutdown = async () => {
  server.close();
  stopEmailReader();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => {
  clearInterval(fishTick);
  clearInterval(rouletteTick);
  clearInterval(baucuaTick);
  fishWss.close();
  rouletteWss.close();
  baucuaWss.close();
  void shutdown();
});

process.on('SIGTERM', () => {
  clearInterval(fishTick);
  clearInterval(rouletteTick);
  clearInterval(baucuaTick);
  fishWss.close();
  rouletteWss.close();
  baucuaWss.close();
  void shutdown();
});
