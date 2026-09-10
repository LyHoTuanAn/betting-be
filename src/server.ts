import {createApp} from './app.js';
import {config} from './config.js';
import {prisma} from './lib/prisma.js';
import {WebSocketServer,type RawData} from 'ws';
import jwt from 'jsonwebtoken';
import {joinFishRoom,shootFish,tickFishRooms} from './services/fish-room.service.js';
import {requireEnabledGame} from './services/game-catalog.service.js';
import {startEmailReader,stopEmailReader} from './services/email-reader.service.js';

const server=createApp().listen(config.PORT,()=>console.log(`GoldZone API listening on http://localhost:${config.PORT}`));
const wss=new WebSocketServer({server,path:'/ws/fish'});
wss.on('connection',(socket,request)=>{
  try{
    const token=new URL(request.url||'',`http://${request.headers.host}`).searchParams.get('token');
    const payload=jwt.verify(token||'',config.JWT_ACCESS_SECRET,{issuer:'goldzone-api',audience:'goldzone-web'}) as jwt.JwtPayload;
    // Phòng bắn cá chỉ được mở khi admin đang bật game; kiểm tra trước khi
    // xếp người chơi vào phòng để họ không vào rồi mới bị chặn ở phát bắn.
    // Kiểm tra này phải hỏi CSDL nên không xong ngay trong tick hiện tại, trong
    // khi client gửi 'ready' ngay khi socket mở. Vì vậy listener được gắn ngay
    // lập tức và message đến sớm được xếp hàng, không thì chúng rơi mất im lặng.
    const pending:RawData[]=[];
    let handle=(raw:RawData)=>{pending.push(raw)};
    socket.on('message',raw=>handle(raw));

    void requireEnabledGame('FISH').then(()=>{
    const session=joinFishRoom(String(payload.sub),socket);
    handle=raw=>{
      let message:any;
      try{message=JSON.parse(raw.toString())}catch{return socket.send(JSON.stringify({type:'error',code:'INVALID_MESSAGE',message:'Dữ liệu không hợp lệ'}))}
      if(message.type==='ready'||message.type==='unready')return session.setReady(message.type==='ready');
      if(message.type==='leave')return socket.close(1000,'left');
      if(message.type!=='shoot')return socket.send(JSON.stringify({type:'error',code:'INVALID_MESSAGE',message:'Dữ liệu không hợp lệ'}));
      const x=Number(message.aimX),y=Number(message.aimY),power=Number(message.power);
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1||!Number.isInteger(power)||power<100||power>10000)
        return socket.send(JSON.stringify({type:'error',code:'INVALID_MESSAGE',message:'Mức bắn không hợp lệ'}));
      void shootFish(session.room,session.player.userId,session.player.id,{x,y,power})
        .catch(error=>socket.send(JSON.stringify({type:'error',code:error?.code||'SHOT_FAILED',message:error?.message||'Không thể xử lý phát bắn'})));
    };
    for(const raw of pending.splice(0))handle(raw);
    socket.on('close',session.leave);
    }).catch(error=>{
      socket.send(JSON.stringify({type:'error',code:error?.code||'GAME_DISABLED',message:error?.message||'Game đang tạm đóng'}));
      socket.close(1013,'game disabled');
    });
  }catch{socket.close(1008,'Unauthorized')}
});
const tick=setInterval(tickFishRooms,1000/12);
// Worker đọc email giao dịch Timo (SRS mục 18). Tự bỏ qua nếu chưa bật trong .env.
startEmailReader();
const shutdown=async()=>{server.close();stopEmailReader();await prisma.$disconnect();process.exit(0)};
process.on('SIGINT',()=>{clearInterval(tick);wss.close();void shutdown()});process.on('SIGTERM',()=>{clearInterval(tick);wss.close();void shutdown()});
