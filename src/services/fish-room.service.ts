import type {WebSocket} from 'ws';
import {config} from '../config.js';
import {fishCatalog,fishDamage,fishRoomShot,play} from './game.service.js';
import {requireEnabledGame,type GameConfig} from './game-catalog.service.js';

const ROOM_CAPACITY=Number(process.env.FISH_ROOM_CAPACITY||config.FISH_ROOM_CAPACITY||6);
const READY_TO_START=Number(process.env.FISH_READY_TO_START||config.FISH_READY_TO_START||4);
const START_COUNTDOWN_MS=Number(process.env.FISH_START_COUNTDOWN_MS||config.FISH_START_COUNTDOWN_MS||30_000);

type FishKind=keyof typeof fishCatalog;

/** Mirrors the fishTypes table on the client so both ends agree on size and health. */
const fishSpec:Record<FishKind,{hp:number;radius:number;speed:number}>={
  clown:{hp:120,radius:.055,speed:.105},
  blue:{hp:150,radius:.058,speed:.1},
  lion:{hp:220,radius:.066,speed:.092},
  arowana:{hp:330,radius:.075,speed:.085},
  manta:{hp:420,radius:.085,speed:.078},
  turtle:{hp:540,radius:.09,speed:.07},
  squid:{hp:620,radius:.086,speed:.074},
  shark:{hp:700,radius:.1,speed:.068},
  dragon:{hp:950,radius:.115,speed:.06},
  dragoncarp:{hp:1400,radius:.13,speed:.054},
  mermaid:{hp:2000,radius:.16,speed:.046}
};

const COMMON:FishKind[]=['clown','blue','lion','arowana','manta','turtle','squid','shark'];
const SCHOOL:FishKind[]=['clown','blue','lion','arowana','manta'];
const RARE:FishKind[]=['dragon','dragoncarp','mermaid'];

/** The twelve clock bearings; every fish travels along one of them. */
const CLOCK=Array.from({length:12},(_,i)=>i*Math.PI/6);

/**
 * One lap of the spawn director. Fish stay sparse most of the time, a dense
 * school arrives on schedule, and a single high-value fish shows up later.
 * Each stage is announced one stage ahead so the client can warn the room.
 */
const CYCLE=[
  {name:'calm',ms:40_000,target:10,pool:COMMON},
  {name:'school-warn',ms:5_000,target:10,pool:COMMON,warn:'school'},
  {name:'school',ms:20_000,target:26,pool:SCHOOL},
  {name:'calm',ms:30_000,target:10,pool:COMMON},
  {name:'rare-warn',ms:7_000,target:10,pool:COMMON,warn:'rare'},
  {name:'rare',ms:25_000,target:12,pool:COMMON,rare:true}
] as const;

type Fish={
  id:string;kind:FishKind;x:number;y:number;heading:number;speed:number;
  radius:number;value:number;hp:number;maxHp:number;
  wanderAmp:number;wanderFreq:number;wanderPhase:number;born:number;tag:'common'|'school'|'rare';
};
type Player={id:string;userId:string;socket:WebSocket;ready:boolean};
type Room={
  id:string;status:'waiting'|'playing';players:Map<string,Player>;fish:Fish[];
  lastTick:number;startedAt:number;countdownEndsAt:number|null;
  segment:number;segmentEndsAt:number;nextFishId:number;ticks:number;
};

const rooms=new Map<string,Room>();
let nextRoomId=1;

const pick=<T>(list:readonly T[]):T=>list[Math.floor(Math.random()*list.length)]!;
const round=(n:number)=>Math.round(n*1000)/1000;

/**
 * Places a fish just outside the arena on the far side of its heading so that
 * following that bearing carries it across the play area.
 */
function spawnFish(room:Room,kind:FishKind,tag:Fish['tag']):Fish{
  const spec=fishSpec[kind],heading=pick(CLOCK);
  const dx=Math.cos(heading),dy=Math.sin(heading),offset=(Math.random()-.5)*.9;
  return {
    id:`f${room.nextFishId++}`,kind,
    x:.5-dx*.65-dy*offset,
    y:.5-dy*.65+dx*offset,
    heading,speed:spec.speed*(.85+Math.random()*.3),
    radius:spec.radius,value:fishCatalog[kind],hp:spec.hp,maxHp:spec.hp,
    wanderAmp:.012+Math.random()*.022,wanderFreq:.5+Math.random(),wanderPhase:Math.random()*Math.PI*2,
    born:Date.now(),tag
  };
}

