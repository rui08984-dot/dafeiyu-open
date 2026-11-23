// Semantic timing only. Model IDs and physical ranges belong to the renderer.
// speechRate（0..1）由渲染器按口型开合速度平滑算出来：说话越快，头和身体的摆幅越大，
// 避免"匀速说话"像机器人在念稿。
// workState（idle/thinking/busy/done）来自派活状态：思考时眼珠往上看、干活时盯着屏幕方向、
// 交差时把视线收回来看用户。老调用点不传这个参数也能跑（默认 idle）。
const smooth=t=>t*t*(3-2*t);
const curve=(t,points)=>{for(let i=1;i<points.length;i++){const [end,value]=points[i],[start,previous]=points[i-1];if(t<=end)return previous+(value-previous)*smooth(Math.max(0,(t-start)/(end-start)));}return points.at(-1)[1];};
const WORK_STATES=['thinking','busy','done'];
export class InteractionMotion {
  constructor(){this.values={yaw:0,pitch:0,roll:0,body:0,gazeX:0,gazeY:0,blink:0};this.attentionAt=null;}
  start(now){this.attentionAt=now;}
  release(){this.attentionAt=null;}
  sample({now,delta,elapsed,state,head,body,blink,work=false,reducedMotion=false,speechRate=0,workState='idle'}){
    const age=this.attentionAt===null?Infinity:Math.max(0,(now-this.attentionAt)/1000);
    if(age>.9)this.attentionAt=null;
    const tap=age<=.9?curve(age,[[0,0],[.12,-1],[.32,.42],[.7,0],[.9,0]]):0;
    const eye=age<=.4?curve(age,[[0,0],[.09,1],[.16,1],[.35,0],[.4,0]]):0;
    const speaking=state==='speaking',thinking=state==='thinking',listening=state==='listening';
    // 语速 0..1：说话越快，头部/身体摆幅越大，眨眼也跟着密一点
    // speechRate 每帧都抖，先低通再用来调幅，否则头和身体会跟着抽。
    const spRaw=Math.max(0,Math.min(1,Number(speechRate)||0));
    this.__sp=(this.__sp===undefined?spRaw:this.__sp+(spRaw-this.__sp)*(1-Math.exp(-Math.max(0,delta)/0.4)));
    const sp=this.__sp;
    const target={
      yaw:thinking?4+Math.sin(elapsed*.45)*.7:Math.sin(elapsed*.75)*(speaking?5+1.5*sp:2),
      pitch:(thinking?-4:listening?3:Math.sin(elapsed*1.1)*2)+tap*12,
      roll:(thinking?-7+Math.sin(elapsed*.35)*.6:Math.sin(elapsed*.65)*(speaking?3.5+1.2*sp:2))+tap*2,
      body:Math.sin(elapsed*.75)*(speaking?2.2+0.8*sp:1)+tap*1.8,
      gazeX:thinking?.3+Math.sin(elapsed*.4)*.035:0,
      gazeY:thinking?.18:age<.9?.1:0,
      blink:eye
    };
    if(work){
      const cycle=reducedMotion?0:elapsed;
      target.yaw=1.5+Math.sin(cycle*.55)*.7;
      target.pitch=-8+Math.sin(cycle*.8)*.9;
      target.roll=-2.5+Math.sin(cycle*.4)*.4;
      target.body=Math.sin(cycle*.55)*.55;
      target.gazeX=.14+Math.sin(cycle*.4)*.03;
      target.gazeY=-.28;
      target.blink=.16;
    }
    // ── 派活状态：覆盖视线与头部朝向（说话时口型照旧，头仍然跟着工作状态）──
    const ws=WORK_STATES.includes(workState)?workState:'idle';
    if(ws==='thinking'){
      // 思考：眼珠往斜上方、头微微歪着，像在琢磨；不再做无目的的左右晃
      target.yaw=3.2+Math.sin(elapsed*.33)*.8;
      target.pitch=-3.5+Math.sin(elapsed*.41)*.5;
      target.roll=-5.5+Math.sin(elapsed*.27)*.8;
      target.gazeX=-.26; target.gazeY=.3+Math.sin(elapsed*.5)*.02;
      target.body=Math.sin(elapsed*.42)*.7;
    } else if(ws==='busy'){
      // 干活：视线压到屏幕方向（下偏一点），头部小幅度点动，像在看输出
      target.yaw=2.6+Math.sin(elapsed*.5)*.5;
      target.pitch=-2.2+Math.sin(elapsed*.9)*.45;
      target.roll=-1.4+Math.sin(elapsed*.3)*.4;
      target.gazeX=.16+Math.sin(elapsed*.7)*.03;
      target.gazeY=-.3+Math.sin(elapsed*.55)*.04;
      target.body=Math.sin(elapsed*.55)*.6;
    } else if(ws==='done'){
      // 交差：视线收回来看用户，带一点高兴的轻晃
      target.gazeX=0; target.gazeY=.06;
      target.pitch+=1.5;
      target.roll+=Math.sin(elapsed*3.2)*.8;
    }
    for(const key of Object.keys(target)){
      const allowed=key==='body'?body:key==='blink'?blink:head;
      if(!allowed){this.values[key]=0;continue;}
      // 派活状态用更慢的跟随，避免眼神"跳"过去
      const tau=key==='blink'?.035:(age<.9?.055:(ws==='idle'?.22:.32));
      this.values[key]+=(target[key]-this.values[key])*(1-Math.exp(-Math.max(0,delta)/tau));
    }
    return this.values;
  }
}
