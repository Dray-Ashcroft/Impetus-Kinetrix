/* Impetus Kinetrix — Mapping Motion through time — simulation, 3D road view and distance–time graph */
(() => {
 const $ = id => document.getElementById(id);
 const canvas = $('graph'), ctx = canvas.getContext('2d');
 const state = {t:0, x:0, v:0, a:0, running:false, throttle:false, braking:false, points:[{t:0,x:0,v:0}], last:0, marks:[], ended:false, cruise:false, ghost:null, sel:-1};
 const ACCEL = 4.6, BRAKE = 7.0, MAX_SPEED = 38; // m/s² · m/s² · m/s (≈137 km/h); sporty but still a simple classroom model
 const COAST0 = 0.15, COAST1 = 0.03; // pedals released: rolling resistance + air drag slow the car (m/s², and per m/s)
 let dpr=1;

 /* ================= 3D ROAD VIEW (visual layer only — reads state, never changes physics) ================= */
 function createView3D(host){
  if(!window.THREE) return null;
  const T=THREE;
  let renderer;
  try{renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});}catch(e){return null}
  if(!renderer.getContext()) return null;
  const lin=h=>new T.Color(h).convertSRGBToLinear();
  const hash=n=>{const s=Math.sin(n*127.1+311.7)*43758.5453;return s-Math.floor(s)};
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.75));
  renderer.outputEncoding=T.sRGBEncoding;
  renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.0;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  renderer.domElement.className='gl';
  host.prepend(renderer.domElement);
  const ANISO=renderer.capabilities.getMaxAnisotropy();
  const scene=new T.Scene();
  const camera=new T.PerspectiveCamera(52,1,0.1,3000);
  const HORIZON='#cfdde3';
  scene.fog=new T.Fog(new T.Color(HORIZON),80,900);

  // ---------- helpers ----------
  function tex(w,h,draw,{repeat=false,srgb=true}={}){
   const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');draw(g,w,h);
   const t=new T.CanvasTexture(c);if(srgb)t.encoding=T.sRGBEncoding;t.anisotropy=ANISO;
   if(repeat){t.wrapS=t.wrapT=T.RepeatWrapping}return t;
  }
  function speckle(g,w,h,amt,sparks){
   const img=g.getImageData(0,0,w,h),d=img.data;
   for(let i=0;i<d.length;i+=4){const n=(Math.random()-.5)*amt;d[i]+=n;d[i+1]+=n;d[i+2]+=n;
    if(sparks&&Math.random()<sparks){const s=Math.random()<.5?35:-30;d[i]+=s;d[i+1]+=s;d[i+2]+=s}}
   g.putImageData(img,0,0);
  }
  // Smooth normals except across sharp creases (keeps the body panels glossy, edges crisp)
  function creased(g,angle){
   g=g.index?g.toNonIndexed():g;const p=g.attributes.position,n=p.count,fn=new Array(n),groups=new Map();
   const a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3(),ab=new T.Vector3(),ac=new T.Vector3();
   const key=i=>`${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
   for(let i=0;i<n;i+=3){a.fromBufferAttribute(p,i);b.fromBufferAttribute(p,i+1);c.fromBufferAttribute(p,i+2);
    const f=ab.subVectors(b,a).clone().cross(ac.subVectors(c,a)).normalize();
    for(let j=0;j<3;j++){fn[i+j]=f;const k=key(i+j);let arr=groups.get(k);if(!arr){arr=[];groups.set(k,arr)}arr.push(i+j)}}
   const out=new Float32Array(n*3),cosA=Math.cos(angle),acc=new T.Vector3();
   for(let i=0;i<n;i++){acc.set(0,0,0);const f=fn[i];for(const j of groups.get(key(i)))if(fn[j].dot(f)>=cosA)acc.add(fn[j]);
    if(acc.lengthSq()===0)acc.copy(f);acc.normalize();out[i*3]=acc.x;out[i*3+1]=acc.y;out[i*3+2]=acc.z}
   g.setAttribute('normal',new T.BufferAttribute(out,3));return g;
  }
  // Tileable value noise (period in cells) for procedural textures
  const h2=(i,j,sd)=>{let n=Math.imul(i,374761393)+Math.imul(j,668265263)+Math.imul(sd,1442695041);n=Math.imul(n^(n>>>13),1274126177);n^=n>>>16;return (n>>>0)/4294967296};
  function vnoise(x,y,px,py,sd){const xi=Math.floor(x),yi=Math.floor(y);let xf=x-xi,yf=y-yi;xf=xf*xf*(3-2*xf);yf=yf*yf*(3-2*yf);
   const x0=((xi%px)+px)%px,x1=(x0+1)%px,y0=((yi%py)+py)%py,y1=(y0+1)%py;
   const a=h2(x0,y0,sd),b=h2(x1,y0,sd),c=h2(x0,y1,sd),d=h2(x1,y1,sd);
   return a+(b-a)*xf+(c-a)*yf+(a-b-c+d)*xf*yf}
  const glowTex=tex(64,64,(g)=>{const r=g.createRadialGradient(32,32,0,32,32,32);r.addColorStop(0,'rgba(255,255,255,1)');r.addColorStop(.25,'rgba(255,255,255,.55)');r.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=r;g.fillRect(0,0,64,64)},{srgb:false});

  // ---------- sky dome (raw output so its horizon matches the fog colour exactly) ----------
  const SUN_DIR=new T.Vector3(-0.5,0.62,-0.6).normalize();
  const skyMat=new T.ShaderMaterial({side:T.BackSide,depthWrite:false,fog:false,
   uniforms:{zenith:{value:new T.Color('#4a86bd')},horizon:{value:new T.Color(HORIZON)},ground:{value:new T.Color('#b9c6bf')},sunDir:{value:SUN_DIR}},
   vertexShader:'varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
   fragmentShader:`uniform vec3 zenith,horizon,ground,sunDir;varying vec3 vDir;
    float hs(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float ns(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hs(i),hs(i+vec2(1.,0.)),f.x),mix(hs(i+vec2(0.,1.)),hs(i+vec2(1.,1.)),f.x),f.y);}
    float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*ns(p);p*=2.03;a*=.5;}return v;}
    void main(){vec3 d=normalize(vDir);float h=d.y;
     vec3 c=mix(horizon,zenith,pow(clamp(h,0.,1.),.55));
     c=mix(c,ground,smoothstep(0.,-.06,h));
     float s=max(dot(d,sunDir),0.);c+=vec3(1.,.86,.62)*(pow(s,10.)*.18+pow(s,900.)*2.5);
     if(h>0.){vec2 uv=d.xz/(h+.15)*1.4;float n=fbm(uv*1.2+vec2(3.1,7.7));float cl=smoothstep(.55,.82,n)*smoothstep(.02,.3,h);c=mix(c,vec3(.97,.98,1.),cl*.8);}
     gl_FragColor=vec4(c,1.);}`});
  const sky=new T.Mesh(new T.SphereGeometry(1500,40,20),skyMat);sky.renderOrder=-1;scene.add(sky);

  // Environment map for car-paint and glass reflections
  {const pm=new T.PMREMGenerator(renderer);const es=new T.Scene();
   const eg=new T.SphereGeometry(50,32,16),ep=eg.attributes.position,ec=[],zc=new T.Color('#4a86bd'),hc=new T.Color(HORIZON),tc=new T.Color();
   for(let i=0;i<ep.count;i++){const y=ep.getY(i)/50;tc.copy(hc).lerp(zc,Math.pow(Math.max(y,0),.55));ec.push(tc.r,tc.g,tc.b)}
   eg.setAttribute('color',new T.Float32BufferAttribute(ec,3));
   es.add(new T.Mesh(eg,new T.MeshBasicMaterial({vertexColors:true,side:T.BackSide})));
   const gnd=new T.Mesh(new T.CircleGeometry(48,32),new T.MeshBasicMaterial({color:lin('#57574f')}));gnd.rotation.x=-Math.PI/2;gnd.position.y=-1.2;es.add(gnd);
   scene.environment=pm.fromScene(es,0.02).texture;pm.dispose();}

  // ---------- lights ----------
  scene.add(new T.HemisphereLight(lin('#d6e8f5'),lin('#5a6744'),0.7));
  const sun=new T.DirectionalLight(lin('#fff1dc'),2.3);sun.castShadow=true;
  sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-32,right:32,top:32,bottom:-32,near:1,far:200});
  sun.shadow.bias=-0.0004;sun.shadow.normalBias=0.03;scene.add(sun,sun.target);

  // ---------- ground, road, shoulders ----------
  const ROAD_W=7.2,PERIOD=12,ASPH_W=7.6; // texture covers 7.6 m (incl. ragged edges) × 12 m of road
  const PXM=100,AW=ASPH_W*PXM,AH=PERIOD*PXM;
  const asphalt=tex(AW,AH,(g,w,h)=>{
   const img=g.createImageData(w,h),d=img.data;
   const tracks=[2.0-.8,2.0+.8,5.6-.8,5.6+.8]; // wheel tracks in each lane (m from left canvas edge)
   for(let y=0;y<h;y++){const ym=y/PXM;
    const edgeL=.06+.16*vnoise(3,ym*2.5,999,PERIOD*2.5,7),edgeR=ASPH_W-.06-.16*vnoise(9,ym*2.5,999,PERIOD*2.5,8);
    for(let x=0;x<w;x++){const xm=x/PXM,i=(y*w+x)*4;
     const n1=vnoise(x/120,y/120,999,h/120,1),n2=vnoise(x/30,y/30,999,h/30,2),n3=vnoise(x/6,y/6,999,h/6,3);
     let L=70+(n1-.5)*18+(n2-.5)*10+(n3-.5)*16+(Math.random()-.5)*26;
     const r=Math.random();if(r<.014)L+=26+Math.random()*30;else if(r<.026)L-=22;  // aggregate stones / pits
     let tw=0;for(const t of tracks){const dd=(xm-t)/.28;tw+=Math.exp(-dd*dd)}L*=1-.13*Math.min(1,tw);
     let R_=L,G=L,B=L*1.035;
     // painted markings: solid edge lines and a 4 m dash in the centre (worn, ragged)
     const inEdge=(xm>.4&&xm<.55)||(xm>ASPH_W-.55&&xm<ASPH_W-.4),inDash=xm>ASPH_W/2-.06&&xm<ASPH_W/2+.06&&ym<4;
     if(inEdge||inDash){let cov=.93-(n3<.32?.55:0)-(Math.random()*.22)-(n2>.72?.25:0);cov=Math.max(0,Math.min(1,cov));
      R_+=(230-R_)*cov;G+=(228-G)*cov;B+=(218-B)*cov}
     d[i]=R_;d[i+1]=G;d[i+2]=B;
     d[i+3]=(xm<edgeL||xm>edgeR)?0:255;                                   // crumbly road edge
    }}
   g.putImageData(img,0,0);
   const rnd=(a,b)=>a+Math.random()*(b-a),both=(fn)=>{fn(0);fn(-h);fn(h)};
   // repair patches with darker, fresher bitumen and sealed seams
   for(let k=0;k<2;k++){const px=rnd(.6,ASPH_W-2)*PXM,py=rnd(0,h),pw=rnd(.6,1.4)*PXM,ph=rnd(.5,1.6)*PXM;
    both(o=>{g.fillStyle='rgba(30,32,35,.13)';g.fillRect(px,py+o,pw,ph);g.strokeStyle='rgba(20,20,22,.22)';g.lineWidth=2;g.strokeRect(px,py+o,pw,ph)})}
   // cracks (meandering, some sealed with tar)
   for(let k=0;k<18;k++){let x=rnd(.5,ASPH_W-.5)*PXM,y=rnd(0,h),a=rnd(0,Math.PI*2);const pts=[[x,y]];
    for(let j=0;j<rnd(5,16);j++){a+=rnd(-1,1);x+=Math.cos(a)*rnd(2,5);y+=Math.sin(a)*rnd(2,5);pts.push([x,y])}
    const tar=Math.random()<.15;
    both(o=>{g.beginPath();g.moveTo(pts[0][0],pts[0][1]+o);for(const q of pts)g.lineTo(q[0],q[1]+o);
     g.strokeStyle=tar?'rgba(14,14,15,.4)':'rgba(22,22,24,.45)';g.lineWidth=tar?2.5:.9;g.stroke()})}
   // oil drips down the middle of each lane
   for(const lc of [2.0,5.6])for(let k=0;k<7;k++){const cx=(lc+rnd(-.35,.35))*PXM,cy=rnd(0,h),rr=rnd(6,22);
    both(o=>{const gr=g.createRadialGradient(cx,cy+o,0,cx,cy+o,rr);gr.addColorStop(0,'rgba(8,8,10,.30)');gr.addColorStop(1,'rgba(8,8,10,0)');g.fillStyle=gr;g.fillRect(cx-rr,cy+o-rr,rr*2,rr*2)})}
  },{repeat:true});
  asphalt.repeat.set(1,720/PERIOD);
  // roughness: smoother where tyres polish the lanes, a little smoother on paint
  const asphRough=tex(190,300,(g,w,h)=>{g.fillStyle='rgb(232,232,232)';g.fillRect(0,0,w,h);
   for(const t of [1.2,2.8,4.8,6.4]){const x=t/ASPH_W*w,gr=g.createLinearGradient(x-9,0,x+9,0);gr.addColorStop(0,'rgba(170,170,170,0)');gr.addColorStop(.5,'rgba(170,170,170,1)');gr.addColorStop(1,'rgba(170,170,170,0)');g.fillStyle=gr;g.fillRect(x-9,0,18,h)}
   speckle(g,w,h,30,0)},{repeat:true,srgb:false});
  asphRough.repeat.copy(asphalt.repeat);
  const road=new T.Mesh(new T.PlaneGeometry(ASPH_W,720),new T.MeshStandardMaterial({map:asphalt,roughnessMap:asphRough,bumpMap:asphalt,bumpScale:.018,roughness:1,metalness:0,alphaTest:.5}));
  road.rotation.x=-Math.PI/2;road.position.y=.05;road.receiveShadow=true;scene.add(road);

  const gravel=tex(256,256,(g,w,h)=>{g.fillStyle='#8c816c';g.fillRect(0,0,w,h);speckle(g,w,h,40,.05);
   for(let i=0;i<900;i++){const x=Math.random()*w,y=Math.random()*h,r=1+Math.random()*3.2,l=95+Math.random()*90,t=Math.random()*30-10;
    g.fillStyle=`rgba(20,16,10,.35)`;g.beginPath();g.ellipse(x+1,y+1.3,r,r*.75,0,0,7);g.fill();
    g.fillStyle=`rgb(${l+t},${l+t*.6},${l-8})`;g.beginPath();g.ellipse(x,y,r,r*.75,Math.random()*3,0,7);g.fill()}
  },{repeat:true});
  gravel.repeat.set(.75,360);
  const shoulders=[];
  for(const s of [-1,1]){const m=new T.Mesh(new T.PlaneGeometry(1.5,720),new T.MeshStandardMaterial({map:gravel,bumpMap:gravel,bumpScale:.03,roughness:1}));m.rotation.x=-Math.PI/2;m.position.set(s*(ROAD_W/2+.75),.03,0);m.receiveShadow=true;scene.add(m);shoulders.push(m)}

  const grassT=tex(256,256,(g,w,h)=>{g.fillStyle='#62803c';g.fillRect(0,0,w,h);
   for(let i=0;i<1400;i++){g.fillStyle=`hsla(${80+Math.random()*30},${35+Math.random()*25}%,${22+Math.random()*22}%,.55)`;g.fillRect(Math.random()*w,Math.random()*h,1+Math.random()*2,3+Math.random()*7)}
   speckle(g,w,h,22,0)},{repeat:true});
  grassT.repeat.set(1600/6,1600/6);
  const grass=new T.Mesh(new T.PlaneGeometry(1600,1600),new T.MeshStandardMaterial({map:grassT,roughness:1}));
  grass.rotation.x=-Math.PI/2;grass.receiveShadow=true;scene.add(grass);

  // Start line at 0 m
  const checker=tex(256,32,(g)=>{for(let i=0;i<16;i++)for(let j=0;j<2;j++){g.fillStyle=(i+j)%2?'#f2f2ee':'#1b1c1e';g.fillRect(i*16,j*16,16,16)}});
  const start=new T.Mesh(new T.PlaneGeometry(ROAD_W-.8,.9),new T.MeshStandardMaterial({map:checker,roughness:.8}));
  start.rotation.x=-Math.PI/2;start.position.set(0,.06,0);start.receiveShadow=true;scene.add(start);

  // ---------- distance boards every 10 m (left verge) ----------
  const BOARDS=28,boardPool=[];
  const postGeo=new T.CylinderGeometry(.045,.05,1.6,10),postMat=new T.MeshStandardMaterial({color:lin('#e9ecee'),roughness:.5,metalness:.4});
  const boardGeo=new T.BoxGeometry(.9,.46,.04),edgeMat=new T.MeshStandardMaterial({color:lin('#d5d9dc'),metalness:.6,roughness:.35});
  for(let i=0;i<BOARDS;i++){
   const c=document.createElement('canvas');c.width=256;c.height=132;const t=new T.CanvasTexture(c);t.encoding=T.sRGBEncoding;t.anisotropy=ANISO;
   const face=new T.MeshStandardMaterial({map:t,roughness:.45,metalness:.05});
   const grp=new T.Group(),post=new T.Mesh(postGeo,postMat),board=new T.Mesh(boardGeo,[edgeMat,edgeMat,edgeMat,edgeMat,face,edgeMat]);
   post.position.y=.8;board.position.y=1.48;post.castShadow=board.castShadow=true;grp.add(post,board);grp.rotation.y=.5;grp.position.x=-3.45;
   scene.add(grp);boardPool.push({grp,c,t,k:null});
  }
  function drawBoard(b,k){
   const g=b.c.getContext('2d'),m=k*10,major=m%50===0;
   g.fillStyle=major?'#f2c230':'#1d6a45';g.fillRect(0,0,256,132);
   g.strokeStyle=major?'#1b1b1b':'#f4f4f0';g.lineWidth=7;g.strokeRect(8,8,240,116);
   g.fillStyle=major?'#151515':'#ffffff';g.textAlign='center';g.textBaseline='middle';g.font='800 64px IBM Plex Sans,Roboto,sans-serif';
   g.fillText(m+' m',128,70);b.t.needsUpdate=true;
  }

  // ---------- instanced scenery: trees, bushes, roadside posts, fields ----------
  function inst(geo,mat,cap,shadow){const m=new T.InstancedMesh(geo,mat,cap);m.frustumCulled=false;m.castShadow=!!shadow;m.receiveShadow=true;
   const white=new T.Color(1,1,1);for(let i=0;i<cap;i++)m.setColorAt(i,white); // must run while count===cap (r128 sizes the colour buffer from count)
   m.count=0;scene.add(m);return m}
  // merge several non-indexed geometries into one
  function mergeGeos(list){const pos=[],nor=[],uv=[],col=[];let hasCol=false;
   for(const g0 of list){const g=g0.index?g0.toNonIndexed():g0,p=g.attributes.position,n=g.attributes.normal,u=g.attributes.uv,c=g.attributes.color;if(c)hasCol=true;
    for(let i=0;i<p.count;i++){pos.push(p.getX(i),p.getY(i),p.getZ(i));nor.push(n.getX(i),n.getY(i),n.getZ(i));uv.push(u?u.getX(i):0,u?u.getY(i):0);if(c)col.push(c.getX(i),c.getY(i),c.getZ(i));else col.push(1,1,1)}}
   const out=new T.BufferGeometry();out.setAttribute('position',new T.Float32BufferAttribute(pos,3));out.setAttribute('normal',new T.Float32BufferAttribute(nor,3));out.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
   if(hasCol)out.setAttribute('color',new T.Float32BufferAttribute(col,3));return out}
  // canopy = cluster of lumpy leaf-blobs; normals bent outward from the crown centre, darker underneath and inside (ambient occlusion)
  function canopyGeo(blobs,detail,jitter,seed,uvRep){
   const parts=[];let ymin=1e9,ymax=-1e9;
   blobs.forEach((b,bi)=>{const g=new T.IcosahedronGeometry(1,detail),p=g.attributes.position,n=g.attributes.normal,u=g.attributes.uv;
    for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
     const dd=1+(h2(Math.round(x*40)+500,Math.round(y*40)*31+Math.round(z*40)*977+500,seed+bi)-.5)*jitter;
     p.setXYZ(i,b[0]+x*b[3]*dd,b[1]+y*b[3]*b[4]*dd,b[2]+z*b[3]*dd);u.setXY(i,u.getX(i)*uvRep,u.getY(i)*uvRep);ymin=Math.min(ymin,p.getY(i));ymax=Math.max(ymax,p.getY(i))}
    parts.push(g)});
   const g=mergeGeos(parts),p=g.attributes.position,n=g.attributes.normal,col=[],v=new T.Vector3(),c=new T.Vector3();
   let rmax=0;for(let i=0;i<p.count;i++)rmax=Math.max(rmax,Math.hypot(p.getX(i),p.getZ(i)));
   for(let i=0;i<p.count;i++){v.set(p.getX(i),p.getY(i),p.getZ(i));c.set(0,(ymin+ymax)/2,0);const out=v.clone().sub(c).normalize();
    const nn=new T.Vector3(n.getX(i),n.getY(i),n.getZ(i)).multiplyScalar(.45).add(out.multiplyScalar(.55)).normalize();n.setXYZ(i,nn.x,nn.y,nn.z);
    const hy=(v.y-ymin)/(ymax-ymin),rr=Math.hypot(v.x,v.z)/rmax,ao=.42+.4*hy+.25*rr;const a=Math.min(1.08,ao);col.push(a,a,a*.97)}
   g.setAttribute('color',new T.Float32BufferAttribute(col,3));return g}
  // bark textures
  const barkDark=tex(64,256,(g,w,h)=>{g.fillStyle='#4a3a2c';g.fillRect(0,0,w,h);for(let i=0;i<70;i++){const x=Math.random()*w;g.strokeStyle=`rgba(${20+Math.random()*30},${15+Math.random()*20},10,.7)`;g.lineWidth=1+Math.random()*2.5;g.beginPath();g.moveTo(x,0);for(let y=0;y<=h;y+=16)g.lineTo(x+Math.sin(y*.05+i)*3,y);g.stroke()}speckle(g,w,h,30,.02)},{repeat:true});
  const barkPale=tex(64,256,(g,w,h)=>{g.fillStyle='#d9d4c6';g.fillRect(0,0,w,h);
   for(let i=0;i<40;i++){g.fillStyle=['rgba(176,160,132,.75)','rgba(150,150,140,.6)','rgba(205,190,160,.8)','rgba(120,110,95,.45)'][i%4];const x=Math.random()*w,y=Math.random()*h;g.beginPath();g.ellipse(x,y,3+Math.random()*9,8+Math.random()*30,0,0,7);g.fill()}
   speckle(g,w,h,18,0)},{repeat:true});
  const leafTex=(base,cols,gaps)=>tex(256,256,(g,w,h)=>{g.clearRect(0,0,w,h);
   const blob=(x,y,r)=>{for(const ox of [-w,0,w])for(const oy of [-h,0,h]){g.beginPath();g.arc(x+ox,y+oy,r,0,7);g.fill()}};
   g.fillStyle=base;for(let i=0;i<gaps;i++)blob(Math.random()*w,Math.random()*h,6+Math.random()*12);  // leaf clumps; the rest stays see-through
   for(let i=0;i<2600;i++){g.fillStyle=cols[i%cols.length];g.save();g.translate(Math.random()*w,Math.random()*h);g.rotate(Math.random()*7);g.beginPath();g.ellipse(0,0,2.2+Math.random()*2.5,1+Math.random()*1.2,0,0,7);g.fill();g.restore()}
  },{repeat:true});
  const broadLeaf=leafTex('#3d6328',['#4f7a31','#5d8a38','#365a24','#6e9b42','#2f4f20','#7fa64a'],420);
  const eucLeaf=leafTex('#55704a',['#6f8a62','#7d9870','#4b6342','#8ba37a','#5c7552','#a2b48c'],190);
  // geometry: broadleaf (shisham/neem-like) trunk with two limbs, and tall slender eucalyptus
  const bend=(g,amt,f)=>{const p=g.attributes.position;for(let i=0;i<p.count;i++){const y=p.getY(i);p.setX(i,p.getX(i)+Math.sin(y*f)*amt)}g.computeVertexNormals();return g};
  const limb=(r0,r1,len,rz,rx,y)=>new T.CylinderGeometry(r1,r0,len,7).translate(0,len/2,0).rotateZ(rz).rotateX(rx).translate(0,y,0);
  const broadTrunkGeo=mergeGeos([bend(new T.CylinderGeometry(.15,.24,3.0,9,5).translate(0,1.5,0),.06,1.3),limb(.11,.06,1.5,.65,.2,2.3),limb(.1,.05,1.4,-.55,-.3,2.5),limb(.08,.04,1.1,.15,.7,2.7)]);
  const eucTrunkGeo=mergeGeos([bend(new T.CylinderGeometry(.09,.18,8.6,9,8).translate(0,4.3,0),.12,.45),limb(.06,.03,1.6,.5,.1,6.2),limb(.05,.03,1.4,-.6,-.2,6.8)]);
  const broadCanGeo=canopyGeo([[0,0,0,1.55,.78],[1.15,.15,.35,1.15,.8],[-1.05,.1,-.4,1.2,.78],[.25,.55,-1.0,1.05,.82],[-.35,.65,.95,1.05,.8],[.4,-.35,.2,1.1,.6],[-.2,1.0,-.1,1.0,.7]],1,.38,11,2.2);
  const eucCanGeo=canopyGeo([[0,0,0,.95,1.2],[.95,.9,.3,.7,1.25],[-.85,.6,-.4,.72,1.3],[.3,1.9,-.3,.66,1.2],[-.45,-1.0,.45,.6,1.2],[.6,-.6,-.6,.55,1.25],[-.3,2.6,.25,.5,1.1],[1.1,-.2,-.2,.5,1.3],[-1.0,1.6,.3,.55,1.2]],1,.6,23,1.6);
  const bushGeo=canopyGeo([[0,0,0,.8,.7],[.6,-.05,.2,.6,.7],[-.55,-.05,-.15,.62,.7]],1,.4,37,1.5);
  const leafMat=new T.MeshStandardMaterial({map:broadLeaf,roughness:.85,vertexColors:true,alphaTest:.45,side:T.DoubleSide});
  const eucMat=new T.MeshStandardMaterial({map:eucLeaf,roughness:.85,vertexColors:true,alphaTest:.45,side:T.DoubleSide});
  const trunkI=inst(broadTrunkGeo,new T.MeshStandardMaterial({map:barkDark,bumpMap:barkDark,bumpScale:.05,roughness:1}),240,true);
  const eucTrunkI=inst(eucTrunkGeo,new T.MeshStandardMaterial({map:barkPale,bumpMap:barkPale,bumpScale:.03,roughness:.9}),240,true);
  const roundI=inst(broadCanGeo,leafMat,240,true);
  const coneI=inst(eucCanGeo,eucMat,240,true);
  const bushI=inst(bushGeo,leafMat,320,true);
  const delinI=inst(new T.CylinderGeometry(.05,.06,1,8).translate(0,.5,0),new T.MeshStandardMaterial({color:lin('#f4f4f2'),roughness:.4}),60,true);
  const reflI=inst(new T.BoxGeometry(.07,.16,.12).translate(0,.86,0),new T.MeshStandardMaterial({color:lin('#ff8a1e'),emissive:lin('#ff6a00'),emissiveIntensity:.35,roughness:.3}),60,false);
  const studI=inst(new T.BoxGeometry(.1,.025,.12).translate(0,.06,0),new T.MeshStandardMaterial({color:lin('#e8e4d6'),emissive:lin('#ffcf6a'),emissiveIntensity:.25,metalness:.5,roughness:.3}),60,false);
  const furrows=tex(64,256,(g,w,h)=>{g.fillStyle='#ffffff';g.fillRect(0,0,w,h);for(let y=0;y<h;y+=16){g.fillStyle='rgba(0,0,0,.18)';g.fillRect(0,y,w,7)}speckle(g,w,h,30,0)});
  const fieldI=inst(new T.BoxGeometry(1,.06,1),new T.MeshStandardMaterial({map:furrows,roughness:1}),120,false);
  const hillMat=new T.MeshStandardMaterial({color:lin('#6f8a86'),roughness:1,flatShading:true});
  const hills=new T.Group();scene.add(hills);
  for(let i=0;i<22;i++){const ang=(i/22)*Math.PI*2+hash(i)*0.2,dist=640+hash(i+40)*260,hgt=40+hash(i+80)*90;
   const m=new T.Mesh(new T.ConeGeometry(110+hash(i+9)*140,hgt,7),hillMat);m.position.set(Math.cos(ang)*dist,hgt/2-6,Math.sin(ang)*dist);m.rotation.y=hash(i+3)*6;hills.add(m)}

  const M=new T.Matrix4(),Q=new T.Quaternion(),P=new T.Vector3(),S=new T.Vector3(),C=new T.Color(),YA=new T.Vector3(0,1,0);
  const put=(mesh,i,x,y,z,sx,sy,sz,rot,col)=>{Q.setFromAxisAngle(YA,rot);P.set(x,y,z);S.set(sx,sy,sz);M.compose(P,Q,S);mesh.setMatrixAt(i,M);if(col)mesh.setColorAt(i,col)};
  const leafCols=['#ffffff','#e6f0d6','#f3ecc8','#d6e6cf','#c9dcb8'].map(lin),pineCols=['#ffffff','#e9eedd','#dfe6d2'].map(lin),bushCols=['#ffffff','#e2edd0','#f0e8c6'].map(lin);
  const fieldCols=['#c8a54a','#d7c13a','#6f9a3c','#86a845','#9b8455','#b9ae52'].map(lin);
  let lastTreeK=null,lastFieldK=null;
  let lastS=0;
  function updateScenery(s){
   lastS=s;refs.position.z=-Math.floor(s/REF_GAP)*REF_GAP;
   const tk=Math.floor((s-70)/6);
   if(LEGACY_SCENERY&&tk!==lastTreeK){lastTreeK=tk;let nt=0,nr=0,nc=0,nb=0,nd=0,ne=0,ns=0;
    for(let k=tk;k<=tk+66;k++)for(const side of [-1,1]){const sd=k*2+(side>0?1:0);
     if(hash(sd*1.7+.3)>=.42){const r2=hash(sd*3.1+7),r3=hash(sd*5.3+1),r4=hash(sd*9.7+3),sc=.75+r4*.7,x=side*(8+r2*12),z=-(k*6+r3*5);
      if(r4>.58){const es=.85+(r4-.58)*.9,ex=side*(6.6+r2*1.4);           // eucalyptus row close to the road
       put(eucTrunkI,ne++,ex,0,z,es,es,es,r3*6);put(coneI,nc++,ex,7.9*es,z,es,es,es,r2*6,pineCols[Math.floor(r2*3)%3]);}
      else{put(trunkI,nt++,x+side*2.5,0,z,sc,sc,sc,r3*6);put(roundI,nr++,x+side*2.5,3.75*sc,z,sc*(1+r3*.15),sc,sc,r2*6,leafCols[Math.floor(r3*5)%5]);}}
     for(let b=0;b<2;b++){const sb=sd*3.3+b*17.1;if(hash(sb)<.45)continue;const bx=side*(8.4+hash(sb+2)*4),bz=-(k*6+hash(sb+5)*6),bs=.45+hash(sb+8)*.6;
      put(bushI,nb++,bx,bs*.5,bz,bs*1.3,bs,bs*1.2,hash(sb+1)*6,bushCols[Math.floor(hash(sb+3)*3)%3]);}}
    const dk=Math.floor((s-40)/10);
    for(let k=dk;k<=dk+40;k++){const z=-(k*10+5);put(delinI,nd,ROAD_W/2+1.75,0,z,1,1,1,0);put(reflI,nd,ROAD_W/2+1.75,0,z,1,1,1,0);nd++}
    const sk=Math.floor((s-40)/12);for(let k=sk;k<=sk+30;k++)put(studI,ns++,0,0,-12*k+10,1,1,1,0); // sits in the gaps between centre dashes
    trunkI.count=nt;eucTrunkI.count=ne;roundI.count=nr;coneI.count=nc;bushI.count=nb;delinI.count=reflI.count=nd;studI.count=ns;
    for(const m of [trunkI,eucTrunkI,roundI,coneI,bushI,delinI,reflI,studI]){m.instanceMatrix.needsUpdate=true;if(m.instanceColor)m.instanceColor.needsUpdate=true}
   }
   const fk=Math.floor((s-150)/60);
   if(LEGACY_SCENERY&&fk!==lastFieldK){lastFieldK=fk;let nf=0;
    for(let k=fk;k<=fk+15;k++)for(const side of [-1,1])for(let col=0;col<3;col++){const sd=k*7+col*3+(side>0?1:0)*31;
     put(fieldI,nf++,side*(42+col*46),.035,-(k*60+30),42,1,55,0,fieldCols[Math.floor(hash(sd)*6)%6])}
    fieldI.count=nf;fieldI.instanceMatrix.needsUpdate=true;fieldI.instanceColor.needsUpdate=true;
   }
   const base=Math.floor(s/10)-4;
   for(let i=0;i<BOARDS;i++){const k=base+i,b=boardPool[((k%BOARDS)+BOARDS)%BOARDS];
    if(b.k!==k){b.k=k;b.grp.visible=k>=0;if(k>=0){b.grp.position.z=-k*10;drawBoard(b,k)}}}
   const snap=Math.round(-s/PERIOD)*PERIOD;
   road.position.z=snap-250;for(const m of shoulders)m.position.z=snap-250;grass.position.z=snap;water.position.z=snap;
   if(bridge.tiles.length){const k0=Math.floor((s+BRIDGE_START)/bridge.L);
    bridge.tiles.forEach((t,i)=>{t.position.z=BRIDGE_START-(k0-1+i)*bridge.L})}
  }

  // ---------- loading screen: stays up until the car, driver and bridge are in ----------
  const loadEl=document.getElementById('loadscreen'),loadBar=document.getElementById('loadBar'),readySet=new Set();
  const hideLoad=()=>{if(loadEl&&!loadEl.classList.contains('done')){if(loadBar)loadBar.style.width='100%';setTimeout(()=>loadEl.classList.add('done'),250)}};
  function markReady(k){readySet.add(k);if(['car','bridge','wheel','arms'].every(x=>readySet.has(x)))hideLoad()}
  T.DefaultLoadingManager.onProgress=(u,done,total)=>{if(loadBar&&total)loadBar.style.width=Math.max(4,Math.round(done/total*92))+'%'};
  setTimeout(hideLoad,45000);                               // never leave anyone stuck behind it

  // ---------- environment: suspension bridge (GLB "Car_ Animation" scene, cars removed), repeated along the road over open water ----------
  const LEGACY_SCENERY=false;                               // old fields / trees / roadside posts are replaced by the bridge
  for(const o of [road,grass,...shoulders,trunkI,eucTrunkI,roundI,coneI,bushI,delinI,reflI,studI,fieldI])o.visible=false;
  const ENV_S=3.0,LANE_Z=-1.45,BRIDGE_START=60;              // model is ~1/3 scale; centre the left carriageway (env z −0.2…−2.7) on the road
  const bridge={tiles:[],L:0};
  const REF_GAP=6,REF_N=170;                                  // reflectors every 6 m, ~1 km of them, snapped along with the car
  const refGeo=new T.BoxGeometry(.09,.5,.09);                 // short reflector posts
  const refL=new T.InstancedMesh(refGeo,new T.MeshBasicMaterial({color:lin('#ffb020'),toneMapped:false}),REF_N);
  const refR=new T.InstancedMesh(refGeo,new T.MeshBasicMaterial({color:lin('#f2f6ff'),toneMapped:false}),REF_N);
  {const m=new T.Matrix4();for(let i=0;i<REF_N;i++){m.makeTranslation(-3.92,1.0,30-i*REF_GAP);refL.setMatrixAt(i,m);m.makeTranslation(3.95,.45,30-i*REF_GAP);refR.setMatrixAt(i,m)}}
  const refs=new T.Group();refs.add(refL);scene.add(refs);   // amber posts on the left barrier only (the white median posts looked like broken pipes)
  const water=new T.Mesh(new T.PlaneGeometry(4000,4000),new T.MeshStandardMaterial({color:lin('#24566b'),roughness:.18,metalness:.25,envMapIntensity:1.2}));
  water.rotation.x=-Math.PI/2;water.position.y=-29;scene.add(water);
  hills.position.y=-24;
  new T.GLTFLoader().load('assets/models/bridge.glb',g=>{
   const src=g.scene;src.scale.setScalar(ENV_S);
   let deck=null;src.traverse(o=>{if(!o.isMesh)return;o.receiveShadow=true;o.castShadow=false;
    const m=o.material;if(m.map)m.map.anisotropy=ANISO;if(o.name==='deck_surface')deck=o;
    if(m.name==='light_warm'){m.emissive=new T.Color(0xffe2a8);m.emissiveIntensity=.6}});
   src.updateMatrixWorld(true);
   const db=new T.Box3().setFromObject(deck||src);        // deck surface, in the bridge's own frame
   bridge.L=db.max.x-db.min.x;
   src.position.set(-db.min.x,-db.max.y,-LANE_Z*ENV_S);   // deck runs 0…L, road surface at y 0, left carriageway on x 0
   const wrap=new T.Group();wrap.rotation.y=Math.PI/2;wrap.add(src);   // turn: bridge length (+x) runs forwards (−z)
   for(let i=0;i<3;i++){const t=wrap.clone();scene.add(t);bridge.tiles.push(t)}
   updateScenery(lastS);markReady('bridge');
  },undefined,err=>{console.warn('Bridge GLB failed to load',err);markReady('bridge')});

  // ---------- the car: "FREE Concept Car 004" (GLB) — centre driving seat (1+2+1 layout), drives in the left lane ----------
  const car=new T.Group(),chassis=new T.Group();car.add(chassis);scene.add(car);
  const MODEL_DZ=.0855;                                     // GLB is in metres, y-up, ground at 0, nose at +z: turn it round and centre the wheelbase
  const TYRE_R=.384;                                        // tyre radius (m) — the wheels turn exactly with distance travelled
  const spinners=[],glows=[];
  let tailMat={emissiveIntensity:0};                        // replaced by the GLB's rear-lamp material once loaded
  const EYE=new T.Vector3(0,1.02,-.27);                      // driver's eye in car space (centre seat)
  const WHEEL=new T.Vector3(0,.654,-.849),WHEEL_R=.15;      // steering wheel centre / rim radius in car space
  const WHEEL_UP=new T.Vector3(0,.91,-.41).normalize();     // rim plane 'up' (wheel is raked towards the driver)
  car.position.x=-1.8; // left lane

  const gltf=new T.GLTFLoader();
  gltf.load('assets/models/concept_car.glb',g=>{
   const model=g.scene;model.rotation.y=Math.PI;model.position.z=MODEL_DZ;chassis.add(model);
   car.updateMatrixWorld(true);
   const wheelParts={};
   model.traverse(o=>{
    if(!o.isMesh)return;o.castShadow=true;o.receiveShadow=true;
    const m=o.material;
    if(m.name==='Material.008'){o.castShadow=false;o.receiveShadow=false;m.depthWrite=false}   // baked ground shadow
    else if(m.transparent){m.depthWrite=false;o.castShadow=false}
    m.envMapIntensity=m.envMapIntensity||1;if(m.map)m.map.anisotropy=ANISO;
    if(m.name==='taillight_cover')tailMat=m;
    if(m.name==='light001.001')o.visible=false;          // the model's fixed "0" read-out — replaced by the live display below
    if(m.name==='glass'){m.transparent=true;m.opacity=Math.min(m.opacity,.28);m.depthWrite=false;o.castShadow=false}   // lighter tint so the road is clear from the driver's seat
    const w=/^(?:rim_235|tire_001_R17)\.?(00\d)?_/.exec(o.name);if(w){const k=w[1]||'0';(wheelParts[k]=wheelParts[k]||[]).push(o)}   // three.js drops the dots: rim_235.001 → rim_235001
   });
   // rear lamps glow on braking
   if(tailMat.isMaterial){tailMat.emissive=new T.Color(0xff1010);tailMat.emissiveIntensity=.3}
   const back=new T.Box3().setFromObject(model);
   for(const sx of [-.62,.62]){const sp=new T.Sprite(new T.SpriteMaterial({map:glowTex,color:0xff2a1a,blending:T.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));
    sp.position.set(sx,.95,back.max.z+.05);sp.scale.set(1,.6,1);chassis.add(sp);glows.push(sp)}
   // wheels: rim + tyre spin together about the axle (brake calipers stay put)
   for(const k in wheelParts){const parts=wheelParts[k],bb=new T.Box3();for(const p of parts)bb.expandByObject(p);
    const piv=new T.Group();chassis.add(piv);piv.position.copy(chassis.worldToLocal(bb.getCenter(new T.Vector3())));piv.updateMatrixWorld(true);
    for(const p of parts)piv.attach(p);
    spinners.push(piv);
   }
   // the car's own hanging pedals: pivot each at the top of its arm so it can be pressed
   {const parts={L:[],R:[]};model.traverse(o=>{const m=/^pedal_([LR])/.exec(o.name);if(m&&o.isMesh)parts[m[1]].push(o)});
    for(const k of ['L','R']){if(!parts[k].length)continue;const bb=new T.Box3();for(const p of parts[k])bb.expandByObject(p);
     const pv=new T.Group();chassis.add(pv);pv.position.copy(chassis.worldToLocal(new T.Vector3((bb.min.x+bb.max.x)/2,bb.max.y,bb.min.z+.02)));pv.updateMatrixWorld(true);
     const pad=new T.Box3();for(const p of parts[k])if(!/metal/.test(p.material.name))pad.expandByObject(p);
     pv.userData.pad=pv.worldToLocal((pad.isEmpty()?bb:pad).getCenter(new T.Vector3()));
     for(const p of parts[k]){pv.attach(p);p.layers.enable(1)}
     pedalPiv[k==='L'?'brk':'acc']=pv}}
   addWheelAndDriver();markReady('car');
  },undefined,err=>{console.error('Car GLB failed to load (serve the folder over http):',err);document.getElementById('windshield').classList.add('nogl');hideLoad()});

  // ---------- race steering wheel (GLB: Lamborghini Essenza SCV12) on the car's column ----------
  const RW_S=.068;                                          // model units → metres (≈30 cm across)
  const RW_GRIP=new T.Vector3(1.88,-.2,.21),RW_GRIP_R=.235;  // right-hand grip centre / radius in the wheel's own units (left one is mirrored)
  const W_R=new T.Vector3(1,0,0),W_U=WHEEL_UP.clone(),W_N=new T.Vector3().crossVectors(W_R,W_U).normalize();   // wheel axes in car space: right, up, towards the driver
  const steerWheel=new T.Group();
  steerWheel.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(W_R,W_U,W_N));
  steerWheel.position.copy(WHEEL).addScaledVector(W_N,-RW_GRIP.z*RW_S);   // grips sit where the car's own rim was
  chassis.add(steerWheel);
  const gripPoint=sg=>steerWheel.position.clone().addScaledVector(W_R,sg*RW_GRIP.x*RW_S).addScaledVector(W_U,RW_GRIP.y*RW_S).addScaledVector(W_N,RW_GRIP.z*RW_S);
  function addWheelAndDriver(){
   gltf.load('assets/models/race_wheel.glb',g=>{
    const m=g.scene;m.scale.setScalar(RW_S);steerWheel.add(m);
    m.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=true;if(o.material.map)o.material.map.anisotropy=ANISO}});
    markReady('wheel');addDriver();
   },undefined,err=>{console.warn('Steering wheel GLB failed to load',err);markReady('wheel');addDriver()});
  }

  // ---------- driver: Connor's forearms and hands (GLB, skinned), wrapped round the wheel's grips ----------
  const RIG_S=1.15,SHOULDER=new T.Vector3(0,-.17,-.1);       // adult-sized hands; shoulders just below and ahead of the eye
  const PALM_T=.022,TIP_T=.009,THUMB_C=.55;                 // palm half-thickness, fingertip pad, thumb curl
  const HIPS_Y=.38,EYE_DY=-.07,headMeshes=[];               // hip-joint height on the seat; his eyes just under the camera; the head is hidden in Driver view (the camera is his eyes)
  function addDriver(){
   gltf.load('assets/models/connor_body.glb',g=>{
    const rig=g.scene;rig.scale.multiplyScalar(RIG_S);rig.rotation.y=Math.PI;chassis.add(rig);
    rig.traverse(o=>{if(o.isMesh){o.frustumCulled=false;o.castShadow=true;o.receiveShadow=false;
     if(o.isSkinnedMesh){const J=o.geometry.attributes.skinIndex,Wt=o.geometry.attributes.skinWeight,G4=['getX','getY','getZ','getW'];let h=0;   // head parts (face, hair, eyes, teeth…): mostly weighted to the head
      for(let i=0;i<J.count;i++){let bi=0,bw=-1;for(let c=0;c<4;c++){const w=Wt[G4[c]](i);if(w>bw){bw=w;bi=J[G4[c]](i)}}const bn=o.skeleton.bones[bi];if(bn&&/Head|Eye|Neck/.test(bn.name))h++}
      if(h>J.count*.5)headMeshes.push(o)}}});
    car.updateMatrixWorld(true);rig.updateMatrixWorld(true);
    setupLegs(rig);
    const bone=re=>{let r=null;rig.traverse(o=>{if(!r&&o.isBone&&re.test(o.name))r=o});return r};
    const wp=o=>o.getWorldPosition(new T.Vector3()),wq=o=>o.getWorldQuaternion(new T.Quaternion());
    const setW=(b,q)=>{b.quaternion.copy(b.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(q));b.updateMatrixWorld(true)};
    const aim=(b,child,to)=>{const p=wp(b),v1=wp(child).sub(p).normalize(),v2=to.clone().sub(p).normalize();setW(b,wq(b).premultiply(new T.Quaternion().setFromUnitVectors(v1,v2)))};
    // sit him down: lean back from the hips until his eyes sit just under the driver's camera with his hips on the seat (keeps his head under the roof)
    {const hips=bone(/^mixamorigHips_/),head=bone(/^mixamorigHead_/),top=bone(/^mixamorigHeadTop_End_/);
     if(hips&&head&&top){const ax=new T.Vector3(1,0,0).transformDirection(chassis.matrixWorld),q0=hips.quaternion.clone(),w0=wq(hips);
      const eyeAt=()=>{rig.updateMatrixWorld(true);return chassis.worldToLocal(wp(head).lerp(wp(top),.45)).add(new T.Vector3(0,0,-.1*RIG_S))};
      const lean=a=>{hips.quaternion.copy(q0);setW(hips,w0.clone().premultiply(new T.Quaternion().setFromAxisAngle(ax,a)))};
      const want=EYE.y+EYE_DY-HIPS_Y;let best=0,be=1e9;
      for(let a=0;a<=1.1;a+=.01){lean(a);const e=eyeAt().y-chassis.worldToLocal(wp(hips)).y;if(Math.abs(e-want)<be){be=Math.abs(e-want);best=a}}
      lean(best);
      const neck=bone(/^mixamorigNeck_/);for(const [b,k] of [[neck,.45],[head,.45]])if(b){setW(b,wq(b).premultiply(new T.Quaternion().setFromAxisAngle(ax,-best*k)))}   // tip his head forward again so he looks at the road
      const eye=eyeAt();rig.position.add(new T.Vector3(EYE.x-eye.x,EYE.y+EYE_DY-eye.y,EYE.z-.01-eye.z));rig.updateMatrixWorld(true)}}
    const Fd=W_N.clone().negate();                         // fingers reach forwards over the grip…
    for(const side of ['Left','Right']){
     const sg=side==='Left'?-1:1;                          // driver's left is car −x (he faces −z)
     const A=bone(new RegExp('^mixamorig'+side+'Arm_')),B=bone(new RegExp('^mixamorig'+side+'ForeArm_')),H=bone(new RegExp('^mixamorig'+side+'Hand_'));
     const fb=(f,k)=>bone(new RegExp('^mixamorig'+side+'Hand'+f+k+'_'));
     const M1=fb('Middle',1),M4=fb('Middle',4);
     if(!A||!B||!H||!M1||!M4){console.warn('hand bones missing',side);continue}
     const curl=(f,c,w=[.85,1,.8])=>{for(let k=1;k<=3;k++){const b=fb(f,k);if(!b)continue;if(!b.userData.q0)b.userData.q0=b.quaternion.clone();b.quaternion.copy(b.userData.q0);b.rotateX(-sg*c*w[k-1])}rig.updateMatrixWorld(true)};
     const Pd=W_R.clone().multiplyScalar(-sg);              // …with the palm facing the middle of the wheel
     const G=car.localToWorld(gripPoint(sg)),rg=RW_GRIP_R*RW_S;
     const handLen=wp(M1).distanceTo(wp(H));
     const K=G.clone().addScaledVector(W_R,sg*(rg+PALM_T));   // knuckles beside the grip, palm on its outer face
     const target=K.clone().addScaledVector(Fd,-handLen);
     // two-bone IK (law of cosines), elbow pushed down and outwards
     const a=wp(A),l1=a.distanceTo(wp(B)),l2=wp(B).distanceTo(wp(H));
     const d=target.clone().sub(a),dist=Math.min(d.length(),l1+l2-1e-3),dir=d.clone().normalize();
     const x=(l1*l1-l2*l2+dist*dist)/(2*dist),h=Math.sqrt(Math.max(l1*l1-x*x,0));
     const pole=new T.Vector3(sg*.7,-1,.15),pn=pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
     aim(A,B,a.clone().addScaledVector(dir,x).addScaledVector(pn,h));aim(B,H,a.clone().addScaledVector(dir,dist));
     if(d.length()>l1+l2)console.warn('arm short of the grip by',(d.length()-l1-l2).toFixed(3),'m');
     // hand frame now: finger direction, and palm normal (= the way fingertips move as the fingers curl)
     const F=wp(M1).sub(wp(H)).normalize();
     const t0=wp(M4);curl('Middle',.4);const P=wp(M4).sub(t0);curl('Middle',0);P.addScaledVector(F,-P.dot(F)).normalize();
     const q1=new T.Quaternion().setFromUnitVectors(F,Fd),P1=P.clone().applyQuaternion(q1);
     const ang=Math.atan2(Fd.dot(new T.Vector3().crossVectors(P1,Pd)),P1.dot(Pd));
     const q=new T.Quaternion().setFromAxisAngle(Fd,ang).multiply(q1),want=wq(H).premultiply(q);
     // share the wrist roll with the forearm so the skin doesn't candy-wrap at the wrist
     {const ax=wp(H).sub(wp(B)).normalize(),tw=2*Math.atan2(q.x*ax.x+q.y*ax.y+q.z*ax.z,q.w);
      setW(B,wq(B).premultiply(new T.Quaternion().setFromAxisAngle(ax,tw*.55)));}
     setW(H,want);
     // wrap each finger round the grip: curl until the fingertip pad reaches the grip surface
     const axisDist=p=>{const v=p.clone().sub(G);return v.addScaledVector(W_U,-v.dot(W_U)).length()};
     for(const f of ['Index','Middle','Ring','Pinky']){const tip=fb(f,4);if(!tip)continue;
      let best=0,bestE=1e9;
      for(let c=0;c<=2.4;c+=.04){curl(f,c);const e=axisDist(wp(tip))-(rg+TIP_T);if(e<=0){best=c;bestE=0;break}if(Math.abs(e)<bestE){bestE=Math.abs(e);best=c}}
      curl(f,best);}
     curl('Thumb',THUMB_C,[.6,1,.8]);
    }
    rig.updateMatrixWorld(true);syncHead();markReady('arms');
   },undefined,err=>{console.warn('Connor body GLB failed to load',err);markReady('arms')});
  }
  // ---------- traffic props (Traffic mode): checkpoint barrier, traffic light, traffic cars ----------
  const props={light:null,lamps:{red:[],amber:[],green:[]},barrier:null,arm:null,lead:null,others:[]};
  const BAR_S=1.25,HINGE_X=.25,CARS_S=6.5;
  const stopLine=new T.Mesh(new T.PlaneGeometry(3.5,.4),new T.MeshStandardMaterial({color:lin('#f4f4ef'),roughness:.6}));
  stopLine.rotation.x=-Math.PI/2;stopLine.position.set(-1.85,.065,0);stopLine.visible=false;scene.add(stopLine);
  const propLoader=new T.GLTFLoader();
  propLoader.load('assets/models/traffic_light.glb',g=>{
   const m=g.scene;m.scale.setScalar(.5);const grp=new T.Group();grp.add(m);grp.position.x=-3.6;grp.rotation.y=-.15;grp.visible=false;scene.add(grp);
   m.updateMatrixWorld(true);const lamps=[];
   m.traverse(o=>{if(!o.isMesh)return;o.castShadow=true;o.receiveShadow=true;
    if(o.material.name==='light_thing_1'){o.material=o.material.clone();const b=new T.Box3().setFromObject(o);lamps.push({o,c:b.getCenter(new T.Vector3())})}});
   for(const head of [lamps.filter(l=>l.c.z>.5),lamps.filter(l=>l.c.z<=.5)]){
    head.sort((a,b)=>b.c.y-a.c.y);['red','amber','green'].forEach((k,i)=>{if(!head[i])return;const L=head[i];
     const col=new T.Color({red:0xff2a1a,amber:0xffa21a,green:0x2aff6a}[k]);
     const glow=new T.Sprite(new T.SpriteMaterial({map:glowTex,color:col,blending:T.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));
     glow.position.copy(L.c).add(new T.Vector3(0,0,L.c.z>.5?.25:0).add(new T.Vector3(L.c.z>.5?0:-.25,0,0)));glow.scale.setScalar(1.6);m.add(glow);
     props.lamps[k].push({mat:L.o.material,col,glow})})}
   props.light=grp;
  },undefined,err=>console.warn('Traffic light GLB failed to load',err));
  function setLamps(on){for(const k in props.lamps)for(const L of props.lamps[k]){const lit=k===on;
   L.mat.color.setScalar(lit?1:.18);L.mat.emissive=L.col;L.mat.emissiveIntensity=lit?1.6:0;if(L.mat.map)L.mat.emissiveMap=L.mat.map;L.glow.material.opacity=lit?.9:0}}
  propLoader.load('assets/models/barrier.glb',g=>{
   const m=g.scene;m.scale.setScalar(BAR_S);const grp=new T.Group();grp.add(m);grp.rotation.y=Math.PI;grp.position.x=HINGE_X-.9*BAR_S;grp.visible=false;scene.add(grp);
   let pipe=null;m.traverse(o=>{if(/^(stand_001|Shadow)/.test(o.name))o.visible=false;if(o.name==='pipe')pipe=o;if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});
   if(pipe){m.updateMatrixWorld(true);const pv=new T.Group();pv.position.set(-.9,1.0,.35);m.add(pv);pv.updateMatrixWorld(true);pv.attach(pipe);props.arm=pv}
   props.barrier=grp;
  },undefined,err=>console.warn('Barrier GLB failed to load',err));
  propLoader.load('assets/models/traffic_cars.glb',g=>{
   const root=g.scene;root.updateMatrixWorld(true);const made=[];
   root.traverse(o=>{if(/Color_B01/.test(o.name))o.visible=false});
   const cars=[];root.traverse(o=>{if(/^Car_\d$/.test(o.name))cars.push(o)});
   for(const c of cars){const w=new T.Group();w.attach(c);const b=new T.Box3().setFromObject(w),ctr=b.getCenter(new T.Vector3());
    w.position.set(-ctr.x,-b.min.y,-ctr.z);const h=new T.Group();h.add(w);h.scale.setScalar(CARS_S);
    const yaw=new T.Group();yaw.rotation.y=-Math.PI/2;yaw.add(h);const holder=new T.Group();holder.add(yaw);holder.visible=false;
    holder.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});scene.add(holder);made.push(holder)}
   props.lead=made[4]||made[0];props.others=made.filter(x=>x!==props.lead).slice(0,2);
  },undefined,err=>console.warn('Traffic cars GLB failed to load',err));
  function updateTraffic(st,dt){
   const ev=traffic.mode==='traffic'?(traffic.ev||traffic.prev):null;
   const near=t=>!!ev&&ev.type===t&&(ev===traffic.ev||ev.x>st.x-60);   // a passed prop stays in view for a moment
   const onL=near('light'),onB=near('checkpoint'),onC=!!ev&&ev.type==='cars'&&ev===traffic.ev;
   if(props.light){props.light.visible=onL;if(onL){props.light.position.z=-ev.x;setLamps(ev.phase==='stop'?(ev.wait>WAIT-1?'amber':'red'):'green')}}
   if(props.barrier){props.barrier.visible=onB;if(onB){props.barrier.position.z=-ev.x+.35*BAR_S;
    if(props.arm){const want=ev.phase==='go'?1.3:0;props.arm.rotation.z+=(want-props.arm.rotation.z)*Math.min(1,dt*2.2)}}else if(props.arm)props.arm.rotation.z=0}
   stopLine.visible=onL||onB;if(stopLine.visible)stopLine.position.z=-(ev.x-1.5);
   if(props.lead){props.lead.visible=onC;for(const o of props.others)o.visible=onC;
    if(onC){const k=ev.lane*ev.lane*(3-2*ev.lane);props.lead.position.set(-1.8+3.6*k,0,-ev.lead);props.lead.rotation.y=-Math.sin(ev.lane*Math.PI)*.18;
     ev.others.forEach((o,i)=>{const c=props.others[i];if(c)c.position.set(1.8,0,-o.x)})}}
  }

  // ---------- foot-well mini view: the driver's right leg (GLB) working the car's own pedals ----------
  const pedalPiv={acc:null,brk:null},PRESS=.42;
  const footCam=new T.PerspectiveCamera(38,4/3,.02,30);
  const FOOTCAM_POS=new T.Vector3(.28,.85,-.5),FOOTCAM_AT=new T.Vector3(0,.22,-1.36);  // over the right knee: both legs from the seat down to the feet and pedals
  footCam.layers.set(1);                                    // foot cam shows only the pedals, the leg and a plain floor — nothing in the way
  const footLight=new T.PointLight(0xfff2e0,1.6,2.2,2);footLight.position.set(-.1,.75,-1.15);footLight.layers.enable(1);chassis.add(footLight);
  const footFill=new T.HemisphereLight(0xdfeaf2,0x26313a,.9);footFill.layers.set(1);scene.add(footFill);
  // footwell (foot cam only): carpeted floor, sloped toe-board, under-dash and the bracket the pedals hang from
  const carpetTex=tex(256,256,(g,w,h)=>{g.fillStyle='#2a2e32';g.fillRect(0,0,w,h);const im=g.getImageData(0,0,w,h),d=im.data;
    for(let i=0;i<d.length;i+=4){const n=(Math.random()-.5)*26;d[i]+=n;d[i+1]+=n;d[i+2]+=n}g.putImageData(im,0,0)},{repeat:true});
  carpetTex.repeat.set(3,3);
  const carpet=new T.MeshStandardMaterial({map:carpetTex,roughness:1,side:T.DoubleSide});
  const trim=new T.MeshStandardMaterial({color:lin('#202428'),roughness:.7,metalness:.1,side:T.DoubleSide});
  const fw=(geo,mat,x,y,z,rx=0)=>{const m=new T.Mesh(geo,mat);m.position.set(x,y,z);m.rotation.x=rx;m.layers.set(1);m.receiveShadow=true;chassis.add(m);return m};
  fw(new T.PlaneGeometry(.95,1.32),carpet,0,.1,-1.08,-Math.PI/2);                          // floor, from the seat to the toe-board
  const TB=Math.atan2(.34,.12);                                                             // toe-board rises from the floor up behind the pedal tops
  fw(new T.PlaneGeometry(.95,.6),carpet,0,.37,-1.605,TB-Math.PI/2);
  fw(new T.BoxGeometry(.95,.03,.26),trim,0,.6,-1.48);                                        // underside of the dash
  fw(new T.BoxGeometry(.3,.05,.07),trim,0,.465,-1.56);                                      // pedal box: both pedal arms pivot here
  fw(new T.BoxGeometry(.03,.16,.05),trim,-.13,.53,-1.56);fw(new T.BoxGeometry(.03,.16,.05),trim,.13,.53,-1.56);   // its two mounting struts up to the dash
  const wallM=carpet.clone();wallM.side=T.FrontSide;                                       // walls face inwards only, so the camera can look in from outside
  for(const sx of [-1,1])fw(new T.PlaneGeometry(1.32,.5),wallM,sx*.475,.35,-1.08).rotation.y=-sx*Math.PI/2;      // footwell side walls
  const footSeat=new T.Mesh(new T.BoxGeometry(.72,.17,.46),new T.MeshStandardMaterial({color:lin('#1c2024'),roughness:.85}));
  footSeat.position.set(0,.29,-.37);footSeat.layers.set(1);chassis.add(footSeat);   // driver's seat cushion (foot cam only — the car has its own)
  const leg={ready:false,soleH:.1,ballBack:.15,cur:null,press:{acc:0,brk:0}};   // the driver's legs: Connor (same model as the hands), skinned GLB
  const REST_L=new T.Vector3(-.24,.1,-1.4),REST_TOE=new T.Vector3(-.1,0,-1).normalize();   // left foot: flat on the floor, left of the brake
  const UP=new T.Vector3(0,1,0),PAD_N=new T.Vector3(0,.46,.888),PAD_U=new T.Vector3(0,.888,-.46);   // pedal pad: face normal (towards the driver) and 'up the pedal'
  const legRig={R:null,L:null};
  function setupLegs(rig){                                   // called by addDriver() with Connor's whole body, still standing
    const bone=re=>{let r=null;rig.traverse(o=>{if(!r&&o.isBone&&re.test(o.name))r=o});return r};
    const loc=o=>chassis.worldToLocal(o.getWorldPosition(new T.Vector3()));
    const side=s=>({up:bone(new RegExp('^mixamorig'+s+'UpLeg_')),knee:bone(new RegExp('^mixamorig'+s+'Leg_')),foot:bone(new RegExp('^mixamorig'+s+'Foot_')),toe:bone(new RegExp('^mixamorig'+s+'ToeBase_'))});
    const R=side('Right'),Lf=side('Left');
    if(!R.up||!R.knee||!R.foot||!R.toe||!Lf.up||!Lf.foot||!Lf.toe){console.warn('leg bones missing');return}
    const cq=chassis.getWorldQuaternion(new T.Quaternion()).invert();
    for(const B of [R,Lf]){for(const k in B){const b=B[k];if(!b)continue;b.userData.q0=b.quaternion.clone()}
     B.footQ=cq.clone().multiply(B.foot.getWorldQuaternion(new T.Quaternion()));   // foot's standing orientation in car space
     const f=loc(B.toe).sub(loc(B.foot));B.f0=f.clone().setY(0).normalize();
     B.Lt=loc(B.up).distanceTo(loc(B.knee));B.Ls=loc(B.knee).distanceTo(loc(B.foot))}
    leg.soleH=loc(R.foot).y-loc(R.toe).y+.013*RIG_S;                 // ankle height above the sole
    leg.ballBack=loc(R.toe).sub(loc(R.foot)).setY(0).length();          // ankle to ball of the foot, along the sole
    legRig.R=R;legRig.L=Lf;leg.ready=true;
    // a legs-only copy of the skinned body for the foot cam (layer 1), sharing the same skeleton
    const legJ=/(UpLeg|Leg_|Foot|Toe)/,meshes=[];rig.traverse(o=>{if(o.isSkinnedMesh)meshes.push(o)});
    for(const m of meshes){const g=m.geometry,J=g.attributes.skinIndex,Wt=g.attributes.skinWeight,ix=g.index;if(!J||!Wt||!ix)continue;
     const isLeg=new Uint8Array(J.count);
     const G4=['getX','getY','getZ','getW'];   // (interleaved attributes: use the accessors)
     for(let i=0;i<J.count;i++){let bi=0,bw=-1;for(let c=0;c<4;c++){const w=Wt[G4[c]](i);if(w>bw){bw=w;bi=J[G4[c]](i)}}const bn=m.skeleton.bones[bi];isLeg[i]=bn&&legJ.test(bn.name)?1:0}
     const out=[];for(let t=0;t<ix.count;t+=3){const a=ix.getX(t),b=ix.getX(t+1),c=ix.getX(t+2);if(isLeg[a]&&isLeg[b]&&isLeg[c])out.push(a,b,c)}
     if(!out.length)continue;
     const lg=new T.BufferGeometry();for(const k in g.attributes)lg.setAttribute(k,g.attributes[k]);lg.setIndex(out);
     const lm=new T.SkinnedMesh(lg,m.material);lm.frustumCulled=false;lm.castShadow=true;lm.layers.set(1);
     m.parent.add(lm);lm.position.copy(m.position);lm.quaternion.copy(m.quaternion);lm.scale.copy(m.scale);lm.bind(m.skeleton,m.bindMatrix)}
  }
  const _q=new T.Quaternion(),_m1=new T.Matrix4(),_m2=new T.Matrix4(),_c=new T.Vector3();
  function updatePedals(st,dt){
   const want={acc:st.throttle&&!st.braking?1:0,brk:st.braking?1:0};
   for(const k of ['acc','brk']){leg.press[k]+=(want[k]-leg.press[k])*Math.min(1,dt*12);if(pedalPiv[k])pedalPiv[k].rotation.x=leg.press[k]*PRESS}
   if(!leg.ready||!pedalPiv.acc||!pedalPiv.brk)return;
   const on=st.braking?'brk':'acc',pv=pedalPiv[on];
   // ball of the right foot on the pad, sole flat against it, toes pointing up the pedal
   const n=PAD_N.clone().applyQuaternion(pv.quaternion),u=PAD_U.clone().applyQuaternion(pv.quaternion);
   const pad=pv.localToWorld(pv.userData.pad.clone());chassis.worldToLocal(pad);
   const target=pad.addScaledVector(n,leg.soleH).addScaledVector(u,-leg.ballBack);
   if(!leg.cur)leg.cur=target.clone();
   const gap=leg.cur.distanceTo(target);leg.cur.lerp(target,Math.min(1,dt*9));
   const A=leg.cur.clone();A.y+=Math.min(1,gap/.12)*.05;                     // lift the foot while it moves across
   poseLeg(legRig.R,A,.3,n,u);
   poseLeg(legRig.L,REST_L.clone().addScaledVector(UP,leg.soleH).addScaledVector(REST_TOE,-leg.ballBack),-.3,UP,REST_TOE);
  }
  function poseLeg(B,A,poleX,soleN,toeDir){                  // two-bone IK in car space: hip → knee → ankle (knee up, slightly outwards), then the foot laid on its surface
   for(const k of ['up','knee','foot'])B[k].quaternion.copy(B[k].userData.q0);
   B.up.parent.updateMatrixWorld(true);B.up.updateMatrixWorld(true);
   const W=v=>chassis.localToWorld(v.clone()),Lc=o=>chassis.worldToLocal(o.getWorldPosition(new T.Vector3()));
   const setW=(b,q)=>{b.quaternion.copy(b.parent.getWorldQuaternion(_q).invert().multiply(q));b.updateMatrixWorld(true)};
   const aim=(b,child,to)=>{const p=b.getWorldPosition(new T.Vector3()),v1=child.getWorldPosition(new T.Vector3()).sub(p).normalize(),v2=W(to).sub(p).normalize();
    setW(b,b.getWorldQuaternion(new T.Quaternion()).premultiply(new T.Quaternion().setFromUnitVectors(v1,v2)))};
   const hip=Lc(B.up),d=A.clone().sub(hip),dist=Math.min(d.length(),B.Lt+B.Ls-1e-3),dir=d.clone().normalize();
   const x=(B.Lt*B.Lt-B.Ls*B.Ls+dist*dist)/(2*dist),h=Math.sqrt(Math.max(0,B.Lt*B.Lt-x*x));
   const pole=new T.Vector3(poleX,1,0),pn=pole.addScaledVector(dir,-pole.dot(dir)).normalize();
   aim(B.up,B.knee,hip.clone().addScaledVector(dir,x).addScaledVector(pn,h));
   aim(B.knee,B.foot,hip.clone().addScaledVector(dir,dist));
   // foot: rest frame (toes forward, sole down) → toes along the surface, sole onto it
   const a1=B.f0,b1=UP,a2=toeDir.clone().normalize(),b2=soleN.clone().addScaledVector(a2,-soleN.dot(a2)).normalize();
   _m1.makeBasis(a1,b1,_c.crossVectors(a1,b1));_m2.makeBasis(a2,b2,new T.Vector3().crossVectors(a2,b2));
   const qL=new T.Quaternion().setFromRotationMatrix(_m2.multiply(_m1.transpose())).multiply(B.footQ);
   setW(B.foot,chassis.getWorldQuaternion(new T.Quaternion()).multiply(qL));
  }
  // ---------- rear-view mirror: glass-mounted on a polished swivel arm, live view back at the driver (Driver view only) ----------
  const MOUNT=new T.Vector3(0,1.079,-.43),GLASS_N=new T.Vector3(0,1,-.197).normalize();   // on the inside of the canopy glass, just ahead of the driver
  const MS=.6;                                                                 // overall mirror scale
  const BALL=MOUNT.clone().addScaledVector(GLASS_N,-.026*MS);                     // swivel ball under the stem
  const MIRROR_POS=BALL.clone().add(new T.Vector3(0,-.006,.014).multiplyScalar(MS));              // centre of the mirror glass
  const MW=.084,MH=.026;                                                        // mirror glass size (m)
  const mirrorRT=new T.WebGLRenderTarget(512,164);mirrorRT.texture.encoding=T.sRGBEncoding;
  const mirrorCam=new T.PerspectiveCamera(26,MW/MH,.1,400);
  const mirror=new T.Group();chassis.add(mirror);
  {const chrome=new T.MeshStandardMaterial({color:lin('#dfe3e8'),metalness:1,roughness:.12,envMapIntensity:1.4});
   const piano=new T.MeshStandardMaterial({color:lin('#0b0d10'),metalness:.35,roughness:.2,envMapIntensity:1.2});
   const add=(geo,mat,parent)=>{const m=new T.Mesh(geo,mat);parent.add(m);return m};
   // fixed part: pad on the glass, stem, swivel ball
   const base=new T.Group();base.position.copy(MOUNT);base.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),GLASS_N);base.scale.setScalar(MS);mirror.add(base);
   add(new T.CylinderGeometry(.016,.019,.006,32),piano,base).position.y=-.003;
   add(new T.CylinderGeometry(.0042,.0056,.022,20),chrome,base).position.y=-.015;
   {const ball=add(new T.SphereGeometry(.0085,24,16),chrome,mirror);ball.position.copy(BALL);ball.scale.setScalar(MS)}
   // swivelling head: turned on the ball to face the driver's eyes
   const head=new T.Group();head.position.copy(MIRROR_POS);head.scale.setScalar(MS);mirror.add(head);
   head.quaternion.setFromRotationMatrix(new T.Matrix4().lookAt(EYE,MIRROR_POS,new T.Vector3(0,1,0)));
   const rr=(w,h,r)=>{const p=new T.Shape(),x=-w/2,y=-h/2;p.moveTo(x+r,y);p.lineTo(x+w-r,y);p.quadraticCurveTo(x+w,y,x+w,y+r);p.lineTo(x+w,y+h-r);p.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
     p.lineTo(x+r,y+h);p.quadraticCurveTo(x,y+h,x,y+h-r);p.lineTo(x,y+r);p.quadraticCurveTo(x,y,x+r,y);return p};
   const shell=new T.ExtrudeGeometry(rr(MW+.012,MH+.012,.014),{depth:.012,bevelEnabled:true,bevelThickness:.004,bevelSize:.003,bevelSegments:4,curveSegments:10});
   add(shell,piano,head).position.z=-.017;                                     // rounded piano-black housing
   const rim=new T.ExtrudeGeometry(rr(MW+.004,MH+.004,.011),{depth:.002,bevelEnabled:false,curveSegments:10});
   add(rim,chrome,head).position.z=-.001;                                      // thin chrome bezel
   add(new T.CylinderGeometry(.0035,.0035,.016,16),chrome,head).position.set(0,.004,-.02);   // neck from the ball into the housing
   const map=mirrorRT.texture;map.repeat.x=-1;map.offset.x=1;                 // mirror image: flip left–right
   add(new T.PlaneGeometry(MW,MH),new T.MeshBasicMaterial({map,toneMapped:false}),head).position.z=.0015}
  let mirrorTick=0;
  function renderMirror(){
   if(mode!=='cockpit'||(mirrorTick++&1))return;                            // only in Driver view, every other frame
   const virt=MIRROR_POS.clone().multiplyScalar(2).sub(EYE);                 // the driver's eye reflected behind the mirror
   mirrorCam.near=MIRROR_POS.distanceTo(EYE);mirrorCam.updateProjectionMatrix();
   mirrorCam.position.copy(chassis.localToWorld(virt));mirrorCam.lookAt(chassis.localToWorld(EYE.clone().add(new T.Vector3(0,-.03,.06))));
   for(const o of headMeshes)o.visible=true;mirror.visible=false;
   const au=renderer.shadowMap.autoUpdate;renderer.shadowMap.autoUpdate=false;
   renderer.setRenderTarget(mirrorRT);renderer.render(scene,mirrorCam);renderer.setRenderTarget(null);
   renderer.shadowMap.autoUpdate=au;mirror.visible=true;syncHead();
  }
  const pcEl=document.getElementById('pedalcam'),plAcc=document.getElementById('plAcc'),plBrk=document.getElementById('plBrk');
  function renderPedalCam(st){
   if(!pcEl||pcEl.classList.contains('min'))return;
   const cr=renderer.domElement.getBoundingClientRect(),r=pcEl.getBoundingClientRect();if(!r.width||!cr.height)return;
   const x=r.left-cr.left+1,y=cr.bottom-r.bottom+1,w=r.width-2,h=r.height-2;
   footCam.position.copy(chassis.localToWorld(FOOTCAM_POS.clone()));footCam.lookAt(chassis.localToWorld(FOOTCAM_AT.clone()));
   footCam.aspect=w/h;footCam.updateProjectionMatrix();
   renderer.setScissorTest(true);renderer.setScissor(x,y,w,h);renderer.setViewport(x,y,w,h);
   const au=renderer.shadowMap.autoUpdate,fog=scene.fog;renderer.shadowMap.autoUpdate=false;scene.fog=null;renderer.setClearColor(0x0d1418,1);renderer.clear();renderer.render(scene,footCam);renderer.shadowMap.autoUpdate=au;scene.fog=fog;
   renderer.setScissorTest(false);renderer.setViewport(0,0,cr.width,cr.height);
   for(const [k,el] of [['acc',plAcc],['brk',plBrk]]){const pv=pedalPiv[k];if(!pv||!el)continue;
    const p=pv.localToWorld(pv.userData.pad.clone()).project(footCam);el.style.left=((p.x+1)/2*100).toFixed(1)+'%';el.style.top=((1-p.y)/2*100).toFixed(1)+'%';
    el.classList.toggle('on',k==='acc'?st.throttle&&!st.braking:st.braking)}
  }

  // ---------- live dash display: speed (km/h) and odometer (m), drawn where the car's green read-out sits ----------
  const dispC=document.createElement('canvas');dispC.width=2048;dispC.height=572;   // matches the screen's 3.6 : 1 shape, drawn at high resolution
  const dispT=new T.CanvasTexture(dispC);dispT.encoding=T.sRGBEncoding;dispT.anisotropy=ANISO;
  // the read-out sits in a digital speedometer cluster (GLB) where the car's own green display was
  const SPD_S=1.75,cluster=new T.Group();cluster.rotation.x=-.346;cluster.scale.setScalar(SPD_S);   // leans back ~20° to face the driver
  cluster.position.set(0,.735,-1.15).sub(new T.Vector3(0,.015,.03).multiplyScalar(SPD_S).applyEuler(cluster.rotation));chassis.add(cluster);
  const disp=new T.Mesh(new T.PlaneGeometry(.236,.066),new T.MeshBasicMaterial({map:dispT,toneMapped:false}));
  disp.position.set(0,.015,.033);cluster.add(disp);
  new T.GLTFLoader().load('assets/models/speedometer.glb',g=>{const m=g.scene;cluster.add(m);
   m.traverse(o=>{if(o.isMesh&&o.material.name==='Material')o.visible=false})},undefined,err=>console.warn('Speedometer GLB failed to load',err));
  // LED read-out: speed on a green seven-segment panel, odometer on a separate blue one
  const SEGS={'0':'abcdef','1':'bc','2':'abdeg','3':'abcdg','4':'bcfg','5':'acdfg','6':'acdefg','7':'abc','8':'abcdefg','9':'abcdfg','-':'g',' ':''};
  function seg7(g,x,y,w,h,ch,on,off,glow){                // one upright LED digit in the cell x,y,w,h
   const t=w*.16,r=t/2,gp=t*.28,l=x+r,rr=x+w-r,top=y+r,mid=y+h/2,bot=y+h-r;
   const bar=(x1,y1,x2,y2)=>{const hz=y1===y2,X=hz?x1:x1-r,Y=hz?y1-r:y1,W=hz?x2-x1:t,H=hz?t:y2-y1;
    g.beginPath();g.moveTo(X+r,Y);g.lineTo(X+W-r,Y);g.arc(X+W-r,Y+r,r,-Math.PI/2,0);g.lineTo(X+W,Y+H-r);g.arc(X+W-r,Y+H-r,r,0,Math.PI/2);g.lineTo(X+r,Y+H);g.arc(X+r,Y+H-r,r,Math.PI/2,Math.PI);g.lineTo(X,Y+r);g.arc(X+r,Y+r,r,Math.PI,Math.PI*1.5);g.closePath();g.fill()};
   const P={a:[l+gp,top,rr-gp,top],b:[rr,top+gp,rr,mid-gp],c:[rr,mid+gp,rr,bot-gp],d:[l+gp,bot,rr-gp,bot],e:[l,mid+gp,l,bot-gp],f:[l,top+gp,l,mid-gp],g:[l+gp,mid,rr-gp,mid]};
   const lit=SEGS[ch]||'';
   for(const k in P){const isOn=lit.includes(k);if(!isOn&&off==='rgba(0,0,0,0)')continue;g.fillStyle=isOn?on:off;g.shadowColor=glow;g.shadowBlur=isOn?w*.18:0;bar(...P[k])}g.shadowBlur=0}
  function panel(g,x,y,w,h,edge,bg){g.fillStyle=bg;g.strokeStyle=edge;g.lineWidth=8;const r=26;g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();g.fill();g.stroke()}
  function ledNumber(g,str,cx,cy,ch,cw,gap,on,glow){         // draw only the lit digits of str, centred on cx; '.' becomes a small dot
   const dotW=cw*.34,w=[...str].reduce((s,c)=>s+(c==='.'?dotW:cw+gap),0)-gap;let x=cx-w/2;
   for(const c of str){if(c==='.'){g.fillStyle=on;g.shadowColor=glow;g.shadowBlur=cw*.18;g.beginPath();g.arc(x+dotW*.45,cy+ch-cw*.09,cw*.085,0,7);g.fill();g.shadowBlur=0;x+=dotW;continue}
    seg7(g,x,cy,cw,ch,c,on,'rgba(0,0,0,0)',glow);x+=cw+gap}}
  function drawDisplay(kmh,dist){
   const g=dispC.getContext('2d'),W=dispC.width,H=dispC.height,f='Arial,Helvetica,sans-serif';
   g.fillStyle='#000';g.fillRect(0,0,W,H);
   const top=70,ph=H-top-28,ch=ph*.6,cy=top+(ph-ch)/2;          // panel box; digit height and top
   g.textBaseline='alphabetic';
   // speed — green, whole km/h
   const GX=24,GW=760;panel(g,GX,top,GW,ph,'#2a7a34','#020a03');
   g.font='700 50px '+f;g.fillStyle='#7dff86';g.textAlign='left';g.fillText('SPEED',GX+8,52);
   ledNumber(g,String(Math.min(999,Math.round(kmh))),GX+(GW-150)/2+20,cy,ch,ch*.5,ch*.16,'#5dff6c','#2dff4a');
   g.font='700 56px '+f;g.textAlign='right';g.fillText('km/h',GX+GW-28,cy+ch);
   // odometer — blue, metres with one decimal (whole metres past 10 km)
   const BX=GX+GW+60,BW=W-BX-24;panel(g,BX,top,BW,ph,'#2457a8','#02060e');
   g.font='700 50px '+f;g.fillStyle='#7cc4ff';g.textAlign='left';g.fillText('ODOMETER',BX+8,52);
   const od=dist<10000?(Math.floor(dist*10)/10).toFixed(1):String(Math.min(999999,Math.floor(dist)));
   ledNumber(g,od,BX+(BW-110)/2+10,cy,ch,ch*.5,ch*.16,'#4fb4ff','#3a9dff');
   g.font='700 56px '+f;g.fillStyle='#7cc4ff';g.textAlign='right';g.fillText('m',BX+BW-28,cy+ch);
   dispT.needsUpdate=true}
  drawDisplay(0,0);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>drawDisplay(lastKmh,lastDist));
  let dispTimer=0,lastKmh=0,lastDist=0;
  // ---------- frame loop ----------
  let mode='chase',lastX=0,spin=0,pitch=0,pitchVel=0,time=0,camOffZ=6.4,fov=52;
  function resize(){const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()}
  new ResizeObserver(resize).observe(host);resize();
  const look=new T.Vector3();
  function frame(dt,st){
   time+=dt;
   const dx=st.x-lastX;lastX=st.x;
   if(dx<0||dx>100)spin=0;else spin-=dx/TYRE_R;            // wheel turns exactly with distance travelled
   for(const s of spinners)s.rotation.x=spin;
   car.position.z=-st.x;
   const target=Math.max(-.03,Math.min(.02,st.a*.0045)); // nose lifts on acceleration, dips on braking
   pitchVel+=((target-pitch)*70-pitchVel*12)*dt;pitch+=pitchVel*dt;chassis.rotation.x=pitch;
   const rough=Math.min(1,st.v/12);chassis.position.y=(Math.sin(time*31)*.0012+Math.sin(time*17.3)*.0015)*rough;
   const braking=st.braking;tailMat.emissiveIntensity=braking?3.2:.3;for(const g of glows)g.material.opacity=braking?.85:0;
   dispTimer-=dt;{const k=Math.round(st.v*3.6),d=Math.round(st.x*10)/10;if(dispTimer<=0&&(k!==lastKmh||d!==lastDist)){lastKmh=k;lastDist=d;drawDisplay(k,d);dispTimer=.08}}
   updateScenery(st.x);updateTraffic(st,dt);updatePedals(st,dt);
   const cz=car.position.z,cx=car.position.x;
   hills.position.z=cz;sky.position.copy(camera.position);
   sun.position.set(cx+SUN_DIR.x*90,SUN_DIR.y*90,cz+SUN_DIR.z*90);sun.target.position.set(cx,0,cz-8);
   let wantFov;
   if(mode==='chase'){
    camOffZ+=((6.2+st.v*.06)-camOffZ)*Math.min(1,dt*3);
    camera.position.set(cx+1.0,2.3,cz+camOffZ);look.set(cx-.25,.85,cz-6);wantFov=50+st.v*.32;camera.near=.1;
   }else{
    car.updateMatrixWorld(true);camera.position.copy(chassis.localToWorld(EYE.clone()));          // the head rides with the car body, so the road buzz moves cabin, mirror and eyes together (no jitter)
    look.set(cx+EYE.x,EYE.y-1.45+pitch*4,cz-12);wantFov=64;camera.near=.03;
    if(lookYaw||lookPitch){const sp=new T.Spherical().setFromVector3(look.clone().sub(camera.position));   // free look: turn the head
     sp.theta+=lookYaw;sp.phi=Math.min(Math.PI-.08,Math.max(.08,sp.phi+lookPitch));look.copy(camera.position).add(new T.Vector3().setFromSpherical(sp))}
   }
   fov+=(wantFov-fov)*Math.min(1,dt*4);camera.fov=fov;camera.updateProjectionMatrix();camera.lookAt(look);
   renderMirror();
   renderer.render(scene,camera);
   renderPedalCam(st);
  }
  function setMode(m){mode=m;fov=m==='chase'?50:62;resetLook();host.classList.toggle('freelook',m==='cockpit');syncHead()}
  function syncHead(){for(const o of headMeshes)o.visible=mode!=='cockpit'}
  // ---------- Driver view: drag to look around (all directions); double-tap or the ⟲ button to face forward again ----------
  const YAW_MAX=1.75;                                        // head turns about 100° each way, like a real driver (no looking through the back of his head)
  let lookYaw=0,lookPitch=0,drag=null;const cv=renderer.domElement,recBtn=document.getElementById('recenter');
  function resetLook(){lookYaw=0;lookPitch=0;if(recBtn)recBtn.hidden=true}
  cv.addEventListener('pointerdown',e=>{if(mode!=='cockpit')return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,yaw:lookYaw,pitch:lookPitch};try{cv.setPointerCapture(e.pointerId)}catch(_){}});
  cv.addEventListener('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;const k=2.4/Math.max(200,cv.clientWidth);
   lookYaw=Math.max(-YAW_MAX,Math.min(YAW_MAX,drag.yaw+(e.clientX-drag.x)*k));lookPitch=Math.max(-1.25,Math.min(1.25,drag.pitch+(e.clientY-drag.y)*k));
   if(recBtn)recBtn.hidden=Math.abs(lookYaw)<.03&&Math.abs(lookPitch)<.03});
  const endDrag=e=>{if(drag&&e.pointerId===drag.id)drag=null};cv.addEventListener('pointerup',endDrag);cv.addEventListener('pointercancel',endDrag);
  cv.addEventListener('dblclick',()=>{if(mode==='cockpit')resetLook()});
  if(recBtn)recBtn.addEventListener('click',resetLook);
  updateScenery(0);
  return {frame,setMode,get mode(){return mode}};
 }

 /* ================= ROAD MODES — Infinity (open road) and Traffic (checkpoint → traffic light → slow cars, 10 s apart, repeating) =================
    Traffic changes the motion itself: when something is ahead, an auto-brake keeps the car able to stop (or keep its gap) in time,
    so the distance–time graph shows real slowing down, waiting and speeding up again. */
 const COOLDOWN=10,ASSIST=3.0,STOP_GAP=4,WAIT=3,FOLLOW_GAP=10,FOLLOW_T=12;   // s · m/s² · m · s · m · s
 const EVENTS=['checkpoint','light','cars'],EV_NAME={checkpoint:'checkpoint',light:'traffic light',cars:'slow traffic'};
 const traffic={mode:'infinity',cool:COOLDOWN,next:0,ev:null,prev:null,msg:'',assist:false};
 function trafficReset(){traffic.cool=COOLDOWN;traffic.next=0;traffic.ev=null;traffic.prev=null;traffic.msg='';traffic.assist=false}
 function setRoadMode(m){traffic.mode=m;trafficReset();
  document.querySelectorAll('.modesel button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===m)));updateUI()}
 function spawnEvent(){
  const type=EVENTS[traffic.next%EVENTS.length];traffic.next++;
  const ahead=Math.max(70,state.v*state.v/(2*ASSIST)+45);
  const ev={type,x:state.x+ahead,phase:'stop',t:0,wait:0,goT:0};
  if(type==='cars'){ev.phase='follow';ev.lead=state.x+ahead;ev.leadV=Math.max(3.5,Math.min(8,state.v*.45));ev.lane=0;
   ev.others=[{x:state.x+ahead*.55,v:Math.max(10,state.v*.8)},{x:state.x-25,v:Math.max(14,state.v*1.25)}]}   // cars in the other lane
  traffic.ev=ev;
 }
 function eventDone(){traffic.prev=traffic.ev;traffic.ev=null;traffic.cool=COOLDOWN}
 // the highest speed the car may have now and still stop (or keep its gap) in time — Infinity when the road is clear
 function trafficLimit(){
  const ev=traffic.ev;if(traffic.mode!=='traffic'||!ev)return Infinity;
  if(ev.type!=='cars'){if(ev.phase!=='stop')return Infinity;const d=ev.x-STOP_GAP-state.x;return d<=0?0:Math.sqrt(2*ASSIST*d)}
  if(ev.lane>.5)return Infinity;
  const d=ev.lead-FOLLOW_GAP-state.x;return d<=0?Math.max(0,ev.leadV*(1+d/FOLLOW_GAP)):Math.sqrt(ev.leadV*ev.leadV+2*ASSIST*d);
 }
 function trafficStep(dt){
  if(traffic.mode!=='traffic'){traffic.msg='';traffic.ev=null;return}
  const ev=traffic.ev;
  if(!ev){traffic.cool-=dt;traffic.msg='Next: '+EV_NAME[EVENTS[traffic.next%EVENTS.length]]+' in '+Math.max(1,Math.ceil(traffic.cool))+' s';if(traffic.cool<=0)spawnEvent();return}
  ev.t+=dt;
  if(ev.type==='cars'){
   for(const o of ev.others)o.x+=o.v*dt;
   if(ev.phase==='follow'){ev.lead+=ev.leadV*dt;const close=ev.lead-state.x<FOLLOW_GAP+15;
    if(close)ev.followT=(ev.followT||0)+dt;
    traffic.msg='Slow car ahead · '+Math.round(ev.leadV*3.6)+' km/h'+(close?' · following':'');
    if((ev.followT||0)>FOLLOW_T||ev.t>FOLLOW_T+25)ev.phase='pass'}
   else{ev.lane=Math.min(1,ev.lane+dt/2.5);ev.leadV=Math.min(45,ev.leadV+4*dt);ev.lead+=ev.leadV*dt;ev.passT=(ev.passT||0)+dt;
    traffic.msg='Road clear — go';if(ev.lane>=1&&(ev.lead-state.x>70||ev.passT>6))eventDone()}
   return}
  const stopAt=ev.x-STOP_GAP,name=ev.type==='light'?'Red light':'Checkpoint';
  if(ev.phase==='stop'){
   if(state.v<.05&&stopAt-state.x<14){ev.wait+=dt;traffic.msg=name+' · wait '+Math.max(1,Math.ceil(WAIT-ev.wait))+' s';if(ev.wait>=WAIT)ev.phase='go'}
   else traffic.msg=name+' ahead — stop · '+Math.max(0,stopAt-state.x).toFixed(0)+' m';
  }else{ev.goT+=dt;traffic.msg=ev.type==='light'?'Green — go':'Barrier up — go';if(state.x>ev.x+8)eventDone()}
 }
 const view3d=createView3D($('windshield'));
 if(!view3d){$('windshield').classList.add('nogl');$('loadscreen').classList.add('done')}
 const CAMS=['chase','cockpit'];
 function setCam(m){if(!view3d)return;view3d.setMode(m);document.querySelectorAll('.camsel button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cam===m)))}
 document.querySelectorAll('.camsel button').forEach(b=>b.addEventListener('click',()=>setCam(b.dataset.cam)));
 document.querySelectorAll('.modesel button').forEach(b=>b.addEventListener('click',()=>setRoadMode(b.dataset.mode)));
 {const pc=$('pedalcam'),btn=$('pcBtn');if(pc&&btn){let mn=false;try{mn=localStorage.getItem('kx-footcam-min')==='1'}catch(_){}
  const set=v=>{pc.classList.toggle('min',v);btn.setAttribute('aria-label',v?'Show foot camera':'Hide foot camera');try{localStorage.setItem('kx-footcam-min',v?'1':'0')}catch(_){}};
  set(mn);btn.addEventListener('click',()=>set(!pc.classList.contains('min')))}}

 function resizeCanvas(){
  const r=canvas.getBoundingClientRect(); dpr=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.max(1,Math.round(r.width*dpr));canvas.height=Math.max(1,Math.round(r.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0); drawGraph();
 }
 // Points the student has fixed on the graph: Start, P1, P2 … and End (after "End journey")
 function nodes(){const n=[{t:0,x:0,name:'Start'}];state.marks.forEach((mk,i)=>n.push({t:mk.t,x:mk.x,name:'P'+(i+1)}));
  if(state.ended){const l=n[n.length-1];if(state.t-l.t>.05)n.push({t:state.t,x:state.x,name:'End'});else{l.name+=' / End';l.t=state.t;l.x=state.x}}return n} // End merged with a mark still runs to the true end
 // Is a stretch of the trip uniform? Look at the recorded speeds inside it.
 function motionKind(t0,t1,dx){if(dx<.05)return['At rest','r'];let lo=1e9,hi=-1e9;
  const P=state.points;let a=0,b=P.length;while(a<b){const m=(a+b)>>1;if(P[m].t<t0-1e-6)a=m+1;else b=m}   // points are in time order: jump straight to t0
  for(let i=a;i<P.length&&P[i].t<=t1+1e-6;i++){lo=Math.min(lo,P[i].v);hi=Math.max(hi,P[i].v)}
  return hi-lo<.35?['Uniform','u']:['Non-uniform','n']}
 function segments(){const n=nodes(),out=[];for(let i=1;i<n.length;i++){const a=n[i-1],b=n[i],dt=b.t-a.t,dx=b.x-a.x;if(dt<.05)continue;
  out.push({a,b,dt,dx,v:dx/dt,kind:motionKind(a.t,b.t,dx)})}return out}
 let gmap=null;
 function drawGraph(){
  const w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#0e1923';ctx.fillRect(0,0,w,h);
  const m={l:48,r:15,t:17,b:37},pw=w-m.l-m.r,ph=h-m.t-m.b;
  const gT=state.ghost?state.ghost.t:0,gX=state.ghost?state.ghost.x:0;
  const tMax=Math.max(30,Math.ceil(Math.max(state.t,gT,1)/10)*10),xMax=Math.max(100,Math.ceil(Math.max(state.x,gX,1)/50)*50);
  $('graphRange').textContent=`0–${tMax} s · 0–${xMax} m`;
  const X=t=>m.l+(t/tMax)*pw,Y=x=>m.t+ph-(x/xMax)*ph;
  ctx.lineWidth=1;
  for(let i=0;i<=10;i++){
   const gx=m.l+pw*i/10,gy=m.t+ph*i/10;
   ctx.strokeStyle=i%2===0?'#294050':'#1a2a37';ctx.beginPath();ctx.moveTo(gx,m.t);ctx.lineTo(gx,m.t+ph);ctx.stroke();
   ctx.beginPath();ctx.moveTo(m.l,gy);ctx.lineTo(m.l+pw,gy);ctx.stroke();
  }
  ctx.fillStyle='#9aafbf';ctx.font='11px IBM Plex Sans,Roboto,sans-serif';ctx.textAlign='center';ctx.textBaseline='top';
  for(let i=0;i<=5;i++)ctx.fillText((tMax*i/5).toFixed(0),X(tMax*i/5),m.t+ph+8);
  ctx.textAlign='right';ctx.textBaseline='middle';
  for(let i=0;i<=5;i++)ctx.fillText((xMax*i/5).toFixed(0),m.l-8,Y(xMax*i/5));
  ctx.fillStyle='#b4c7d4';ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillText('Time (s)',m.l+pw/2,h-5);
  ctx.save();ctx.translate(13,m.t+ph/2);ctx.rotate(-Math.PI/2);ctx.fillText('Distance (m)',0,0);ctx.restore();
  const trace=(pts,style,width,dash)=>{if(pts.length<2)return;ctx.save();if(dash)ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(X(pts[0].t),Y(pts[0].x));
   for(let i=1;i<pts.length;i++)ctx.lineTo(X(pts[i].t),Y(pts[i].x));ctx.strokeStyle=style;ctx.lineWidth=width;ctx.lineJoin='round';ctx.stroke();ctx.restore()};
  if(state.ghost)trace(state.ghost.points,'#7d8f9c99',2,[6,5]);          // previous trip, for comparison
  trace(state.points,'#54d6e8',2.5);
  const segs=segments(),label=(txt,x,y,fg,bg,font)=>{ctx.font=font;const tw=ctx.measureText(txt).width;let lx=Math.min(Math.max(x-tw/2,m.l+2),m.l+pw-tw-6);
   ctx.fillStyle=bg;ctx.fillRect(lx-4,y-14,tw+8,19);ctx.fillStyle=fg;ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillText(txt,lx,y)};
  if(state.ended&&state.t>0&&segs.length>1){ // whole-trip average: start → end
   ctx.save();ctx.setLineDash([7,6]);ctx.strokeStyle='#c9e27a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(X(0),Y(0));ctx.lineTo(X(state.t),Y(state.x));ctx.stroke();ctx.restore();
   label(`average ${(state.x/state.t).toFixed(1)} m/s`,X(state.t*.62)+44,Y(state.x*.62)+20,'#c9e27a','#0e1923d9','600 12px IBM Plex Sans,Roboto,sans-serif');
  }
  // straight dashed "chord" between consecutive points: its slope is the average speed over that stretch
  segs.forEach((sg,i)=>{const sel=i===state.sel,x1=X(sg.a.t),y1=Y(sg.a.x),x2=X(sg.b.t),y2=Y(sg.b.x);
   ctx.save();ctx.setLineDash(sel?[]:[5,5]);ctx.strokeStyle=sel?'#ffffff':'#ffbd69cc';ctx.lineWidth=sel?3:1.6;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.restore();
   if(!sel&&Math.hypot(x2-x1,y2-y1)>46)label(`${sg.v.toFixed(1)} m/s`,(x1+x2)/2+18,(y1+y2)/2+4,'#ffd9a3','#0e1923d0','600 11px IBM Plex Sans,Roboto,sans-serif')});
  state.marks.forEach((mk,i)=>{ // marked points with guide lines to both axes
   const mx=X(mk.t),my=Y(mk.x);
   ctx.save();ctx.setLineDash([3,4]);ctx.strokeStyle='#ffbd6966';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(mx,my);ctx.lineTo(mx,m.t+ph);ctx.moveTo(mx,my);ctx.lineTo(m.l,my);ctx.stroke();ctx.restore();
   ctx.beginPath();ctx.arc(mx,my,6,0,Math.PI*2);ctx.fillStyle='#ffbd69';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#0e1923';ctx.stroke();
   const lbl=`P${i+1} (${mk.t.toFixed(1)} s, ${mk.x.toFixed(1)} m)`;ctx.font='600 11px IBM Plex Sans,Roboto,sans-serif';const tw=ctx.measureText(lbl).width;
   let lx=mx-tw-14,ly=my-9;if(lx<m.l+4)lx=mx+9;if(ly-14<m.t)ly=my+22;
   ctx.fillStyle='#0e1923e6';ctx.fillRect(lx-3,ly-13,tw+8,17);ctx.fillStyle='#ffd9a3';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillText(lbl,lx+1,ly);
  });
  const sg=segs[state.sel];
  if(sg){const x1=X(sg.a.t),y1=Y(sg.a.x),x2=X(sg.b.t),y2=Y(sg.b.x),cx=(x1+x2)/2,cy=(y1+y2)/2;
   for(const [px,py] of [[x1,y1],[x2,y2]]){ctx.beginPath();ctx.arc(px,py,8,0,7);ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke()}
   const l1=`${sg.a.name} → ${sg.b.name}`,l2=`${sg.dx.toFixed(1)} m ÷ ${sg.dt.toFixed(1)} s = ${sg.v.toFixed(2)} m/s`,l3=`= ${(sg.v*3.6).toFixed(1)} km/h · ${sg.kind[0]}`;
   ctx.font='700 13px IBM Plex Sans,Roboto,sans-serif';const bw=Math.max(ctx.measureText(l2).width,ctx.measureText(l3).width)+22,bh=62;
   let bx=Math.min(Math.max(cx+14,m.l+4),m.l+pw-bw-4),by=Math.min(Math.max(cy-bh-12,m.t+4),m.t+ph-bh-4);
   ctx.fillStyle='#0b141bf2';ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;ctx.beginPath();ctx.rect(bx,by,bw,bh);ctx.fill();ctx.stroke();
   ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillStyle='#ffbd69';ctx.font='700 12px IBM Plex Sans,Roboto,sans-serif';ctx.fillText(l1,bx+11,by+18);
   ctx.fillStyle='#ffffff';ctx.font='700 13px IBM Plex Sans,Roboto,sans-serif';ctx.fillText(l2,bx+11,by+37);ctx.fillStyle='#b9cad5';ctx.font='600 12px IBM Plex Sans,Roboto,sans-serif';ctx.fillText(l3,bx+11,by+54)}
  const px=X(state.t),py=Y(state.x);
  ctx.beginPath();ctx.arc(px,py,7,0,Math.PI*2);ctx.fillStyle='#54d6e8';ctx.fill();
  ctx.beginPath();ctx.arc(px,py,12,0,Math.PI*2);ctx.strokeStyle='#54d6e844';ctx.lineWidth=2;ctx.stroke();
  gmap={X,Y,segs};
 }
 // Tap near a dashed segment to select it
 canvas.addEventListener('click',e=>{if(!gmap)return;const r=canvas.getBoundingClientRect(),qx=e.clientX-r.left,qy=e.clientY-r.top;let best=-1,bd=16;
  gmap.segs.forEach((sg,i)=>{const x1=gmap.X(sg.a.t),y1=gmap.Y(sg.a.x),x2=gmap.X(sg.b.t),y2=gmap.Y(sg.b.x),dx=x2-x1,dy=y2-y1,L=dx*dx+dy*dy||1;
   const u=Math.max(0,Math.min(1,((qx-x1)*dx+(qy-y1)*dy)/L)),d=Math.hypot(qx-(x1+u*dx),qy-(y1+u*dy));if(d<bd){bd=d;best=i}});
  state.sel=best===state.sel?-1:best;
  const sg=gmap.segs[state.sel];$('markToast').textContent=sg?`${sg.a.name} → ${sg.b.name}: ${sg.v.toFixed(2)} m/s`:'';drawGraph()});
 function motionText(){if(state.v<.05&&Math.abs(state.a)<.05)return'At rest';if(state.a>.05)return'Speeding up';if(state.a<-.05)return'Slowing down';return'Steady speed'}
 function renderTable(){const n=nodes();if(!state.ended&&state.t>0)n.push({t:state.t,x:state.x,name:'Now'});
  let html='<table><tr><th>Point</th><th>Time (s)</th><th>Distance (m)</th><th>Speed since last (m/s)</th></tr>';
  n.forEach((p,i)=>{const q=n[i-1],v=q&&p.t-q.t>.05?((p.x-q.x)/(p.t-q.t)).toFixed(2):'—';html+=`<tr><td>${p.name}</td><td>${p.t.toFixed(1)}</td><td>${p.x.toFixed(1)}</td><td>${v}</td></tr>`});
  $('ptable').innerHTML=html+'</table>'}
 let lastTableT=-1,graphKey='',graphAt=0;
 function updateUI(){
  const kmh=state.v*3.6;
  $('time').textContent=state.t.toFixed(1);$('motion').textContent=motionText();$('speedMs').textContent=state.v.toFixed(2);
  $('speedConv').textContent=`× 18/5 = ${kmh.toFixed(1)} km/h`;
  const pp=state.running?'Ⅱ|Pause':state.t>0?'▶|Resume':'▶|Start';if($('playPause').dataset.s!==pp){$('playPause').dataset.s=pp;const [ic,lb]=pp.split('|');$('playPause').innerHTML=`<span class="ic">${ic}</span><span class="lb">${lb}</span>`}
  $('status').textContent=state.running?'● SIMULATION RUNNING':state.v>0?'● CAR MOVING':'● READY TO DRIVE';
  $('sceneLabel').textContent=state.v>0.1?'MOVING · '+kmh.toFixed(0)+' KM/H'+(state.cruise?' · CRUISE':''):'CAR STATIONARY';
  {const tm=$('trafficMsg'),txt=traffic.mode==='traffic'?(traffic.msg||'Traffic mode')+(traffic.assist?' · AUTO-BRAKE':''):'';
   if(tm.textContent!==txt){tm.textContent=txt;tm.hidden=!txt;tm.classList.toggle('alert',/stop|wait|slow|auto/i.test(txt));tm.classList.toggle('go',/go\b|clear/i.test(txt))}}
  $('windshield').classList.toggle('driving',state.running&&state.v>0.5);
  $('endJourney').disabled=state.t<=0;$('undo').disabled=!state.marks.length;
  $('cruise').setAttribute('aria-pressed',String(state.cruise));$('cruiseState').textContent=state.cruise?'Cruise on':'Cruise off';
  if($('ptable').classList.contains('open')&&Math.abs(state.t-lastTableT)>.09){lastTableT=state.t;renderTable()}
  // redraw the graph only when something on it changed, and at most ~20 times a second while driving
  const gk=[state.t.toFixed(2),state.x.toFixed(2),state.marks.length,state.sel,state.ended,!!state.ghost,canvas.width,canvas.height].join('|'),now=performance.now();
  if(gk!==graphKey&&(now-graphAt>48||!state.running)){graphKey=gk;graphAt=now;drawGraph()}
 }
 function physicsStep(dt){
   let a;
   if(state.braking){a=-BRAKE;state.cruise=false}             // braking cancels cruise, as in a real car
   else if(state.throttle)a=ACCEL;
   else if(state.cruise)a=0;                                   // cruise: engine just balances friction
   else a=-(COAST0+COAST1*state.v);                            // pedals released: friction slows the car
   const vCap=trafficLimit();traffic.assist=false;
   if(vCap<Infinity){                                          // auto-brake: follow the 'can still stop in time' curve
    const aCap=(Math.sqrt(Math.max(0,vCap*vCap-2*ASSIST*state.v*dt))-state.v)/dt;
    if(aCap<a){a=Math.max(-BRAKE,aCap);traffic.assist=a<-.05;state.cruise=false}}
   const oldV=state.v;
   state.v=Math.max(0,Math.min(MAX_SPEED,state.v+a*dt));
   state.a=(state.v-oldV)/dt;                                  // actual change of speed (0 when stopped or at top speed)
   state.x+=(oldV+state.v)*.5*dt;                              // distance from average speed over the step
   state.t+=dt;
   trafficStep(dt);
   const last=state.points[state.points.length-1];
   if(state.t-last.t>=.08||state.points.length===1)state.points.push({t:state.t,x:state.x,v:state.v});
   if(state.points.length>25000)state.points.shift();
 }
 function tick(now){
  if(!state.last)state.last=now;
  const dt=Math.min((now-state.last)/1000,.05);state.last=now;
  if(state.running&&dt>0)physicsStep(dt);else state.a=0;
  updateUI();
  if(view3d)view3d.frame(dt,state);
  requestAnimationFrame(tick);
 }
 function setPedal(which,pressed){
  if(which==='throttle'){state.throttle=pressed;$('accelerator').classList.toggle('active',pressed)}
  else{state.braking=pressed;$('brake').classList.toggle('active',pressed)}
  if(pressed){state.ended=false;state.sel=-1;closeCard()}
  if(pressed&&!state.running){state.running=true;state.last=performance.now()}
 }
 function bindPedal(id,which){
  const el=$(id);
  el.addEventListener('pointerdown',e=>{e.preventDefault();try{el.setPointerCapture(e.pointerId)}catch(_){}setPedal(which,true)});
  const release=()=>setPedal(which,false);
  ['pointerup','pointercancel','lostpointercapture','pointerleave'].forEach(ev=>el.addEventListener(ev,release));
  el.addEventListener('contextmenu',e=>e.preventDefault());
 }
 bindPedal('accelerator','throttle');bindPedal('brake','brake');
 function toggleCruise(){state.cruise=!state.cruise;updateUI()}
 $('cruise').addEventListener('click',toggleCruise);
 $('playPause').addEventListener('click',()=>{state.running=!state.running;state.last=performance.now();updateUI()});
 $('reset').addEventListener('click',()=>{
  if(state.t>1)state.ghost={points:state.points.slice(),t:state.t,x:state.x};   // keep this trip faintly for comparison
  $('ghostLegend').hidden=!state.ghost;
  state.t=0;state.x=0;state.v=0;state.a=0;state.running=false;state.throttle=false;state.braking=false;state.cruise=false;
  state.points=[{t:0,x:0,v:0}];state.marks=[];state.ended=false;state.sel=-1;closeCard();$('markToast').textContent='';trafficReset();
  $('accelerator').classList.remove('active');$('brake').classList.remove('active');state.last=performance.now();renderTable();updateUI()});
 function markPoint(){
  const lastMk=state.marks[state.marks.length-1];
  if(state.t<=0){$('markToast').textContent='Start driving first';return}
  if(lastMk&&Math.abs(lastMk.t-state.t)<.05){$('markToast').textContent='Point already marked here';return}
  state.marks.push({t:state.t,x:state.x});state.sel=-1;
  const n=nodes(),a=n[n.length-2],b=n[n.length-1],v=(b.x-a.x)/Math.max(b.t-a.t,1e-9);
  $('markToast').textContent=`P${state.marks.length} · ${state.t.toFixed(1)} s, ${state.x.toFixed(1)} m · ${a.name}→${b.name}: ${v.toFixed(2)} m/s`;renderTable();drawGraph()}
 $('mark').addEventListener('click',markPoint);
 function undoMark(){if(!state.marks.length)return;state.marks.pop();state.sel=-1;$('markToast').textContent='Last point removed';renderTable();updateUI()}
 $('undo').addEventListener('click',undoMark);
 $('tableBtn').addEventListener('click',()=>{const o=$('ptable').classList.toggle('open');$('tableBtn').setAttribute('aria-pressed',String(o));renderTable()});
 function toggleFS(){const d=document;if(!d.fullscreenElement){(d.documentElement.requestFullscreen||d.documentElement.webkitRequestFullscreen||(()=>{})).call(d.documentElement)}else{(d.exitFullscreen||d.webkitExitFullscreen).call(d)}}
 $('fullscreen').addEventListener('click',toggleFS);
 document.addEventListener('fullscreenchange',()=>{$('fullscreen').innerHTML=document.fullscreenElement?'⤡<span class="fslb"> Exit full screen</span>':'⛶<span class="fslb"> Full screen</span>'});
 function closeCard(){$('endModal').classList.remove('open')}
 function endJourney(){
  if(state.t<=0)return;
  setPedal('throttle',false);setPedal('brake',false);state.running=false;state.ended=true;state.cruise=false;state.sel=-1;
  const avg=state.x/state.t;
  $('tripDist').textContent=state.x.toFixed(1);$('tripTime').textContent=state.t.toFixed(1);
  $('tripAvg').textContent=avg.toFixed(2);$('tripKmh').textContent=`× 18/5 = ${(avg*3.6).toFixed(1)} km/h`;
  $('tripFormula').textContent=`Average speed = total distance ÷ total time = ${state.x.toFixed(1)} m ÷ ${state.t.toFixed(1)} s = ${avg.toFixed(2)} m/s`;
  const segs=segments();
  let rows='<tr><th>Part of trip</th><th>Distance</th><th>Time</th><th>Speed</th><th>Motion</th></tr>';
  segs.forEach(sg=>{rows+=`<tr><td>${sg.a.name} → ${sg.b.name}</td><td>${sg.dx.toFixed(1)} m</td><td>${sg.dt.toFixed(1)} s</td><td>${sg.v.toFixed(2)} m/s</td><td><span class="tag ${sg.kind[1]}">${sg.kind[0]}</span></td></tr>`});
  const sx=segs.reduce((a,b)=>a+b.dx,0),st=segs.reduce((a,b)=>a+b.dt,0);
  rows+=`<tr class="total"><td>Whole trip</td><td>${sx.toFixed(1)} m</td><td>${st.toFixed(1)} s</td><td>${(sx/st).toFixed(2)} m/s</td><td></td></tr>`;
  $('segTable').innerHTML=rows;
  const simple=segs.reduce((a,b)=>a+b.v,0)/Math.max(1,segs.length);
  $('segBlock').hidden=segs.length<2;
  if(segs.length>=2){
   const same=Math.abs(simple-avg)<.05;
   const bar='<div class="tbar">'+segs.map(x=>{const pct=x.dt/st*100;return `<div class="${x.kind[1]}" style="flex:${x.dt} 0 0" title="${x.a.name}→${x.b.name}: ${x.dt.toFixed(1)} s">${pct>12?x.a.name+'→'+x.b.name:''}</div>`}).join('')+'</div><div class="tcap">Share of the trip\'s time spent in each part (wider = longer)</div>';
   // the part to point at: a stopped part if it was short, otherwise the shortest part
   const fair=st/segs.length,rest=segs.filter(x=>x.kind[1]==='r'&&x.dt<fair).sort((a,b)=>a.dt-b.dt)[0],short=rest||segs.reduce((a,b)=>b.dt<a.dt?b:a);
   const frac={2:'half',3:'third',4:'quarter',5:'fifth',6:'sixth',7:'seventh',8:'eighth',9:'ninth',10:'tenth'}[segs.length]||`1/${segs.length}`;
   const who=rest?`It was stopped for only ${short.dt.toFixed(1)} s`:`${short.a.name} → ${short.b.name} lasted only ${short.dt.toFixed(1)} s`;
   $('whyBox').innerHTML=same
    ?`<b>Can we just average the speeds?</b> Here it gives nearly the same answer (${simple.toFixed(2)} m/s) — just luck. The parts took different times, so this shortcut can't be trusted.<br>✅ Always use: <b>total distance ÷ total time = ${avg.toFixed(2)} m/s</b>${bar}`
    :`<b>Can we just average the speeds? ❌ No.</b><br>(${segs.map(x=>x.v.toFixed(2)).join(' + ')}) ÷ ${segs.length} = <s>${simple.toFixed(2)} m/s</s> — wrong!<br>The car did not spend equal time in each part. ${who}, but this method counts it as one full ${frac} of the trip.<br>✅ Always use: <b>total distance ÷ total time = ${avg.toFixed(2)} m/s</b>${bar}`;
  }
  renderTable();updateUI();$('endModal').classList.add('open');document.querySelector('#endModal .card').scrollTop=0;$('closeCard').focus({preventScroll:true});
 }
 $('endJourney').addEventListener('click',endJourney);
 $('closeCard').addEventListener('click',closeCard);
 $('newJourney').addEventListener('click',()=>{$('reset').click()});
 $('endModal').addEventListener('click',e=>{if(e.target===$('endModal'))closeCard()});
 window.addEventListener('keydown',e=>{
  if(e.key==='Escape'){closeCard();return}
  if($('endModal').classList.contains('open'))return;
  if(['ArrowUp','ArrowDown',' '].includes(e.key))e.preventDefault();
  if(e.key==='ArrowUp')setPedal('throttle',true);
  if(e.key==='ArrowDown')setPedal('brake',true);
  if(e.key===' '&&!e.repeat){state.running=!state.running;state.last=performance.now();updateUI()}
  if(e.repeat)return;
  const k=e.key.toLowerCase();
  if(k==='c'&&view3d)setCam(CAMS[(CAMS.indexOf(view3d.mode)+1)%CAMS.length]);
  if(k==='k')toggleCruise();if(k==='m')markPoint();if(k==='u')undoMark();if(k==='f')toggleFS();
 });
 window.addEventListener('keyup',e=>{if(e.key==='ArrowUp')setPedal('throttle',false);if(e.key==='ArrowDown')setPedal('brake',false)});
 window.addEventListener('blur',()=>{setPedal('throttle',false);setPedal('brake',false)});
 // Initial render; resize observer keeps graph crisp on phones and desktops.
 new ResizeObserver(resizeCanvas).observe(canvas);resizeCanvas();updateUI();requestAnimationFrame(tick);
})();