function createRoom():Room{
  const now=Date.now();
  const room:Room={
    id:`ocean-${nextRoomId++}`,status:'waiting',players:new Map(),fish:[],
    lastTick:now,startedAt:0,countdownEndsAt:null,
    segment:0,segmentEndsAt:0,nextFishId:1,ticks:0
  };
  rooms.set(room.id,room);
  return room;
}

/** Prefers a room still gathering players, then a live room with a free seat. */
function findRoom():Room{
  for(const room of rooms.values())if(room.status==='waiting'&&room.players.size<ROOM_CAPACITY)return room;
  for(const room of rooms.values())if(room.status==='playing'&&room.players.size<ROOM_CAPACITY)return room;
  return createRoom();
}

const send=(socket:WebSocket,message:unknown)=>{if(socket.readyState===1)socket.send(JSON.stringify(message))};
const broadcast=(room:Room,message:unknown)=>room.players.forEach(player=>send(player.socket,message));

const lobbyView=(room:Room)=>({
  type:'lobby',roomId:room.id,status:room.status,capacity:ROOM_CAPACITY,needReady:READY_TO_START,
  players:[...room.players.values()].map(p=>({id:p.id,ready:p.ready})),
  readyCount:[...room.players.values()].filter(p=>p.ready).length,
  countdownMs:room.countdownEndsAt?Math.max(0,room.countdownEndsAt-Date.now()):null
});

const stageOf=(room:Room)=>CYCLE[room.segment]!;
const stateView=(room:Room)=>({
  type:'state',roomId:room.id,status:room.status,capacity:ROOM_CAPACITY,
  stage:stageOf(room).name,
  stageMs:Math.max(0,room.segmentEndsAt-Date.now()),
  players:[...room.players.values()].map(p=>({id:p.id})),
  fish:room.fish.map(f=>({id:f.id,kind:f.kind,x:round(f.x),y:round(f.y),heading:round(f.heading),hp:Math.max(0,Math.round(f.hp)),maxHp:f.maxHp,value:f.value,tag:f.tag}))
});

export function joinFishRoom(userId:string,socket:WebSocket){
  const room=findRoom();
  const player:Player={id:`p${room.players.size+1}-${Math.random().toString(36).slice(2,7)}`,userId,socket,ready:false};
  room.players.set(player.id,player);
  send(socket,{...lobbyView(room),type:'joined',playerId:player.id});
  if(room.status==='playing')send(socket,stateView(room));
  broadcast(room,lobbyView(room));

  const leave=()=>{
    room.players.delete(player.id);
    if(!room.players.size){rooms.delete(room.id);return}
    if(room.status==='waiting'&&[...room.players.values()].filter(p=>p.ready).length<READY_TO_START)room.countdownEndsAt=null;
    broadcast(room,lobbyView(room));
  };
  const setReady=(ready:boolean)=>{
    if(room.status!=='waiting')return;
    player.ready=ready;
    if(!ready&&[...room.players.values()].filter(p=>p.ready).length<READY_TO_START)room.countdownEndsAt=null;
    broadcast(room,lobbyView(room));
  };
  return {player,room,leave,setReady};
}

function startGame(room:Room){
  const now=Date.now();
  room.status='playing';room.startedAt=now;room.countdownEndsAt=null;
  room.segment=0;room.segmentEndsAt=now+CYCLE[0].ms;room.lastTick=now;
  room.fish=Array.from({length:CYCLE[0].target},()=>spawnFish(room,pick(COMMON),'common'));
  broadcast(room,{type:'game-start',roomId:room.id});
  broadcast(room,stateView(room));
}

function tickWaiting(room:Room,now:number){
  const readyCount=[...room.players.values()].filter(p=>p.ready).length;
  const everyoneReady=readyCount===room.players.size;
  if(readyCount>=READY_TO_START&&room.countdownEndsAt===null){
    room.countdownEndsAt=now+START_COUNTDOWN_MS;
    broadcast(room,{type:'countdown',ms:START_COUNTDOWN_MS});
  }
  // A full room has nobody left to wait for, so skip the remaining countdown.
  if(room.countdownEndsAt!==null&&(now>=room.countdownEndsAt||(room.players.size>=ROOM_CAPACITY&&everyoneReady)))return startGame(room);
  if(room.ticks%6===0)broadcast(room,lobbyView(room));
}

