const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/CncSimulatorView-Chzi1-gb.js","assets/index-BX6n2h8i.js","assets/index-CHOb72TH.css","assets/gcode-TnQvcj79.js","assets/three.module-D3cTN3gA.js","assets/OrbitControls-A0wq3yLp.js","assets/RoomEnvironment-K1BKH4jN.js","assets/LatheSim3D-C6H8bG-Z.js","assets/square-BaJAb3eA.js","assets/rotate-ccw-CKlE6tZ2.js","assets/chevron-right-Su-E2Ipf.js"])))=>i.map(i=>d[i]);
import{r,j as e,_ as d}from"./index-BX6n2h8i.js";const S={name:"SIM Lathe",travelX:[-5,300],travelZ:[-200,200],maxRpm:4e3,rapidRate:2e4,indexTime:.5,home:{x:200,z:150},chuckDiameter:200,turretStations:8},o=t=>({shape:null,insertSize:null,noseRadius:null,tipDirection:null,holder:null,leadAngle:null,spindle:"M04",roleSource:"demo data",tipSource:"demo data",...t}),M=[o({number:1,name:"OD ROUGH CNMG 120408",role:"od",shape:"C",insertSize:12,noseRadius:.8,tipDirection:3,holder:"PCLNR 2525M12",leadAngle:95}),o({number:2,name:"OD FINISH VBMT 160404",role:"od",shape:"V",insertSize:16,noseRadius:.4,tipDirection:3,holder:"SVJBR 2525M16",leadAngle:93}),o({number:3,name:"DRILL 16",role:"drill",drillDiameter:16,tipDirection:0,holder:"U-DRILL 16 / BORING SLEEVE 25"}),o({number:4,name:"BORE CCMT 060204",role:"bore",shape:"C",insertSize:6,noseRadius:.4,tipDirection:2,holder:"S10K-SCLCR06",leadAngle:95,barDiameter:10,minBore:13}),o({number:5,name:"GROOVE 3MM",role:"groove",width:3,refEdge:"left",tipDirection:8,holder:"MGEHR 2525-3"}),o({number:6,name:"THREAD 16ER 1.5ISO",role:"thread",threadAngle:60,tipDirection:8,holder:"SER 2525M16"}),o({number:7,name:"PART OFF 3MM",role:"part",width:3,refEdge:"left",tipDirection:8,holder:"SPB 26-3 BLADE"})],R={diameter:50,length:300,stickOut:75,faceZ:1},N={length:45,od:[{dia:30,z_front:0,z_back:-18,corner:2},{dia:44,z_front:-18,z_back:-45,corner:1}],bores:[{dia:20,z_front:0,z_back:-25,corner:2}],drill:{dia:16,depth:45},grooves:[{dia:27,z_front:-15,z_back:-18}],threads:[{major:30,pitch:1.5,z_front:0,z_back:-14}]},c=`%
O9100(SIM LATHE DEMO - NOT FOR MACHINE USE)
(MATERIAL EN8 BAR D50 PART L45)
N1(FACE AND ROUGH OD)
G28U0W0
G50S3000
G96S180M4
T0101
G0X54.0Z0.0M8
G1X-1.6F0.15
G0X52.0Z2.0
G71U2.0R0.5
G71P10Q20U0.4W0.1F0.25
N10G0X26.0
G1Z0.0F0.12
G1X30.0Z-2.0
G1Z-18.0
G1X42.0
G1X44.0Z-19.0
G1Z-49.0
N20G1X52.0
G0X100.0Z100.0
N2(FINISH OD)
G96S220M4
T0202
G0X52.0Z2.0
G70P10Q20
G0X100.0Z100.0
N3(DRILL 16)
G97S900M4
T0303
G0X0.0Z5.0
G74R0.5
G74Z-55.0Q8000F0.12
G0X100.0Z100.0
N4(BORE 20)
G96S150M4
T0404
G0X15.0Z2.0
G71U1.0R0.3
G71P30Q40U-0.3W0.05F0.15
N30G0X24.0
G1Z0.0F0.1
G1X20.0Z-2.0
G1Z-25.0
N40G1X15.0
G70P30Q40
G0Z5.0
G0X100.0Z100.0
N5(GROOVE 3MM)
G97S800M4
T0505
G0X34.0Z-18.0
G75R0.5
G75X27.0P1000F0.08
G0X100.0Z100.0
N6(THREAD M30X1.5)
G97S1000M4
T0606
G0X34.0Z5.0
G76P010060Q50R0.02
G76X28.16Z-14.0P920Q300F1.5
G0X100.0Z100.0
N7(PART OFF)
G97S700M4
T0707
G0X54.0Z-48.0
G1X14.0F0.06
G0X54.0
G28U0W0M5
M9
M30
%`,X=`%
O9101(SIM LATHE BAD DEMO - DELIBERATE ERRORS)
N1(FACE - NO G50 LIMIT)
G28U0W0
G96S180M4
T0101
G0X54.0Z0.0M8
G1X-6.0F0.15
G0X40.0Z2.0
G0Z-10.0
G1Z-30.0F0.2
G1X54.0
M5
G0X38.0Z2.0
G1Z-20.0F0.2
G0X60.0
M4
G0Z-70.0
G1X48.0Z-78.0F0.2
G0X100.0Z100.0
N6(THREAD WITH M3)
G97S1000M3
T0606
G0X42.0Z5.0
G92X36.0Z-10.0F1.5
G0X100.0Z100.0
N4(BORE WITH NO HOLE)
G96S150M4
T0404
G0X12.0Z2.0
G1Z-10.0F0.1
G0Z5.0
G0X100.0Z100.0
N7(PART OFF)
G97S700M4
T0707
G0X54.0Z-48.0
G1X-1.0F0.06
G0X54.0
N8(CUT AFTER PART OFF)
T0202
G96S200M4
G0X30.0Z2.0
G1Z-30.0F0.1
G28U0W0M5
M30
%`;function Z(t=c){return{program:t,stock:{...R},material:"EN8 (demo)",tools:M,machine:S,drawing:N}}const x=r.lazy(()=>d(()=>import("./CncSimulatorView-Chzi1-gb.js"),__vite__mapDeps([0,1,2,3,4,5,6]))),O=r.lazy(()=>d(()=>import("./LatheSim3D-C6H8bG-Z.js").then(t=>t.L),__vite__mapDeps([7,1,2,3,8,9,10])));function b(){const[t,G]=r.useState("good"),[a,n]=r.useState(null),[l,i]=r.useState(!1),[m,h]=r.useState(!1),p=r.useMemo(()=>Z(t==="good"?c:X),[t]),u=!a||a.blocked;return e.jsxs("div",{className:"space-y-4",children:[e.jsxs("section",{className:"space-y-2",children:[e.jsx("h2",{className:"text-lg font-semibold",children:"O0003 · 3227C07701 BOSS-SUCTION PIPE"}),e.jsx(r.Suspense,{fallback:e.jsx("p",{className:"text-sm text-slate-600",children:"Loading the simulator…"}),children:e.jsx(x,{programUrl:"/SDEW-manuf-AI/samples/O0003.nc",speed:10})})]}),m?e.jsxs(e.Fragment,{children:[e.jsxs("div",{children:[e.jsx("h1",{className:"text-xl font-semibold",children:"Lathe simulation (demo)"}),e.jsxs("p",{className:"text-sm text-slate-600",children:["Synthetic programs on the fictional ",e.jsx("strong",{children:"SIM Lathe"})," - not for machine use. Pick a program and press Play."]})]}),e.jsx("div",{className:"flex flex-wrap items-center gap-2",role:"radiogroup","aria-label":"Demo program",children:["good","bad"].map(s=>e.jsx("button",{role:"radio","aria-checked":t===s,className:t===s?"btn-primary":"btn",onClick:()=>{G(s),n(null),i(!1)},children:s==="good"?"O9100 demo part (face … part-off)":"O9101 deliberately bad program"},s))}),e.jsx(r.Suspense,{fallback:e.jsx("p",{className:"text-sm text-slate-600",children:"Loading…"}),children:e.jsx(O,{input:p,onResult:n})}),e.jsxs("div",{className:"space-y-1 rounded border bg-white p-4",children:[e.jsx("button",{className:"btn-primary",disabled:u||l,onClick:()=>i(!0),"data-testid":"demo-approve",children:l?"Approved (demo only, nothing saved)":"Approve program"}),(a==null?void 0:a.blocked)&&e.jsxs("p",{className:"text-sm text-rose-800",children:["Approval blocked: the simulation found"," ",a.checks.filter(s=>s.severity==="error").length," error(s)."]})]})]}):e.jsxs("section",{className:"rounded border bg-white p-4",children:[e.jsx("h2",{className:"font-semibold",children:"Rule checks demo (SIM Lathe)"}),e.jsx("p",{className:"text-sm text-slate-600",children:"Synthetic programs that show the simulation's error and warning checks. Opened only on request, so it does not slow this page down."}),e.jsx("button",{className:"btn mt-2",onClick:()=>h(!0),children:"Show the rule checks demo"})]})]})}export{b as default};