function advanceStage(room:Room,now:number){
  if(now<room.segmentEndsAt)return;
  room.segment=(room.segment+1)%CYCLE.length;
  const stage=stageOf(room);
  room.segmentEndsAt=now+stage.ms;
  if(stage.name==='school')room.fish=room.fish.filter(f=>f.tag!=='school');
  broadcast(room,{type:'stage',stage:stage.name,ms:stage.ms,warn:'warn'in stage?stage.warn:null});
}

function maintain(room:Room,now:number){
  const stage=stageOf(room);
  room.fish=room.fish.filter(f=>f.x>-.4&&f.x<1.4&&f.y>-.4&&f.y<1.4);
  if('rare'in stage&&stage.rare&&!room.fish.some(f=>f.tag==='rare'))room.fish.push(spawnFish(room,pick(RARE),'rare'));
  const tag:Fish['tag']=stage.name==='school'?'school':'common';
  // Trickle new fish in rather than popping the whole shortfall at once.
  for(let i=0;room.fish.length<stage.target&&i<3;i++)room.fish.push(spawnFish(room,pick(stage.pool),tag));
  void now;
}

function moveFish(room:Room,dt:number,now:number){
  for(const fish of room.fish){
    const drift=Math.sin((now-fish.born)/1000*fish.wanderFreq+fish.wanderPhase)*fish.wanderAmp;
    const dx=Math.cos(fish.heading),dy=Math.sin(fish.heading);
    fish.x+=dt*(dx*fish.speed-dy*drift);
    fish.y+=dt*(dy*fish.speed+dx*drift);
  }
}

export function tickFishRooms(){
  const now=Date.now();
  rooms.forEach(room=>{
    room.ticks++;
    if(room.status==='waiting')return tickWaiting(room,now);
    const dt=Math.min(.1,(now-room.lastTick)/1000);
    room.lastTick=now;
    advanceStage(room,now);
    moveFish(room,dt,now);
    maintain(room,now);
    if(room.players.size)broadcast(room,stateView(room));
  });
}

/**
 * Damage is applied synchronously so two shots landing in the same tick can
 * never both claim the kill; the wallet call happens afterwards and rolls the
 * fish back if it fails.
 */
export async function shootFish(room:Room,userId:string,playerId:string,input:{x:number;y:number;power:number}){
  if(room.status!=='playing')throw new Error('ROOM_NOT_PLAYING');
  // Admin có thể tắt game giữa lúc phòng đang chạy; chặn ngay ở phát bắn tiếp theo.
  const config=(await requireEnabledGame('FISH')).config as GameConfig<'FISH'>;
  const x=Math.max(0,Math.min(1,input.x)),y=Math.max(0,Math.min(1,input.y));
  const target=room.fish
    .map(f=>({fish:f,distance:Math.hypot(f.x-x,f.y-y)}))
    .filter(entry=>entry.distance<=entry.fish.radius)
    .sort((a,b)=>a.distance-b.distance)[0]?.fish;

  let damage=0,killed=false,index=-1;
  if(target){
    damage=fishDamage(input.power,target.kind,target.maxHp,Math.random(),config);
    target.hp-=damage;
    if(target.hp<=0){
      killed=true;
      index=room.fish.indexOf(target);
      if(index>=0)room.fish.splice(index,1);
    }
  }

  const requestId=`ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
  const outcome=fishRoomShot(userId,requestId,input.power,target?.kind||'miss',killed,config);
  let result;
  try{
    result=await play(userId,requestId,outcome);
  }catch(error){
    if(target){
      target.hp+=damage;
      if(killed&&index>=0)room.fish.splice(index,0,target);
    }
    throw error;
  }

  broadcast(room,{type:'shot',playerId,aimX:x,aimY:y,fishId:target?.id||null,fishKind:target?.kind||'miss',damage:Math.round(damage),killed,payout:Number(result.round.payout)});
  const shooter=room.players.get(playerId);
  if(shooter)send(shooter.socket,{type:'wallet',balance:result.balance});
}
