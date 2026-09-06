/* ===== データとUIの分離(2026-08-02) =====
   このファイルは中身が毎晩変わらない「UI」。データは last7.data.js が
   window.SHIMA として先に読み込まれている(通常の<script>なので同期・
   ここでは非同期の初期化を一切増やさない=TDZ絡みの事故を持ち込まない)。
   盤面のセルは [キー, style, class, 中身, 台番, ラベルキー] の配列で受け取り、
   ここで組み立てる。期間切替(applyPeriod)が同じ形の配列からセルを作っているので、
   生成側も読み手も形が1つで済む。並び順は重なり(z順)に効くので変えない。 */
(()=>{
  const b=document.getElementById("board");
  b.style.width=SHIMA.W+"px"; b.style.height=SHIMA.H+"px";
  const h=[];
  for(const c of SHIMA.cells){
    h.push('<div class="'+c[2]+'" style="'+c[1]+'" data-k="'+c[0]+'"'
      +(c[4]?' data-dai="'+c[4]+'"':"")+(c[5]?' data-lbl="'+c[5]+'"':"")
      +">"+c[3]+"</div>");
  }
  b.innerHTML=h.join("\n");
})();
const DATA=SHIMA.data;
// 読み込み時のURLクエリを退避しておく(2026-08-01・第3段階)。初期化の途中でsyncUrlが
// 走ってURLを書き換えるため、後から location.search を読んでも共有された値は残っていない。
const INIT_Q=new URLSearchParams(location.search);
// 復元中はsyncUrlを止める(復元の途中経過でURLが揺れないように)。syncUrl()は初期化の
// applyPeriod()からも呼ばれるので、宣言はスクリプトの前方に置く必要がある
// (letはホイストされないため、後ろで宣言すると「初期化前に参照した」で初期化が止まる)。
let urlLock=false;
// 台番カードを開いたときに履歴を1つ積んだか(2026-08-01・戻る操作で閉じるため)。
// syncUrl()から参照するので、**urlLockと同じ理由でここに置く**(後ろで宣言すると
// 初期化中のsyncUrl()が「初期化前に参照した」で落ちる)。
let cardPushed=false, backClosing=false;
// 拡大中の現在地チップの遅延タイマー(2026-08-01)。whereSoon()は初期化中のsetView()から
// 呼ばれるので、これも前方で宣言する(後ろに置いて実際にTDZで初期化ごと落ちた)。
let whereTimer=0;
// ピン一覧の「すべて外す」の2度押し用タイマー(2026-08-02)。paintPins()→pinAskOff()から
// 参照され、そのpaintPins()は初期化中のapplyPeriod()からも呼ばれるので**前方で宣言する**
// (後ろに置くとTDZで初期化ごと落ちる。この画面で3回踏んでいる同じ罠)。
let pinAskTimer=0;
const fmt=v=>v==null?"−":(v>0?"+":"")+v.toLocaleString();
const cls=v=>v==null?"":(v>0?"plus":(v<0?"minus":""));
const rate=(v,g)=>(v==null||!g||g<=0)?null:((3*g+v)/(3*g)*100);
const fr=r=>r==null?"−":r.toFixed(1)+"%";
// ゲーム数の表記(単日グラフの横軸・区間表で共用)。差枚と違い符号は付けない。
const gnum=g=>g==null?"−":Math.round(g).toLocaleString();
// 日付ラベル「7/25(土)」の曜日部分だけを色分け用spanで包む(2026-07-31谷川氏指示・
// 土=青/日=赤)。他の曜日は素のまま返す=DOMを増やさない。
const wdHtml=lb=>{
  const m=String(lb).match(/^(.*)\((.)\)$/);
  if(!m)return lb;
  const c=(m[2]==="土")?"sat":((m[2]==="日")?"sun":"");
  return c?(m[1]+'<span class="'+c+'">('+m[2]+')</span>'):lb;
};
const WEEK=SHIMA.week, NDAYS=SHIMA.ndays;
// ---- 3週間の累積差枚グラフ(スランプ形式・折れ線1系列) ----
// 2026-07-30谷川氏指示「積み重ね式にして」+「左端はデータのある過去日全てを含めた累積から
// スタート」: マトリクス先頭(6/13〜)から3週間窓の前日までの合計(base)を始点に、
// 21日分を積み上げる=台の全期間スランプの直近3週間を切り出した形。
// 最終点=全期間の累計差枚。日毎の値は表とタップ/ホバーで読む。
// 欠測日(未稼働/データ欠け)は累積を横ばいで継続(打っていない=増減なし、が事実)。
// 線=紺(#1F3864・カード見出しと同色)2px・角丸。点(r=4・白2px縁)は最終日と最大/最小のみ
// =全点に丸と数字を置くと21点では読めなくなるため(その他の日の値はタップ/ホバーと表で読む)。
// 符号は0線の上下(位置)と点の色(青+/赤−、表の文字色と同一)の二重符号化。配色は検証済
// (validate_palette.js: CVD ΔE 23.4 protan / 通常 32.3 で全項目PASS)。
// レイアウト: 上=最大値ラベル帯 / 中=プロット / 下=最小値ラベル・曜日(+広い時だけ週頭日付)。
// CH(=viewBoxの高さ)は fitCard から可変で渡す。svgはheight:autoで幅いっぱいに描くため、
// 縦を詰めたいときは「レターボックス(左右に余白)」ではなくviewBox自体を低くする。
// 上下の帯もCHに応じて詰める(帯を固定にすると縮めたときプロットだけが潰れる)。
const CW=356,PX=3,CH0=164;
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");
// 2026-07-30(夜)谷川氏指示「背景色をライト/ダークで切替」対応: グラフの折れ線/罫線/曜日文字は
// カード背景(#card)の上に直接描かれるため、これらの「意味を持たない構造色」だけテーマに応じて
// 差し替える(丸点のsgn()による青/赤は差枚の符号という意味を持つ色なのでテーマに関係なく固定=
// 変更しない)。
// sat/sunは表の曜日色(2026-07-31追加)と同じ値を使う(ライトは.plus/.minusと同一・
// ダークは表の.sat/.sunダーク値と同一)。wdは以前グラフ下の曜日行で水曜だけを強調するのに
// 使っていたが、谷川氏指示「平日の普通の色と同じに」で水曜強調は撤去済み(以後は水曜も
// wdOtherと同じ扱い)。wd自体はTC定義に残すが現在未使用。
// cardBg=カード背景色(2026-07-31追加)。目安線の数値ラベルをプロット内(折れ線や他の要素の
// 上)に置くため、テキストの下に同色の不透明な帯(ノックアウト)を敷いて可読性を確保する用途。
const chartColors=()=> (document.documentElement.getAttribute("data-theme")==="dark")
  ? {line:"#7fa8e0",week:"#3a4048",guide:"#2a2e33",zero:"#7a8088",wd:"#7fa8e0",wdOther:"#8a9098",wkDate:"#aaaaaa",sat:"#8ab4f8",sun:"#ff8a80",cardBg:"#1e1e1e"}
  : {line:"#1F3864",week:"#dde1e8",guide:"#eef0f3",zero:"#9aa0a8",wd:"#1F3864",wdOther:"#9aa0a8",wkDate:"#666666",sat:"#1565c0",sun:"#c62828",cardBg:"#ffffff"};
// 1日あたりの幅(px)。drawChartが毎回入れ、markSelが光の大きさを決めるのに使う。
// **宣言はdrawChartより前に置く**(letは巻き上げ後に初期化されるまで参照できないので、
// 後ろで宣言すると「初期化前に参照した」で描画ごと止まる)。
let curSlot=0;
function drawChart(days,labels,CH,base,intra){
  CH=CH||CH0; base=base||0;
  const TC=chartColors();
  // 2026-07-31: 日付行(全21日、曜日の真下)の追加に伴いfull閾値とPB配分を見直した。
  // 実機(vv=688相当)ではfitCardが選ぶ段はCH=136(旧閾値140の外)が最頻という実測結果を受け、
  // 閾値を大きく引き下げた。旧「週頭日付のみ」の行はフォント9.5pxで14px分の余白が要ったが、
  // 新しい日付行はフォント6.3px(1行の高さは半分程度)で済むため、必要な追加PBも12pxで足りる
  // (13段全CH×839台の幾何検証で衝突0を確認済み)。
  const full=CH>=88;
  // 単日(intra)は横軸がゲーム数なので、intraのときだけ intra に「当日の総G数」を入れて渡す
  // (0/true=総G数が無い＝目盛りを出さない)。boolean のままでも真偽判定は変わらないので、
  // drawChartを呼ぶ側(fitCard/テーマ切替)の引数はcurIntra1つのままで済む。
  const gTot=(typeof intra==="number"&&intra>0)?intra:0;
  const PT=22;
  // 下帯(PB)の内訳: 日別グラフ=曜日行+日付行、単日=ゲーム数の目盛り1行だけ。
  // 単日は1行ぶん少ないので10px詰めてグラフへ回す(谷川氏の「折れ線を大きく」の趣旨)。
  const PB=intra?(full?36:30):(full?46:34);
  const yWd=full?CH-15:CH-4;
  // 累積系列: cums[i]=過去日全て(base)+窓内i日目までの合計(nullは横ばい)。全21日で定義される。
  const cums=[]; let acc=base;
  days.forEach(d=>{ if(d[0]!=null)acc+=d[0]; cums.push(acc); });
  let pos=Math.max(base,...cums), neg=Math.min(base,...cums);
  if(pos===neg){pos+=1000;neg-=1000;}
  const span=(pos-neg)||1, plotH=CH-PT-PB;
  const yv=v=>PT+plotH*((pos-v)/span);
  const zy=yv(0);
  // 丸を打つ3点=累積のピーク・ボトム・最終日(同値の横ばいは最初の到達日)。
  let iMax=0,iMin=0;
  cums.forEach((c,i)=>{ if(c>cums[iMax])iMax=i; if(c<cums[iMin])iMin=i; });
  const iEnd=days.length-1;
  // 目安の横線(2026-07-30谷川氏指示「目安の横線を2〜3本」): 0線と極値ラベルだけでは
  // グラフ中腹の水準感が掴みにくいため、レンジをきりのいい間隔(1/2/5×10^n)で刻んだ薄い
  // 横線を2〜3本添える。数値ラベルは付けない(21点グラフは既に極値ラベルで帯の余白が
  // 逼迫しており、ここに数字を足すと衝突の再発になるため。あくまで水準の目安=0線より
  // さらに薄い色にして主従を作る)。上下端(極値ラベルのある帯)付近には引かない。
  // 本数の決め方(2026-08-01谷川氏指示「最適と判断する数を入れて。今の数だと少ない印象」)。
  // 旧実装は「span/4.2をきりのいい値に丸めて引き、3本を超えたら先頭/中央/末尾の3本へ間引く」で
  //   (1) どの台もほぼ3本止まり(839台実測: 直近7日771台/3週間719台/全期間607台が3本)
  //   (2) 丸めでステップが小さくなると、選んだ3本の間隔が1ステップと2ステップの不揃いになる
  //       (3週間窓の実測で線どうしの最小間隔が中央値9.6px・最小5.2px)
  // という2つの問題があった。新実装は「プロット高さから目標本数を決め、1/2/5×10^n のきりのいい
  // 間隔のうち実際に引ける本数が目標に最も近いものを選ぶ」。間引きをやめたので間隔は必ず等間隔。
  // 本数の決め方: 「線どうしの間隔(px)」を一定にし、上下限で挟む。
  // プロット高さは窓ごとに大きく違う(実測: 直近7日=約85px / 3週間=約28〜36px。表の行数が
  // 違うぶんfitCardが選ぶグラフ高さが変わるため)。高さに比例させただけだと直近7日で10本・
  // 3週間で2本と極端に振れたので、3〜6本に収める上下限を付けた。
  // GUIDE_GAPは線どうしの間隔の下限(px)。当初はラベル帯と同じ9pxにしたが、3週間窓は
  // プロット高さが28〜36pxしかなく、9px下限だと刻みが5000枚単位まで粗くなって
  // 「線が0〜2本」になった(839台実測: 最頻2本・0本の台も10台)。線そのものは薄いグレーで
  // 主張が弱く、ラベルは置けない分だけ自動で省かれるので、下限を6.5pxまで下げた。
  const GUIDE_GAP=6.5;
  const gTarget=Math.max(3,Math.min(6,Math.floor(plotH/GUIDE_GAP)));
  const gMargin=span*0.06;
  const gListFor=st=>{
    const out=[];
    for(let gv=Math.ceil((neg+gMargin)/st)*st; gv<=pos-gMargin; gv+=st){
      if(Math.abs(gv)>=1) out.push(gv);
    }
    return out;
  };
  let gLines=[], bestD=1e9;
  const gBase=Math.pow(10,Math.floor(Math.log10(Math.max(1,span/(gTarget+1)))));
  // 刻みの候補。1/2/5×10^n に加えて 2.5×10^n も許す(2500枚・250枚など目盛りとして
  // 十分きりが良く、候補の粒度が粗いせいで本数が目標から大きく外れるのを減らせる)。
  const gCands=[0.1,0.2,0.25,0.5,1,2,2.5,5,10,20].map(f=>f*gBase).filter(st=>st>=1);
  // 刻みを決める前に、その刻みだと線どうしが画面上で何px離れるかを見て、GUIDE_GAPを
  // 下回るものは候補から外す(本数だけで選ぶと、目標に近いという理由で間隔4〜5pxの
  // 「薄いグレーの縞」が選ばれてしまい、かえって読めなくなる)。
  const gapPx=st=>plotH*st/span;
  let gUsable=gCands.filter(st=>gapPx(st)>=GUIDE_GAP);
  if(!gUsable.length) gUsable=[Math.max.apply(null,gCands)];   // どれも詰まるなら一番広い刻み
  gUsable.forEach(st=>{
    const l=gListFor(st);
    const d=Math.abs(l.length-gTarget);
    // 目標に最も近いものを選ぶ。同じ差なら本数が少ないほう(=詰まらないほう)を採る
    // (多いほうを優先すると、目標6本のときに10本の候補が選ばれて縞模様になった)。
    if(d<bestD||(d===bestD&&l.length<gLines.length)){ bestD=d; gLines=l; }
  });
  // 2026-08-01谷川氏指示「目安線の数字は左寄せにして、折れ線のスタートをその数字の右側から
  // 始めるようにすれば折れ線への被りがなくなる」。従来は折れ線を避けられる位置を左から
  // 走査して探し、見つからなければラベルを省いていた(実測で全期間窓の一部で省略が発生)。
  // 左端に数字専用の帯を作り、プロットをその右から始める方式に変更した。原理的に重ならない
  // ので探索も省略も要らず、どの台でも全部の目安線に数字が付く。
  const gTxtW=t=>[...t].reduce((a,c)=>a+(c.charCodeAt(0)<128?3.9:7),0);   // font-size7の見積り
  const gLabW=gLines.length?Math.max.apply(null,gLines.map(gv=>gTxtW(fmt(gv)))):0;
  const X0=PX+(gLabW?gLabW+4:0);                     // プロット(折れ線)の左端
  // 文字幅の実測(canvas)。日付・曜日のラベル幅を先に知る必要があるのでここで用意する。
  const measW=(()=>{ let ctx=null; return (t,f,b)=>{
    if(!ctx) ctx=document.createElement("canvas").getContext("2d");
    ctx.font=(b?"bold ":"")+f+"px "+(getComputedStyle(document.body).fontFamily||"sans-serif");
    return ctx.measureText(t).width; }; })();
  // 2026-07-31(谷川氏指摘「折れ線グラフのマーカーと日付の縦ズレを補正」):
  // 最終日のラベルは中央寄せだと右端がviewBoxからはみ出すため、これまでは内側へ
  // 押し戻していた。その結果、最終日のマーカー(丸)と日付が実測で4.2pxずれていた
  // (全期間窓。他の窓は0px)。**押し戻すのをやめ、代わりに右側にラベル半分の余白を
  // 確保する**=どの日もマーカーの真下に中央寄せで置ける。
  const labW=intra?0:Math.max(
    Math.max.apply(null,labels.map(l=>measW(l.split("(")[0],6.3,false))),
    Math.max.apply(null,labels.map(l=>measW((l.match(/\((.)\)/)||[])[1]||"日",9,true))));
  const RX=Math.max(PX,labW/2+1);                    // プロット右端の余白
  const slot=(CW-RX-X0)/days.length, cx=i=>X0+i*slot+slot/2;
  curSlot=slot;   // 選択マーカーの光の大きさを日の間隔に合わせるため(markSelが使う)
  // ---- 単日(intra)の横軸=ゲーム数(2026-08-01谷川氏指示「単日グラフの深掘り」) ----
  // サイトセブンの単日チャートは横軸が稼働(ゲーム数)。実測で確かめた根拠は2つ:
  //  (1) 線の長さ(span)が台ごとに3〜221pxと大きく違う。時刻軸なら「打たれていない時間も
  //      線は横に伸びる」ので、閉店まで置かれている台の線は全台ほぼ同じ長さになるはず。
  //  (2) 軌跡に水平な区間がほとんど無い(隣接点が同値の割合は中央値7.8%・最長でも6点)。
  //      時刻軸なら空き時間が必ず長い水平区間を作る。1G回せばメダルは必ず動くので、
  //      ゲーム数軸なら水平が出ないのが正しい。
  // よって「線の始点=0G / 終点=当日の総G数」で、点の並びをゲーム数へ読み替えられる。
  // 総G数はマトリクスの当日G数(正確な実数)を使う。
  // 目盛りの位置は折れ線が実際に通るx(=[X0, cx(0)…cx(n-1)])を線形補間して求める
  // (等間隔の式で近似すると先頭側で最大 slot/2 ずれ、丸と目盛りの縦位置が合わなくなる)。
  let gTicks=null, gtx=null;
  if(intra&&gTot>0&&days.length>=4){
    const xseq=[X0]; for(let i=0;i<days.length;i++) xseq.push(cx(i));
    gtx=gv=>{
      const t=Math.max(0,Math.min(1,gv/gTot))*(xseq.length-1), i=Math.floor(t);
      return (i>=xseq.length-1)?xseq[xseq.length-1]:xseq[i]+(xseq[i+1]-xseq[i])*(t-i);
    };
    // 刻みは小さいほうから試し、「隣とぶつからない」かつ「本数が7本以内」の最初のものを採る。
    // 文字幅は日付ラベルと同じくcanvasで実測する(見積りだと詰まりすぎる)。
    for(const st of [100,200,250,500,1000,2000,2500,5000,10000]){
      const arr=[];
      for(let gv=st;gv<gTot-st*0.35;gv+=st) arr.push(gv);
      if(!arr.length||arr.length>7) continue;
      const wmax=Math.max.apply(null,arr.map(gv=>measW(gnum(gv),6.3,false)));
      if((gtx(arr[0])-gtx(0))<wmax+10) continue;      // 1刻みの実幅が文字幅+10pxに満たない
      gTicks=arr; break;
    }
  }
  let s=`<svg viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="xMidYMid meet" role="img" `
   +`aria-label="累積差枚(スランプ)">`
   // 選択中マーカーの光(2026-08-01谷川氏指示「中心から外側へ向かって黄色が薄くなる」)。
   // 輪(線)ではなく放射状グラデーションの塗りにする。中心を濃く、外へ向けて透明にする。
   // 2026-08-01(谷川氏指示「色味を強めに・点滅の仕方はそのまま・円の範囲を大きく」):
   // 中心の不透明度を0.95→1.0、中間の落ち方も緩めて濃い部分を広げた。半径はmarkSel側で拡大。
   // いちばん外は0のまま=縁がぼけて丸く消える(境界線が出ると光ではなく輪に見える)。
   +`<defs><radialGradient id="selGrad">`
   +`<stop offset="0%" stop-color="#ffc400" stop-opacity="1"/>`
   +`<stop offset="38%" stop-color="#ffc400" stop-opacity="0.82"/>`
   +`<stop offset="68%" stop-color="#ffc400" stop-opacity="0.42"/>`
   +`<stop offset="100%" stop-color="#ffc400" stop-opacity="0"/>`
   +`</radialGradient></defs>`;
  // 週の区切り(控えめ)。単日は横軸がゲーム数なので「7点ごと」に意味が無い
  // (単なる7サンプルごとの線になる)。代わりにゲーム数の目盛りで縦線を引く。
  if(!intra){
    for(let i=WEEK;i<days.length;i+=WEEK){
      const x=X0+i*slot-1;
      s+=`<line x1="${x.toFixed(1)}" y1="${PT-5}" x2="${x.toFixed(1)}" y2="${CH-PB+3}" stroke="${TC.week}" stroke-width="1"/>`;
    }
  }else if(gTicks){
    gTicks.forEach(gv=>{
      const x=gtx(gv);
      s+=`<line x1="${x.toFixed(1)}" y1="${PT-5}" x2="${x.toFixed(1)}" y2="${CH-PB+3}" stroke="${TC.week}" stroke-width="1"/>`;
    });
  }
  // 目安の横線はプロット領域だけに引く(左の数字帯には掛けない=線が数字を横切らない)。
  gLines.forEach(gv=>{
    const gy=yv(gv);
    s+=`<line x1="${X0}" y1="${gy.toFixed(1)}" x2="${CW-RX}" y2="${gy.toFixed(1)}" stroke="${TC.guide}" stroke-width="1"/>`;
  });
  // 数字は左端に左寄せで固定。線の間隔が詰まっている台では文字が縦に重なるので、
  // 直前に置いた数字と9px未満しか離れていないものは飛ばす(線は残るので水準は読める)。
  let gLastY=-99;
  gLines.forEach(gv=>{
    const y=yv(gv);
    if(Math.abs(y-gLastY)<9)return;
    gLastY=y;
    s+=`<text x="${PX}" y="${(y+2.4).toFixed(1)}" font-size="7" fill="${TC.wkDate}">${fmt(gv)}</text>`;
  });
  // 0線: 全期間累積では0がレンジ外の台も多い(ずっとプラス/マイナスの台)→範囲内のときだけ描く
  if(zy>=PT-1&&zy<=CH-PB+1)
    s+=`<line x1="${X0}" y1="${zy.toFixed(1)}" x2="${CW-RX}" y2="${zy.toFixed(1)}" stroke="${TC.zero}" stroke-width="1"/>`;
  // 折れ線: 左端=過去日全ての累積(base)→各日の累積を1本で結ぶ(欠測日は横ばい)。
  const pts=[[X0,yv(base)]];
  days.forEach((d,i)=>pts.push([cx(i),yv(cums[i])]));
  s+=`<path d="${pts.map((p,k)=>(k?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join("")}" `
    +`fill="none" stroke="${TC.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const sgn=v=>v>0?"#1565c0":(v<0?"#c62828":"#5a6270");
  const marks=[...new Set([iMax,iMin,iEnd])];
  // 2026-07-31谷川氏指示「各日付ごとにマーカーが付いてないところは小さめのマーカーを付けて。
  // その小さなマーカーの数字はとくに載せなくてよい」。
  // どの日がどこに当たるかを線の上で追えるようにするのが目的なので、数値は付けない。
  // 線と同じ色で塗ると線に埋もれて見えないため、中を背景色で抜いて線色で縁取る(白抜きの点)。
  // 大きさは1日あたりの幅(slot)で変える。全期間は52日=約6px間隔なので、大きいと
  // 点が数珠つなぎに見えてしまう。単日(intra)は横軸が時間で最大48点の密なグラフなので付けない。
  if(!intra){
    const rs=slot>=20?2.6:(slot>=10?2.2:1.7);
    days.forEach((d,i)=>{
      if(marks.indexOf(i)>=0)return;                 // 大きい丸を打つ3点は除く
      s+=`<circle class="dot" data-i="${i}" cx="${cx(i).toFixed(1)}" cy="${yv(cums[i]).toFixed(1)}" `
        +`r="${rs}" fill="${TC.cardBg}" stroke="${TC.line}" stroke-width="1.1"/>`;
    });
  }
  // 点は累積のピーク・ボトム・最終日のみ(r=4=8px・白2px縁で線と重なっても見える)
  marks.forEach(i=>{
    s+=`<circle data-i="${i}" cx="${cx(i).toFixed(1)}" cy="${yv(cums[i]).toFixed(1)}" r="4" `
      +`fill="${sgn(cums[i])}" stroke="#ffffff" stroke-width="2"/>`;
  });
  // 当たり判定: 線や点は細いので、その日の「列全体(スロット幅×プロット高)」を透明rectで受ける
  // (密な時系列の標準手法)。ツールチップは日毎+累積の両方を出す。
  days.forEach((d,i)=>{
    const v=d[0],g=d[1];
    // 単日は日付もG数も点ごとには持たない。横軸がゲーム数なので「その点が何G地点か」を
    // 総G数から割り出して出す(点は0G〜総G数の間に等間隔に並ぶ)。
    const tip=(intra&&gTot>0)
      ? `約${gnum((i+1)/days.length*gTot)}G 差枚${fmt(cums[i])}`
      : `${esc(labels[i])} 差枚${fmt(v)} 累計${fmt(cums[i])} G${g==null?"−":g.toLocaleString()}`;
    s+=`<rect class="hit" x="${(X0+i*slot).toFixed(1)}" y="${PT}" width="${slot.toFixed(1)}" `
      +`height="${plotH}" fill="#000" fill-opacity="0" pointer-events="all" data-i="${i}">`
      +`<title>${tip}</title></rect>`;
  });
  // 直接ラベルは最大・最小・最終日だけ(全点に数字は置かない)。はみ出さないよう左右をクランプ。
  // 丸を打った3点(最大・最小・最終日)には必ず数値を添える(2026-07-30谷川氏指示
  // 「差枚数が表示されていないマーカーがある」)。置き場所は必ず「プロット帯の外側=上帯/下帯」。
  // yv()は全点を[PT, CH-PB]に写すので上帯・下帯に折れ線は原理的に入らない=線と交差しない。
  // (プロット内に置く方式は839台の総点検で759台が線と交差した→この方式へ変更・2026-07-30)
  // 最大の点はプロット上端・最小の点は下端に在るため、帯に置いても点の真上/真下=対応が明確。
  const lb=[];                                  // 置いたラベル矩形(ラベル同士の衝突判定)
  const bandY=b=>(b==="top")?(PT-9):(CH-PB+16);
  const emit=(v,cxi,band,anchorEnd,rightEdge)=>{
    // 幅見積り: 6.6px/字+8px。短い文字列ほど1字あたり実幅が広い("+900"=7.25px/字)ため
    // 固定分を足して常に過大評価にする(2631で+900と+450が1px接触した対策・2026-07-30)
    const t=fmt(v), w=t.length*6.6+8;
    const y=bandY(band);
    const x=anchorEnd?(rightEdge||CW-2):Math.max(w/2+1,Math.min(CW-w/2-1,cxi));
    const b={x1:anchorEnd?x-w:x-w/2, x2:anchorEnd?x:x+w/2, y1:y-10, y2:y+3};
    if(b.y1<0||b.y2>CH||b.x1<0||b.x2>CW)return null;
    if(lb.some(p=>!(b.x2<p.x1||b.x1>p.x2||b.y2<p.y1||b.y1>p.y2)))return null;
    lb.push(b);
    return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="${anchorEnd?"end":"middle"}" `
      +`font-size="10" font-weight="bold" fill="${sgn(v)}">${t}</text>`;
  };
  s+=(emit(cums[iMax],cx(iMax),"top",false)||"");
  if(iMin!==iMax) s+=(emit(cums[iMin],cx(iMin),"bottom",false)||"");
  if(iEnd!==iMax&&iEnd!==iMin){
    // 端点に近い側の帯を第1候補にする(全期間累積では0線がレンジ外の台もあるため
    // 0線基準ではなくプロット中央基準で判定)
    const v=cums[iEnd], f=(yv(v)<=(PT+CH-PB)/2)?"top":"bottom";
    const o=(f==="top")?"bottom":"top";
    // 右端が既存ラベルで塞がれている帯では、その左隣へ寄せる(帯には線が無いので安全)
    const leftOf=bd=>{ const ys=bandY(bd); let m=CW-2;
      lb.forEach(p=>{ if(p.y1<ys+3&&p.y2>ys-10) m=Math.min(m,p.x1-3); }); return m; };
    s+=(emit(v,cx(iEnd),f,true,CW-2)||emit(v,cx(iEnd),o,true,CW-2)
      ||emit(v,cx(iEnd),f,true,leftOf(f))||emit(v,cx(iEnd),o,true,leftOf(o))||"");
  }
  // 横軸ラベルの間引き(2026-08-01谷川氏指示「全期間のグラフ下部の曜日も日付も全表示は
  // 数が多く物理的に無理があるため適切な数に」)。1日あたりの幅(slot)で描ける量が決まる:
  //   直近7日=50.0px / 3週間=16.7px / 全期間(52日)=6.7px。
  // 曜日は全角1文字=9px必要なので、全期間では隣とぶつかる(6.7px<9px)。日付(6.3px×2桁)も同様。
  // → slotが11px以上のときだけ従来どおり「全日の曜日+日付」を出し、それ未満のときは
  //    7日おき(=間引いても曜日の周期が崩れない・週区切り線とも一致する)に
  //    「7/6(日)」形式の1行だけを出す。間引き幅は1ラベル分(34px)が確保できるまで7ずつ広げる。
  const everyDay = slot>=11;
  // 2026-07-31(谷川氏指示「全期間の下の曜日と日付の表示の仕方を他の窓に合わせる」):
  // 3つの窓とも「上に曜日・その真下に日付」の2段でそろえる。窓ごとに違うのは
  // 「全部の日を出すか、間引いた日だけ出すか」だけにした。
  // pick=間引いた窓で実際に出す日の並び / pickX=その日を描くx(曜日と日付で共用する)。
  let pick=null, pickW=0; const pickX={};
  if(!intra && !everyDay){
    // 文字幅は見積らず canvas で実測する(2026-07-31)。
    // 従来は「半角5.0px/全角8.5px」で見積っていたが、実測すると土日の太字を含む
    // 「6/28(日)」は48.6pxあり見積り38.5pxより10px広く、隣との隙間が0.19pxまで
    // 詰まっていた(重なってはいないが実質読めない)。SVGのtextもcanvasも同じ
    // フォントで同じ字送りになるので、measureTextの値をそのまま使えば外れない。
    // 土日は太字で描くので、幅は常に太字で測る(太いほうに合わせておけば衝突しない)。
    // 必要な間隔は「曜日1文字(9px・土日は太字)」と「日付(6.3px)」の広いほうで決める。
    // 幅の実測(labW)はプロット右端の余白RXを決めるときに済ませてあるのでそれを使う。
    const lw=labW;
    pickW=lw;
    // 2026-07-31(谷川氏指摘「最新の日付が載っていない」「間引きすぎ」)で2点変更した。
    //  (1) 刻みを7日単位ではなく1日単位で探す。7ずつ広げると7→14と倍に飛ぶため、
    //      14日おきでも隣との隙間が42px空く=必要以上に減っていた(実測)。
    //      曜日の周期・週区切り線との一致は失うが、読める密度を優先する。
    //  (2) 起点を「末尾(最新日)」にして左へ戻る。先頭起点だと最終日が
    //      (日数-1)がkの倍数のときしか載らず、いちばん見たい直近の日付が消えていた。
    // 必要な間隔=ラベル幅+12px。canvasの実測でも実際の描画より約4px狭く出る
    // (SVGのtextとcanvasでフォントの解決が完全には一致しないため)ので、
    // 余白は実測した隙間を見ながら決めた(8pxでは隙間4.2px・12pxで約10px)。
    let k=1; while(k*slot<lw+12) k++;
    const idx=[];
    for(let i=days.length-1;i>=0;i-=k) idx.push(i);
    idx.reverse();
    // 左端のラベルが左へはみ出すなら、内側へ寄せるのではなく出さない
    // (2026-07-31: 寄せるとマーカーの真下からずれる。谷川氏指摘
    //  「マーカーと日付の縦ズレを補正」への対応。右端はRXで余白を確保済み)。
    if(idx.length>1&&cx(idx[0])-lw/2<0) idx.shift();
    // 曜日も日付もマーカーと同じ cx(i) に置く(縦のラインを完全に合わせる)。
    idx.forEach(i=>{ pickX[i]=cx(i); });
    pick=idx;
  }
  // 単日(intra)は横軸が時間経過なので、曜日行・日付行は描かない(2026-07-31)。
  // 出す日の並び: 全日出せる窓は全部、間引く窓(全期間)はpickだけ。
  const dlist = intra?[]:(everyDay?days.map((_,i)=>i):(pick||[]));
  // 曜日と日付で共用するx。全日出せる窓は従来どおりcx(i)そのまま。
  // 2026-08-01: cx(i)を使う。目安線の数字帯を作ってプロット左端をX0へずらしたとき、
  // ここだけPX基準のまま残っていて、曜日行が日付行より27.4px左にずれていた
  // (谷川氏指摘「日付と曜日の縦のラインが合うように」)。
  const lx=i=>everyDay?cx(i):(pickX[i]!==undefined?pickX[i]:cx(i));
  // 曜日(土日だけ色分け、2026-07-31)。水曜の強調表示は谷川氏指示で撤去し平日と同じ色に
  // 統一した(以前は水曜だけ紺太字で目立たせていたが「平日の普通の色と同じに」と指定された)。
  dlist.forEach(i=>{
    const wd=(labels[i].match(/\((.)\)/)||[])[1]||"";
    const col=wd==="土"?TC.sat:(wd==="日"?TC.sun:TC.wdOther);
    const bold=wd==="土"||wd==="日";
    s+=`<text x="${lx(i).toFixed(1)}" y="${yWd}" text-anchor="middle" font-size="9" `
      +`fill="${col}"${bold?' font-weight="bold"':""}>${wd}</text>`;
  });
  // 日付行(2026-07-31谷川氏指示「収まる範囲の文字や文字間で全ての曜日と真下に紐づくように」
  // =週頭3件だけでなく21日全てに、対応する曜日文字の真下(cx(i)・同じx)に日付を出す。
  // 縦に余裕がある(full)ときだけ描く点は従来と同じ=収まらない小さい画面では出さない。
  // 幅16.67px/日の枠に収めるため、月をまたがない日は日にちの数字だけ(「9」「29」)、
  // 月替わりの日(または先頭日)だけ月も付ける(「8/1」)。全角スラッシュ等は使わない。
  // 2026-07-31: 間引く窓(全期間)も同じ形で日付を出す(谷川氏指示「他の窓に合わせる」)。
  // 月の省略は「ひとつ前に出した日付」と比べて判断する(間引いた並びでも
  // 6/12→18→24→30→7/6… と、月が変わった所だけ月が付く形になる)。
  if(full && !intra){
    let prevMon=null;
    dlist.forEach((i,n)=>{
      const dm=labels[i].split("(")[0], [mm,dd]=dm.split("/");
      const t=(n===0||mm!==prevMon)?(mm+"/"+dd):dd;
      prevMon=mm;
      s+=`<text x="${lx(i).toFixed(1)}" y="${CH-3}" text-anchor="middle" font-size="6.3" `
        +`fill="${TC.wkDate}">${t}</text>`;
    });
  }
  // 単日はゲーム数の目盛り(2026-08-01)。日別グラフの日付行と同じ位置・同じ大きさに置く。
  // 右端に単位「G」を1つだけ添える=各目盛りに付けるより文字数が減り、刻みを細かくできる。
  if(full && intra && gTicks){
    gTicks.forEach(gv=>{
      s+=`<text x="${gtx(gv).toFixed(1)}" y="${CH-3}" text-anchor="middle" font-size="6.3" `
        +`fill="${TC.wkDate}">${gnum(gv)}</text>`;
    });
    s+=`<text x="${(CW-1).toFixed(1)}" y="${CH-3}" text-anchor="end" font-size="6.3" `
      +`fill="${TC.wkDate}">G</text>`;
  }
  return s+"</svg>";
}
// グラフ期間の窓(日数。0=全期間)。既定は従来と同じ3週間(2026-07-31にモーダル内へ切替を新設)。
let curDai=null, curWin=NDAYS;
try{ const w=parseInt(localStorage.getItem("shimaheat-mwin"),10); if(!isNaN(w))curWin=w; }catch(e){}
// 単日グラフ(2026-07-31谷川氏指示)。DAYGは取得時に数値化した当日の軌跡(枚)。
// サイトセブンの単日チャートは-5000付近で底に張り付くため、そのままだと大負け台の谷が
// 潰れる。全館差枚の取得側は底打ち時に週チャートから当日差枚を割り出して真値化しているので、
// ここでは終端がその真値になるよう軌跡全体を比率補正して描く(始点0は動かさない)。
const DAYG=SHIMA.dayg;
function renderDay(dai){
  const m=DATA.machines[dai], s=(DAYG.s||{})[dai];
  if(!m||!s||s.length<3)return false;
  // 真値=マトリクスの当日差枚(単日ヒートと同じ値)。ラベルは「7/30(木)」形式。
  let real=null;
  DATA.labels.forEach((lb,i)=>{ if(lb.split("(")[0]===DAYG.md) real=m.d[i][0]; });
  // 終端は必ずマトリクスの真値へ合わせる(画像から読んだ値には数十枚の誤差が出るうえ、
  // 底打ち台は谷が潰れて終端も過小になるため)。始点0は動かさず全体を比率で伸縮する。
  // 注記は「底打ちを真値へ戻した」と言える差(50枚超)があるときだけ出す。
  const endv=s[s.length-1];
  let ser=s.slice(), fixed=false;
  if(real!=null && endv!==0 && real!==endv){
    const k=real/endv;
    ser=s.map(v=>Math.round(v*k));
    fixed=Math.abs(real-endv)>50;
  }
  curDai=dai; curWin=1;
  // 単日も同じ形にそろえる(台番の行に日付・機種名の行は機種名だけ・2026-07-31)。
  // 日付には曜日を付ける(2026-08-01谷川氏指示「カードの上部の日付に曜日を追加」)。
  // DATA.labelsが「7/31(金)」形式なので、当日のラベルをそのまま使う(曜日の算出を
  // ここで作り直さない=表の日付列・グラフ下の曜日と必ず同じ判定になる)。
  let dlab=DAYG.md;
  DATA.labels.forEach(lb=>{ if(lb.split("(")[0]===DAYG.md) dlab=lb; });
  document.getElementById("mtitle").textContent="台"+dai+" "+dlab+" 単日";
  document.getElementById("msub").textContent=m.n;
  buildMini(dai,m.n);
  document.querySelectorAll(".mchip").forEach(b=>b.classList.toggle("is-on",b.dataset.w==="1"));
  const lo=Math.min(...ser), hi=Math.max(...ser);
  document.getElementById("mcap").textContent="当日最高 "+fmt(hi)+" ／ 当日最低 "+fmt(lo)
    // 注記は短く(2026-08-01谷川氏指示「底打のため真値補正」)。1行に収めるため。
    +" ／ 最終 "+fmt(ser[ser.length-1])+(fixed?"（底打のため真値補正）":"");
  // drawChartは「日毎の増減」を受け取って累積を描く作りなので、軌跡(累積値)を差分へ直して渡す。
  // 当日の推移なので基準(base)は0=朝スタート。
  const days=ser.map((v,i)=>[v-(i?ser[i-1]:0),null]), labels=ser.map(()=>"");
  // 当日のG数(マトリクスの実数)。単日の横軸=ゲーム数の目盛りに使うので、drawChartを
  // 呼ぶ前に取る(表のG数と同じ値。以前は表を作る所で取っていたため描画に間に合わず、
  // intraにtrueを渡していて目盛りが一度も出なかった)。G数が無い日はtrue=目盛り無し。
  let g=null; DATA.labels.forEach((lb,i)=>{ if(lb.split("(")[0]===DAYG.md) g=m.d[i][1]; });
  curDays=days; curLabels=labels; curBase=0; curIntra=(g>0)?g:true;
  document.getElementById("chart").innerHTML=drawChart(days,labels,CH0,0,curIntra);
  // 表は当日1行だけ(G数はマトリクス側の当日値)。
  const v=ser[ser.length-1], rr=rate(v,g);
  // 累計差枚(2026-08-01): 単日でも「その日の終わりまでの通算差枚」を出す。
  // 他の窓の最終行と同じ値になるよう、全日付を頭から当日まで足す(基準はm.b=窓外の累積)。
  let dacc=m.b||0;
  for(let i=0;i<DATA.labels.length;i++){
    if(m.d[i][0]!=null) dacc+=m.d[i][0];
    if(DATA.labels[i].split("(")[0]===DAYG.md) break;
  }
  // 日付セルも他の期間と同じ「7/31(金)」形式にそろえる(曜日は土日だけ色が付く)。
  document.getElementById("mbody").innerHTML=
    `<tr><td>${wdHtml(dlab)}</td><td class="${cls(v)}">${fmt(v)}</td>`
    +`<td class="${cls(dacc)}">${fmt(dacc)}</td>`
    +`<td>${g==null?"−":g.toLocaleString()}</td>`
    +`<td class="${rr!=null&&rr>=100?"plus":(rr!=null?"minus":"")}">${fr(rr)}</td></tr>`;
  {const md=document.getElementById("modal"), cd=document.getElementById("card");
   const wasOpen=md.style.display==="block";
   md.style.display="block";
   // 開くときだけ上からせり出させる(既に開いた状態での描き直しでは再生しない=
   // グラフ期間チップを押すたびにシートが跳ねるのを防ぐ)。
   if(!wasOpen){ cd.classList.remove("sheet-in"); void cd.offsetWidth; cd.classList.add("sheet-in"); }}
  syncUrl();   // 開いた後に呼ぶ(d=はカードが開いているときだけ載せる)
  paintPins(); // ★の状態をこの台に合わせる(2026-08-01)
  document.getElementById("card").scrollTop=0;
  fitModal(); fitCard();
  return true;
}
function renderCard(dai,win){
    if(win===1){ if(renderDay(dai))return; win=NDAYS; }
    const m=DATA.machines[dai];
    if(!m)return;
    curDai=dai; curWin=win;
    // win=-1 は「水曜のみ」(2026-08-06・谷川氏指示「カード内にも水曜のみボタン追加」)。
    // 窓の長さではなく**日を抜き出す**ので、他の期間とは組み立てが違う。
    const wedOnly=(win===-1);
    const N=DATA.labels.length, n=(win>0?Math.min(win,N):N), cut=wedOnly?0:N-n;
    let days, labels;
    if(wedOnly){
      const idx=[];
      DATA.labels.forEach((L,i)=>{ if(L.endsWith("(水)")) idx.push(i); });
      days=idx.map(i=>m.d[i]); labels=idx.map(i=>DATA.labels[i]);
    }else{
      days=m.d.slice(cut); labels=DATA.labels.slice(cut);
    }
    // 窓より前の差枚は累積グラフの始点に足し込む(窓を狭めても実際の累積水準がずれない)。
    // 水曜のみは飛び飛びの日を並べるので、累積は**選んだ水曜どうしの通算**にする
    // (間の平日を足し込むと「水曜だけを見る」意味が消える)。
    let base=m.b||0;
    if(!wedOnly){ for(let i=0;i<cut;i++){ if(m.d[i][0]!=null) base+=m.d[i][0]; } }
    // 2026-07-31(谷川氏指示「機種名の後の日付を台番の行に、台番との間に一文字あけて」):
    // 期間は台番と同じ行へ。機種名が長い台では機種名＋期間が2行になっていた
    // (実機スクショIMG_1455の「L戦国乙女5 業火を穿つ宿焔の双刃 ／ 6/9〜7/30(52日)」)。
    // 機種名の行を1行に収めるほうが、グラフに回せる高さも増える。
    // 2026-08-01(谷川氏指示「上部タイトルの直近7日と全期間の日付に曜日入れる」):
    // 期間の両端にも曜日を付ける。ラベル(DATA.labels)は「7/31(金)」形式なので
    // split("(")で落としていたものをそのまま使う(単日の見出しと同じ扱いにそろえる)。
    // 3週間だけ曜日が無いと切り替えるたびに書式が変わるので、3窓とも同じ形にする。
    document.getElementById("mtitle").textContent="台"+dai+" "
      +labels[0]+"〜"+labels[labels.length-1]
      +" "+labels.length+(wedOnly?"回":"日");
    document.getElementById("msub").textContent=m.n;
  buildMini(dai,m.n);
    // 水曜のみ(-1)も選べるようになったので、窓の値をそのまま突き合わせる(2026-08-06)。
    // 以前は「0より大きくなければ0」と丸めていたため、-1だと全期間が点いてしまう。
    document.querySelectorAll(".mchip").forEach(b=>b.classList.toggle("is-on",
      (parseInt(b.dataset.w,10)||0)===win));
    // 最大/最小は日付つきで見出し直下に出す(図の中に置くと縮小時に衝突するため)
    let hi=-1,lo=-1;
    days.forEach((x,i)=>{
      const v=x[0]; if(v==null)return;
      if(hi<0||v>days[hi][0])hi=i;
      if(lo<0||v<days[lo][0])lo=i;
    });
    // グラフは累積(スランプ)なので、日毎の極値だと明記して区別する(2026-07-30累積化)
    // 2026-08-01(谷川氏指示): 日付を先・枚数を後ろにする(「日毎最高 7/18(土) +10,059」)。
    // 括弧で後置すると数字と日付の主従が読み取りにくいため。3窓とも同じ形。
    document.getElementById("mcap").textContent = hi<0 ? "データなし"
      : ("日毎最高 "+labels[hi]+" "+fmt(days[hi][0])
         +" ／ 日毎最低 "+labels[lo]+" "+fmt(days[lo][0]));
    curDays=days; curLabels=labels; curBase=base; curIntra=false;
    document.getElementById("chart").innerHTML=drawChart(days,labels,CH0,base);
    // 累計差枚(2026-08-01谷川氏指示「差枚を当日差枚に改名、当日差枚とG数の間に累計差枚列」)。
    // 折れ線グラフと同じ値=窓より前の分(base)も含んだ「その日までの通算差枚」。
    // 欠測日(差枚なし)は横ばい=前日の累計を持ち越す(グラフの扱いと必ずそろえる)。
    let _acc=base; const cum=days.map(x=>{ if(x[0]!=null)_acc+=x[0]; return _acc; });
    let rows="";
    labels.forEach((lb,i)=>{
      const v=days[i][0],g=days[i][1];
      const r=rate(v,g);
      // 週の区切り線は「連続した日」を並べているときだけ意味がある。
      // 水曜のみは飛び飛びなので引かない(2026-08-06)。
      const wk=(!wedOnly&&i>0&&i%WEEK===0)?" wk":"";
      rows+=`<tr id="mr${i}" class="${wk.trim()}"><td>${wdHtml(lb)}</td><td class="${cls(v)}">${fmt(v)}</td>`
        +`<td class="${cls(cum[i])}">${fmt(cum[i])}</td>`
        +`<td>${g==null?"−":g.toLocaleString()}</td><td class="${r!=null&&r>=100?"plus":(r!=null?"minus":"")}">${fr(r)}</td></tr>`;
    });
    // 集計行: 直近7日(=島図の色塗りと同じ期間)を上、3週間を下に置く(2026-07-30谷川氏指示)。
    const sumRow=(label,vals,extra)=>{
      let sv=0,sg=0,cv=0,cg=0;
      vals.forEach(x=>{ if(x[0]!=null){sv+=x[0];cv++;} if(x[1]!=null){sg+=x[1];cg++;} });
      const r=rate(sv,sg), rc=r!=null&&r>=100?"plus":(r!=null?"minus":"");
      const av=cv?Math.round(sv/cv):null, ag=cg?Math.round(sg/cg):null;
      // 累計差枚の列は集計行では出さない(2026-08-01)。累計の「合計」も「1日平均」も
      // 意味を持たない(累計は各日時点の通算値であって足し合わせる量ではない)。
      // 期間末の累計はすぐ上のデータ行の同じ列に出ているので情報は欠けない。
      return `<tr class="total top ${extra}"><td>${label}合計</td><td class="${cls(sv)}">${fmt(sv)}</td>`
        +`<td>−</td>`
        +`<td>${sg.toLocaleString()}</td><td class="${rc}">${fr(r)}</td></tr>`
        +`<tr class="total ${extra}"><td>${label}1日平均</td><td class="${cls(av)}">${fmt(av)}</td>`
        +`<td>−</td>`
        +`<td>${ag==null?"−":ag.toLocaleString()}</td><td class="${rc}">${fr(r)}</td></tr>`;
    };
    // 集計行の下段は「今表示している期間」の合計にする(切替に追従・2026-07-31)。
    const wlabel=wedOnly?("水曜"+labels.length+"回 ")
      :((n%WEEK===0)?(n/WEEK+"週間 "):(n+"日間 "));
    rows+=sumRow("直近7日 ",m.d.slice(-WEEK),"sub7");
    // 窓が7日のときは上段と同じ内容になるので下段は出さない(2026-07-31)。
    // 水曜のみは中身が別物なので必ず出す(2026-08-06)。
    if(wedOnly||n!==WEEK) rows+=sumRow(wlabel,days,"grand");
    document.getElementById("mbody").innerHTML=rows;
    {const md=document.getElementById("modal"), cd=document.getElementById("card");
   const wasOpen=md.style.display==="block";
   md.style.display="block";
   // 開くときだけ上からせり出させる(既に開いた状態での描き直しでは再生しない=
   // グラフ期間チップを押すたびにシートが跳ねるのを防ぐ)。
   if(!wasOpen){ cd.classList.remove("sheet-in"); void cd.offsetWidth; cd.classList.add("sheet-in"); }}
  syncUrl();   // 開いた後に呼ぶ(d=はカードが開いているときだけ載せる)
  paintPins(); // ★の状態をこの台に合わせる(2026-08-01)
    // 21行になりカードがスクロールするため、開き直したとき前回位置が残るとタイトル/グラフが
    // 見えない状態で開く(2026-07-30の実機幅360px検証で判明)→毎回先頭へ戻す。
    document.getElementById("card").scrollTop=0;
    fitModal();
    fitCard();
    // 保険(2026-07-31): タップ直後はツールバーの開閉途中などでvisualViewportの値が
    // まだ確定していないことがある。次フレーム(=画面に描かれる直前)でもう一度だけ
    // 上限を取り直し、変わっていたら文字サイズを再選定する。rAF内の変更は同じフレームで
    // 描かれるためチラつきは起きず、「一度スクロールすると直る」状態を待たずに収まる。
    requestAnimationFrame(()=>{
      if(document.getElementById("modal").style.display!=="block")return;
      fitModal();
      if(Math.abs(cardMH-lastFitMH)>1)fitCard();
    });
}
// 島図で見ている期間に合わせてカードのグラフ期間を選ぶ(2026-08-06・谷川氏指示
// 「全期間で島図表示させてる時に台番タップしたときはカードも全期間選択した状態で
//   開かれるようにすること」)。島図が全期間なのにカードが直近7日で開くと、
// 同じ台の話をしているのに見ている範囲が食い違う。
// 単日・直近7日・全期間は同じ意味の窓があるので合わせる。水曜のみは日毎グラフに
// 対応する窓が無いので、そのときだけ前回選んだ窓のままにする。
function winForBoard(){
  if(curPeriod==="all") return 0;
  if(curPeriod==="single") return 1;
  if(curPeriod==="last7") return 7;
  if(curPeriod==="wed") return -1;   // カードにも水曜のみを足した(2026-08-06)
  return curWin;
}
document.querySelectorAll(".tap").forEach(el=>{
  el.addEventListener("click",()=>{ renderCard(el.dataset.dai,winForBoard()); });
});
// グラフ期間チップ(2026-07-31新設)。押した窓で描き直し、次回タップ時も同じ窓で開く。
document.querySelectorAll(".mchip").forEach(b=>{
  b.addEventListener("click",e=>{
    e.stopPropagation();
    const w=parseInt(b.dataset.w,10)||0;
    try{ localStorage.setItem("shimaheat-mwin",String(w)); }catch(err){}
    if(curDai) renderCard(curDai,w);
  });
});
// シートを閉じる(2026-08-01)。上へスライドアウトさせてから非表示にする。
// 閉じ方は「つまみを上へスワイプ / 背景タップ / ✕ボタン」の3つ。
// 2026-08-01の上端貼り付き化で、抜ける向きも下→上へ反転した(せり出しと閉じは必ず逆向き)。
function closeCard(slide){
  const modal=document.getElementById("modal"), card=document.getElementById("card");
  if(modal.style.display!=="block")return;
  // 画面から閉じたときも履歴を1つ戻す(2026-08-01)。カードを開いたときに1つ積んで
  // いるので、戻さないと「戻る」を押しても何も起きない状態が積み上がる。
  // popstate経由で閉じているときは戻さない(二重に戻ってしまう)。
  if(cardPushed&&!backClosing){ cardPushed=false; try{ history.back(); }catch(e){} }
  const done=()=>{ modal.style.display="none"; card.classList.remove("dragging");
    card.style.transform=""; syncUrl();
    if(typeof whereSoon==="function") whereSoon(); };
  if(slide){
    card.classList.remove("dragging");
    card.style.transition="transform .2s ease-in";
    card.style.transform="translateY(-100%)";
    setTimeout(()=>{ card.style.transition=""; done(); },200);
  }else done();
}
document.getElementById("modal").addEventListener("click",e=>{
  if(e.target.id==="modal"||e.target.id==="closex") closeCard(false);
});
// 棒をタップ→その日の行をハイライトして表側へスクロール(グラフと表の対応づけ)。
// 2026-08-01谷川氏指示「マーカー選択時にマーカーの周りを黄色くして点滅させ、
// 選択しているマーカーを目立たせて」→同日「ゆっくり点滅で、中心から外側へ向かって
// 黄色が薄くなるデザイン」。選んだ日の丸に黄色い光(#selHalo)を重ねる。
// 丸そのものの色は変えない(極値=青赤の意味を壊さないため)。光は1つだけ作って使い回す。
// **丸より前(下)に挿し込む**=光の上に丸が乗るので、マーカー自体はぼやけない。
function markSel(i){
  const svg=document.querySelector("#chart svg"); if(!svg)return;
  const c=svg.querySelector('circle[data-i="'+i+'"]');
  const old=svg.querySelector("#selHalo"); if(old)old.remove();
  if(!c)return;
  const h=document.createElementNS("http://www.w3.org/2000/svg","circle");
  h.setAttribute("id","selHalo");
  h.setAttribute("cx",c.getAttribute("cx"));
  h.setAttribute("cy",c.getAttribute("cy"));
  // 光の大きさ(2026-08-01谷川氏指示「点滅の円の範囲を大きくする」)。
  // 一律に大きくすると、日の間隔が狭い期間(3週間=16.7px・全期間=6.7px)で隣の日まで
  // 飲み込んで「どの日を選んだか」が分からなくなる。**1日あたりの幅(slot)に連動**させ、
  // 下限10・上限18でクランプする。実測: 直近7日(slot50)=18 / 3週間(16.7)=15 /
  // 全期間(6.7)=10.8。どれも従来(7〜9)より大きい。
  const rr=parseFloat(c.getAttribute("r"))||2;
  const halo=Math.max(10,Math.min(18,(curSlot||20)*0.42+8),rr+6);
  h.setAttribute("r",halo.toFixed(1));
  h.setAttribute("fill","url(#selGrad)");
  h.setAttribute("pointer-events","none");
  const first=svg.querySelector("circle");
  if(first) svg.insertBefore(h,first); else svg.appendChild(h);
}
document.getElementById("chart").addEventListener("click",e=>{
  const p=e.target.closest?e.target.closest("rect.hit"):null;
  if(!p)return;
  document.querySelectorAll("#mbody tr.hl").forEach(t=>t.classList.remove("hl"));
  const tr=document.getElementById("mr"+p.dataset.i);
  if(tr){tr.classList.add("hl");tr.scrollIntoView({block:"nearest"});}
  markSel(p.dataset.i);
});
// モーダルをピンチズーム倍率に追従させ常に適切な見かけサイズ・位置に保つ(visualViewport連動)。
// v4の「オーバーレイを可視領域サイズに縮める」方式は、縮めたオーバーレイ幅にカードが
// flex圧縮されて縦長1列になる不具合があった(2026-07-30谷川氏スクショ)。v5では
// オーバーレイは全面のまま、カードを可視領域の中心へ絶対配置し、レイアウト幅を
// 「可視幅(見かけpt)×0.94」で明示指定+scale(1/vv.scale)で見かけ寸法を一定化する。
// カード全体(見出し+グラフ+21日表+合計)を可視範囲へ収める(2026-07-30谷川氏指示)。
// まず表の文字と行間を段階的に詰め、それでも溢れる小さい画面ではグラフ高さを削る。
// 最小段でも収まらない場合はスクロール可(従来動作)にフォールバック=情報は落とさない。
// 段階は[グラフ高さ(viewBoxのCH), 表の文字px, 行padding]。上から試して収まった段で止める。
// 2026-07-30(谷川氏指示「台番を小さくした分はグラフへ」)でグラフ高さ優先の並びに変更=
// 表の文字は11px前後で据え置き、浮いた縦幅はCHの大きい段に留まることでグラフに回る。
// 最小段でも収まらない小画面ではスクロール可にフォールバック(情報は落とさない)。
// 2026-08-01: カード内のボタンを詰めて空けたぶんをグラフへ回すため、上に段を足した
// (fitCardは上から試して収まった段で止まるので、余裕がある窓ほど大きいCHが選ばれる)。
// 並びはCH(グラフ高さ)の降順。同じCHなら文字が大きいほうを先に試す。
// 2026-08-01: 表の行数が多い窓(3週間=25行/全期間=56行)は、CHを上げると表が入らず
// 小さい段に落ちてグラフが伸びなかった。行paddingを1pxに詰めた「グラフ大・行間だけ詰める」
// 段を各CHに足して、文字サイズを落とさずにグラフへ高さを回せるようにした。
const FITS=[[208,12.5,3],[196,12.5,3],[188,12.5,3],[176,12.5,3],[164,12,3],[152,11.5,2],
            [144,11.5,2],[144,10,1],[136,11,2],[136,10,1],[128,11,2],[128,10,1],
            [120,11,1.5],[120,10,1],[112,10.5,1.5],[112,10,1],[104,10,1.5],[104,10,1],
            [96,10,1],[88,9.5,1],[80,9,1],[72,8.5,0.5]];
let curDays=null,curLabels=null,curBase=0,curIntra=false;
// fitModalが決めたカードの上限高さ(px)を数値のまま共有する(2026-07-31)。
// 以前のfitCardは getComputedStyle(card).maxHeight を読んでいたが、
// (1)初回タップ時はまだCSSの既定値(92vh)が残っている/トランジション中は遷移前の値が返る、
// (2)iOS Safariのvh単位はツールバーを隠した「大きいビューポート」基準なので
//    visualViewport.height(実際に見えている高さ)より常に大きい、
// の二重の理由で「実際より100px以上大きい上限」を前提に文字サイズを選んでしまい、
// 3週間の集計行がカード外へはみ出していた(谷川氏の画面録画で確認)。
// 上限は計算した数値をそのまま渡す=描画状態に一切依存しない。
// 見出しが1行に収まる文字サイズへ詰める(2026-08-01)。既定13pxで入るならそのまま。
// 2026-08-01(谷川氏指示「日数が隠れた。文字を小さくして対応。大きさは4期間で統一」):
//  * **その台で出しうる4期間ぶんの見出しを全部測り、いちばん長いものに合わせる**。
//    表示中の文字列だけで決めると、期間を切り替えるたびに大きさが変わってしまう。
//  * 測るのは実際の要素そのもの(canvasの見積りではない)。端末のフォントで必要な
//    大きさが変わるので、固定値ではなく毎回実測で決める。
//  * 呼ぶのは**カードの幅が確定した後**(fitCardの最後)。テキストを入れた直後に測ると、
//    まだ広い幅で「入る」と判断してしまい、狭まった後に「…」で切れる(実機で発生)。
let titlePx=13;
function dayLabel(){
  let s=DAYG.md;
  DATA.labels.forEach(lb=>{ if(lb.split("(")[0]===DAYG.md) s=lb; });
  return s;
}
function titleCands(){
  if(!curDai)return [];
  const N=DATA.labels.length;
  const mk=n=>{
    const L=DATA.labels.slice(N-Math.min(n>0?n:N,N));
    return "台"+curDai+" "+L[0]+"〜"+L[L.length-1]+" "+L.length+"日";
  };
  const out=[mk(7),mk(NDAYS),mk(0)];
  if(DAYG.md) out.push("台"+curDai+" "+dayLabel()+" 単日");
  return out;
}
// 台番カードの中に「その台が島のどこか」を示す小さな島図を出す(2026-08-04・谷川氏指示
// 「台番タップしたらカードの中にも小さくレイアウトを崩さない程度に台の画像をつけて」)。
//
// 画像ファイルは持たない。**盤面に既に描いてある同じ機種のセルを縮小して写す**ので、
// 取得も更新も要らず、配色を変えても期間を変えても中身がそのままついてくる。
// 同じ機種かどうかは`data-lbl`(機種名ラベルのキー)で判断する=島図の囲いと同じ単位。
//
// **カードの高さを1pxも増やさないこと**。fitCardの余裕は実測1.8pxしか無く、
// 増やすとグラフのviewBoxが1段落ちる(2026-08-01につまみを4px動かして実際に落ちた)。
// そのため機種名の行(#msub)へ絶対配置で重ね、行の高さに一切関与させない。
// 機種名→筐体画像(kishu.json)。p-town(DMM)から集めたものを fetch_kishu_images.py が置く。
// **後回しで読む**(初回描画を遅らせない)。取れなくても画面は成立する=画像の無い機種は
// 島図の切り出し(下のbuildMini)がそのまま残る。
let KISHU=null, kishuP=null;
function kishuLoad(){
  if(kishuP) return kishuP;
  kishuP=fetch("kishu.json",{cache:"default"}).then(r=>r.ok?r.json():{})
    .then(j=>{KISHU=j||{};return KISHU;}).catch(()=>{KISHU={};return KISHU;});
  return kishuP;
}
// 画像の置き場所(2026-08-06新設)。筐体写真・打ち方の図・キャラの顔写真は毎日同じ物なので、
// **日付フォルダには複製しない**(atsuta 直下の1組を共有する)。
// 背景: 1日あたり約3,260ファイル・294MBを日付フォルダへ複製しており、配信物が
// 13,149ファイル/1,420MBまで膨らんで wrangler が600秒で時間切れ→固定URLが更新
// されなくなった(2026-08-06未明の実害)。Cloudflare Pages 無料プランは1サイト
// 20,000ファイルまでなので、放置すると2日で配信そのものが不可能になっていた。
// 履歴(atsuta/YYYY-MM-DD/)から開かれたときだけ1つ上を見る。
const ABASE=/\/\d{4}-\d{2}-\d{2}\/[^\/]*$/.test(location.pathname)?"../":"";
function asrc(u){
  const s=String(u||"");
  if(!s||/^(https?:)?\/\//.test(s)||s.charAt(0)==="/") return s;   // 絶対指定はそのまま
  return ABASE+s;
}
function kishuFile(name){
  const e=KISHU&&KISHU[name];
  return (e&&e.file)?asrc("kishu/"+e.file):null;
}
// 大きく見るとき用の写真(2026-08-04)。一覧に出すものは高さ320pxしか無く、
// 拡大すると粗い。大きい版が無い機種は今までどおり小さい方を出す。
function kishuLarge(name){
  const e=KISHU&&KISHU[name];
  return (e&&e.large)?asrc("kishu/"+e.large):kishuFile(name);
}

// 機種の要点スペック(2026-08-04・谷川氏指示「筐体画像をタップすると要点をまとめた
// スペックが出てくるようにして」)。中身は fetch_kishu_specs.py が p-town から集めたもの。
// **押されて初めて読む**(台を見るだけの人には要らないデータなので、初回表示を重くしない)。
let SPEC=null, specP=null;
function specLoad(){
  if(specP) return specP;
  specP=fetch("kishu_spec.json",{cache:"default"}).then(r=>r.ok?r.json():{})
    .then(j=>{SPEC=j||{};return SPEC;}).catch(()=>{SPEC={};return SPEC;});
  return specP;
}
// 口コミの全文(2026-08-06新設・谷川氏指示「全部見るボタン」)。
// スペックには最初に出す数件しか入っていない。全部は別ファイルにしてあり、
// **「全部見る」を押したときだけ読む**(スペック本体1.2MBをさらに重くしないため)。
// **日付フォルダには複製しない**(1.4MBあるので毎日積むと配信物が重くなる)。
// 画像と同じく atsuta 直下の1つを共有し、履歴から開かれたときは ../ を足して読む。
let VOICES=null, voicesP=null;
function voicesLoad(){
  if(voicesP) return voicesP;
  voicesP=fetch(ABASE+"kishu_voices.json",{cache:"default"}).then(r=>r.ok?r.json():{})
    .then(j=>{VOICES=j||{};return VOICES;}).catch(()=>{VOICES={};return VOICES;});
  return voicesP;
}
// 記念日にこの店で本当に出ていたか(build_kinenbi_result.py が作る)。
// スペックと同じで**押されて初めて読む**。無くても画面は成り立つ(由来だけ出る)。
let KINENBI=null, kinenbiP=null;
function kinenbiLoad(){
  if(kinenbiP) return kinenbiP;
  kinenbiP=fetch("kinenbi_result.json",{cache:"default"}).then(r=>r.ok?r.json():{})
    .then(j=>{KINENBI=j||{};return KINENBI;}).catch(()=>{KINENBI={};return KINENBI;});
  return kinenbiP;
}
// 開いた節を閉じて頭へ戻すボタン(2026-08-04・谷川氏指示「プラスボタン押して開いたら
// 下部の方に↑戻すボタンのようなものが欲しい」)。中身が長いと、閉じるために
// 見出しまで指で戻らないといけないのが手間だった。
const UPBTN='<button type="button" class="upbk" aria-label="この項目を閉じる">↑</button>';
function openSpec(mname){
  const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  let m=document.getElementById("specModal");
  if(!m){
    m=document.createElement("div"); m.id="specModal";
    m.innerHTML='<div id="specCard"></div>';
    document.body.appendChild(m);
    m.addEventListener("click",e=>{ if(e.target===m) m.style.display="none"; });
  }
  const card=document.getElementById("specCard");
  // 筐体画像の一覧(kishu.json)も一緒に待つ(2026-08-04・谷川氏報告「スロットもパチンコも
  // 筐体画像を開いた時にも左上に出して欲しい」)。スペックだけ待って描いていたため、
  // まだ KISHU が読めていないタイミングでは左上の画像が出ないままだった。
  Promise.all([specLoad(),kishuLoad(),kinenbiLoad()]).then(()=>{
    const sp=(SPEC&&SPEC[mname])||null;
    const img=kishuFile(mname);
    // 続けて書かれた説明文を、意味の切れ目で折り返す(2026-08-04・谷川氏指示
    // 「文章が続けて書いてある場合は視覚的に見やすいように表記すること。
    //   この文章に限らず全ての文章に適用」)。取り込んだ本文は元サイトの改行が
    // 空白1個に潰れているので、そこを手がかりに戻す。3つだけ:
    //   ・［見出し］は独立した行にする(打ち方の「［最初に狙う絵柄］」など)
    //   ・丸数字の箇条書きは番号ごとに改行する(天井の①②)
    //   ・句点のあとに空白が残っている所は、元が段落の切れ目なので改行する
    const fmt=v=>{
      let t=esc(v);
      t=t.replace(/\s*(［[^］]{1,60}］)\s*/g,"<br>$1<br>");
      // 丸数字ごと置換する(先読みだけだと \s* が空文字にも当たり <br> が二重に入る)。
      if(/①/.test(t)) t=t.replace(/\s*([②-⑨])/g,"<br>$1");
      // 中黒の箇条書きも1項目ずつ改行する(2026-08-06・谷川氏指示「リセット・で改行して
      // 表記。この法則は他の機種でも同様の表記の仕方をしてください」)。
      // **前に空白があるものだけ**が対象。機種名の中の中黒(ソードアート・オンライン、
      // コイン単価・MY等)で切ってしまわないようにするため。先頭の中黒は空白が無いので
      // そのまま=行頭に余計な空行を作らない。
      t=t.replace(/\s+(・)/g,"<br>$1");
      t=t.replace(/。\s+/g,"。<br>");
      // 見出しに全角カギ括弧を使う機種もある(カバネリの「最初に狙う絵柄」など)。
      // ただし本文中の引用にも同じ記号を使うので、**行頭にあるものだけ**見出しとみなす。
      t=t.replace(/(^|<br>)(「[^」]{1,24}」)\s*/g,"$1$2<br>");
      // 末尾に付く長い丸括弧の注記は行を分ける(2026-08-04・谷川氏指示「中途半端な
      // ところで行がかわっているので、文章を入れるときに改行を入れること」)。
      // 実害: 中古相場が「940,000円（スロット売れ筋 6位・前週-位／掲載2」で切れ、
      //       次の行が「件）」だけになっていた。
      // **末尾にあるものだけ**が対象。文の途中の括弧(天井の「（リール右下のゲーム数）」)
      // まで改行すると、かえって読みにくくなる。中身が12文字以上のものだけ分ける
      // (「（月）」「（24件）」「（愛知県:183店）」のような短い注記は同じ行でよい。
      //  2026-08-04・谷川氏指示「改行されない場合は設置店舗数のところ続けて表記で
      //  よい」。しきい値が8だと「（愛知県:183店）」まで別行になっていた)。
      t=t.replace(/^(.+?[^\s<>])\s*（([^（）]{12,})）\s*$/,"$1<br>（$2）");
      // 台帳側で意図して入れた改行も生かす
      t=t.replace(/\r?\n/g,"<br>");
      // 短い丸括弧の注記は途中で割らない(同じ指示)。「（設定変更後は1000G）」が
      // 「（設定変更後は」で改行され、次の行が「1000G）」になっていた。
      // 16文字までに限る(それより長いものを括らないのは、括ると行からはみ出すため)。
      t=t.replace(/（([^（）<>]{1,16})）/g,'<span class="nb">（$1）</span>');
      return t.replace(/(<br>)+/g,"<br>").replace(/^(<br>)+|(<br>)+$/g,"");
    };
    const row=(t,v)=>v?('<div class="srow"><span class="sk">'+t+'</span>'
      +'<span class="sv">'+fmt(v)+'</span></div>'):"";
    // 値の下に一言の説明を添える行(2026-08-04・谷川氏指示「MYとTYの説明を要約して」)。
    // 項目名の欄は5.2emしかなく、そこへ入れると5行に割れて読みにくいので値の側へ置く。
    const rowN=(t,v,note)=>v?('<div class="srow"><span class="sk">'+t+'</span>'
      +'<span class="sv">'+fmt(v)
      +(note?'<em class="snote">'+esc(note)+'</em>':"")+'</span></div>'):"";
    // 押すと開く画像つきの節(打ち方・ゲームフロー・リール配列)。
    // arr は [{t:見出し, b:本文, img:[パス]}]。画像だけ・本文だけでも出せる。
    // 解説の断片(表・文・画像)を1つ描く(2026-08-04・谷川氏指示「画面を入れる時は
    // その画面に対応するように、何の画面か分かるように画像を差し込むこと」)。
    // 取り込み側(fetch_kishu_specs.py の parse_block)が元ページの並び順のまま
    // 断片にしてくれるので、ここは順に描くだけでよい。画像には元の ［…］ を見出しに付ける。
    const block=p=>{
      if(p.tb&&p.tb.length)
        return '<table class="sptb">'+p.tb.map((r,i)=>'<tr>'
          +r.map(c=>i===0?'<th>'+esc(c)+'</th>':'<td>'+esc(c)+'</td>').join("")
          +'</tr>').join("")+'</table>';
      if(p.i)
        return '<figure class="ufig">'
          +(p.c?'<figcaption>'+esc(p.c)+'</figcaption>':"")
          +'<img src="'+esc(asrc(p.i))+'" alt="'+esc(p.c||"")
          +'" loading="lazy" decoding="async"></figure>';
      return p.t?'<div class="sbody">'+fmt(p.t)+'</div>':"";
    };
    // 画面名と設定示唆を画像1枚にまとめる(2026-08-09・谷川氏指示「『青山モータース』
    // 設定4以上、と画像に表記しないと分かりづらい。画像の上と下に分かれてると分かりづらい」)。
    // 元ページの並びは「『鋼鉄』/画像/『デフォルト。 『青山モータース』』/画像/…」で、
    // 1つの文に《前の画像の示唆》と《次の画像の名前》が同居している。これを解いて
    // 画像のキャプション(画像の上に出る)へ「名前 示唆」の形で載せる。
    const pairShots=ps=>{
      if(!ps||!ps.length) return ps;
      // 画像と「…」で終わるテキストが交互に並ぶ節だけが対象(他の節は素通し)
      const named=ps.filter(x=>x&&x.t&&/「[^」]+」\s*$/.test(x.t)).length;
      const imgs=ps.filter(x=>x&&x.i).length;
      if(!imgs||named<1) return ps;
      const out=[]; let pend="", lastImg=null;
      for(const x of ps){
        if(x&&x.i){
          out.push(lastImg={c:pend,i:x.i,_paired:!!pend}); pend="";
          continue;
        }
        if(x&&x.t&&!x.tb){
          const m=String(x.t).match(/^([\s\S]*?)\s*(「[^」]+」)\s*$/);
          const lead=m?m[1].trim():String(x.t).trim();
          // 直前の画像に示唆(「設定4以上。」等)を足す。長い文は解説なのでそのまま残す
          if(lastImg&&lead&&lead.length<=24){
            lastImg.c=(lastImg.c?lastImg.c+" ":"")+lead.replace(/[。．]\s*$/,"");
            lastImg=null;
          }else if(lead){
            out.push({t:lead});
          }
          if(m){ pend=m[2]; lastImg=null; }
          continue;
        }
        out.push(x); lastImg=null;
      }
      if(pend) out.push({t:pend});   // 最後に名前だけ余ったら捨てずに出す
      return out;
    };
    const sheet=(label,arr)=>{
      if(!arr||!arr.length) return "";
      const inner=arr.map(s=>
        (arr.length>1&&s.t?'<div class="uh">'+esc(s.t)+'</div>':"")
        // 新しい形(p=断片の並び)。取り直す前の古いデータ(b と img)も出せるよう残す。
        +(s.p ? pairShots(s.p).map(block).join("")
              : ((s.b?'<div class="sbody">'+fmt(s.b)+'</div>':"")
                +((s.img&&s.img.length)
                  ?'<div class="uimg">'+s.img.map(u=>'<img src="'+esc(asrc(u))
                    +'" alt="" loading="lazy" decoding="async">').join("")+'</div>':"")))
      ).join("");
      return '<details class="usheet"><summary>'+esc(label)+'</summary>'+inner+UPBTN
        +'</details>';
    };
    // 項目別評価の六角形(2026-08-04・谷川氏指示)。p-townの口コミは6項目ぶんあるので
    // 正六角形にちょうど収まる。5点満点を半径にとり、目盛りは1点きざみで薄く敷く。
    // 項目が6つでない機種でも角数を合わせて描けるようにしてある。
    const radar=ax=>{
      if(!ax||ax.length<3) return "";
      // 図の外に項目名を置くので、余白を広めに取る(狭いと「ループ＋上乗せ度」のような
      // 長い項目名が枠の外で切れる。2026-08-04に実際に切れた)。
      const n=ax.length, R=52, CX=115, CY=92, MAX=5;
      const pt=(i,r)=>{
        const a=-Math.PI/2+i*2*Math.PI/n;
        return [(CX+r*Math.cos(a)).toFixed(1),(CY+r*Math.sin(a)).toFixed(1)];
      };
      const ring=r=>Array.from({length:n},(_,i)=>pt(i,r).join(",")).join(" ");
      let g="";
      for(let k=1;k<=MAX;k++) g+='<polygon class="rg" points="'+ring(R*k/MAX)+'"/>';
      for(let i=0;i<n;i++) g+='<line class="rs" x1="'+CX+'" y1="'+CY+'" x2="'
        +pt(i,R)[0]+'" y2="'+pt(i,R)[1]+'"/>';
      const val=ax.map((x,i)=>pt(i,R*Math.max(0,Math.min(MAX,parseFloat(x.v)||0))/MAX));
      g+='<polygon class="rv" points="'+val.map(p=>p.join(",")).join(" ")+'"/>';
      val.forEach(p=>{ g+='<circle class="rd" cx="'+p[0]+'" cy="'+p[1]+'" r="2.4"/>'; });
      // 見出しは図の外側に置く。左右は寄せ方を変えないと角の文字が切れる。
      // 長い項目名は5文字ずつ2行までに折り返す(1行のままだと枠からはみ出す)。
      ax.forEach((x,i)=>{
        const p=pt(i,R+11), a=-Math.PI/2+i*2*Math.PI/n, c=Math.cos(a);
        const an=c>0.3?"start":(c<-0.3?"end":"middle");
        const t=String(x.t||"");
        const ls=t.length>5?[t.slice(0,5),t.slice(5,11)]:[t];
        const y0=parseFloat(p[1])-(ls.length>1?4:0);
        ls.forEach((s,k)=>{
          g+='<text class="rt" x="'+p[0]+'" y="'+(y0+k*8).toFixed(1)
            +'" text-anchor="'+an+'">'+esc(s)+'</text>';
        });
        g+='<text class="rn" x="'+p[0]+'" y="'+(y0+ls.length*8+1).toFixed(1)
          +'" text-anchor="'+an+'">'+esc(x.v)+'</text>';
      });
      return '<div class="sradar"><svg viewBox="0 0 230 196" role="img" '
        +'aria-label="項目別の評価">'+g+'</svg></div>';
    };
    let body="";
    if(!sp){
      body='<div class="snone">この機種の情報はまだありません</div>';
    }else{
      body=row("メーカー",sp.maker)+row("型式",sp.kata)+row("タイプ",sp.type)
          +row("純増",sp.zoue)+row("機械割",sp.wari)
          // 遊技未来から取った数字(2026-08-04・谷川氏提示)。p-town には項目が無い。
          +row("ベース",sp.base)+row("コイン単価",sp.coin)
          // MY・TYは業界用語なので、意味を1行添える(2026-08-04・谷川氏指示
          // 「MYとTYの説明を要約して入れて」)。裏取りは2つの独立ソース:
          //  MY=「一番吸い込んだところから一番出たところまでの幅」(P-Summa)
          //     =波の荒さを示す数値
          //  TY=「大当たり1回あたりの出玉」の平均(なな徹)
          +rowN("MY",sp.my,"一番ハマった所から一番出た所までの差枚の幅。"
                +"出玉の荒さの目安")
          +rowN("TY",sp.ty,"AT(大当り)1回あたりの平均獲得枚数")
          +row("販売台数",sp.sold)
          // 設置店舗数(2026-08-04・谷川氏指示)。パチンコは販売台数が公表されて
          // いないので、どれだけ広く置かれた機種かの目安をこれで見る。
          +(sp.pw&&sp.pw.halls
            ?row("設置店舗数",sp.pw.halls.toLocaleString()+"店"
                 +(sp.pw.aichi!=null?"（愛知県:"+sp.pw.aichi.toLocaleString()+"店）":""))
            :"")
          // 中古機の相場と売れ筋の順位(2026-08-04・谷川氏指示)。TOP30に入った機種だけ。
          +(sp.chuko?row("中古相場",sp.chuko.price+"（"+sp.chuko.kind+"売れ筋 "
             +sp.chuko.rank+"位"+(sp.chuko.prev?"・前週"+sp.chuko.prev+"位":"")
             +"／掲載"+(sp.chuko.cnt||"-")+"）"):"")
          // パチンコの項目(2026-08-04・谷川氏指示「パチンコスペックは初当たり確率とか
          // 振り分けなどを追加」)。スロットには無い項目なので、値があるときだけ出る。
          +row("大当り確率",sp.ohatari)+row("確変突入率",sp.kakuhen)
          +row("ラウンド",sp.round)+row("大当り出玉",sp.dedama)
          +row("電サポ",sp.densapo)+row("賞球",sp.shokyu)
          // ここに販売台数・コイン単価・MY・TYを重ねて書いていたため、同じ項目が
          // 2回出ていた(2026-08-04・谷川氏報告)。上の1か所にまとめてある。
          +row("導入開始",sp.start)+row("天井",sp.ceil_cond)
          +row("天井恩恵",sp.ceil_gain)+row("リセット",sp.reset)
          +(sp.rate?row("評価",sp.rate+" / 5（"+(sp.rateN||0)+"件）"):"")
          // 項目別評価の六角形は「評価」のすぐ下に置く(2026-08-04・谷川氏指示
          // 「レーダーは評価の下に配置直し」)。同じ「評価」の話が離れていると読みにくい。
          +radar(sp.axes)
          +((sp.about&&sp.about.length)
            ?'<div class="sabout"><ul>'
              +sp.about.map(t=>"<li>"+fmt(t)+"</li>").join("")+"</ul></div>":"")
          // **どの機種にもある共通の項目を先に並べる**(2026-08-05・谷川氏指示
          // 「基本の共通項目の並び替え」)。機種ごとの解説(表モード概要・GG概要など)は
          // 名前も数も機種でバラバラなので、先に共通項目を置いた方が迷わない。
          // 並び順の指示: 打ち方 → リール配列・配当表 → ゲームフロー
          //               → 設定別の初当り確率 → 設定判別。
          +sheet("打ち方",sp.uchi)
          // **リール配列と配当表は1つにまとめる**(同じ指示)。どちらも「リールの絵柄」の
          // 話で、別々のボタンにすると押す回数が増えるだけだった。
          // 中に見出し(.uh)を出すため、まとめるときに名前を付ける。
          +sheet("リール配列・配当表",
                 [].concat((sp.reel||[]).map(s=>Object.assign({},s,{t:"リール配列"})),
                           (sp.haitou||[]).map(s=>Object.assign({},s,{t:"配当表"}))))
          // ゲームフロー図(2026-08-04・谷川氏提示の一撃から)。
          // p-town にも遊技未来にも無い(遊技未来の【ゲームフロー】は有料会員限定)。
          +sheet("ゲームフロー",sp.flow)
          // 設定別の初当り確率(2026-08-04・谷川氏指示「ボーナス、AT確率も追加」)。
          // p-town には項目が無く、遊技未来から取っている。表で持っているのでそのまま出す。
          // 列の意味は機種ごとに違う(「初当り確率/ST確率」「CZ確率/AT確率」など)ので、
          // 取り込み側が持ってきた見出し(cols)をそのまま使う。
          +((sp.settei&&sp.settei.length)
            ?sheet("設定別の初当り確率",[{p:[{tb:[["設定"].concat(
                 (sp.cols&&sp.cols.length>=2)?sp.cols:["初当り","AT/ST","出玉率"])]
               .concat(sp.settei.map(x=>[x.s,x.h||"-",x.a||"-",x.r||"-"]))}]}])
            :"")
          // 設定判別は引用元が2つあるので、**どちらも見出しに出どころを書く**
          // (2026-08-06・谷川氏指示「元々の設定判別はどこから引用しているかも
          //  設定判別(引用元)にしてください」)。名前は実物のページの og:site_name で
          // 確かめたもの: p-town=「DMMぱちタウン」/ chonborista.com=「ちょんぼりすた」。
          +sheet("設定判別（DMMぱちタウン）",sp.setsu)
          // p-town にはトロフィー・終了画面・獲得枚数表示の表がほとんど無いので、
          // そこが厚いちょんぼりすたからも取る。中の最後の行に更新日つきの出どころが入る。
          +((sp.cb&&sp.cb.length)?sheet("設定判別（ちょんぼりすた）",sp.cb):"")
          // AT/ST/ボーナス・上位モードの解説(2026-08-04・谷川氏指示)。
          // 機種ごとに名前が違う節。縦に長くなるので、見出しだけ並べて押したら開く形にする。
          +((sp.secs&&sp.secs.length)
            ?'<div class="ssecs">'+sp.secs.map(s=>
               '<details><summary>'+esc(s.t)+'</summary>'
               +(s.p?s.p.map(block).join("")
                    :'<div class="sbody">'+fmt(s.b)+'</div>')
               +UPBTN+'</details>').join("")+'</div>':"")
          // 利用者の評価と口コミ(2026-08-04・谷川氏指示「下部の方に口コミも追加」)
          // キャラクターの誕生日(2026-08-04・谷川氏指示)。誕生日示唆のある機種で使う
          // キャラクターの誕生日と、その機種に関係のある業界の記念日
          // (2026-08-04・谷川氏指示「誕生日欄のところに備考でメーカー系など、
          //  関係ある機種だけ反映」)。記念日はメーカーか機種名が一致した物だけ入っている。
          +((sp.bd&&sp.bd.length)||(sp.anni&&sp.anni.length)
            ?'<div class="sbd">'
             +((sp.bd&&sp.bd.length)
               ?'<div class="svhead">キャラクターの誕生日</div><div class="sbdw">'
                // 顔写真つき(2026-08-04・谷川氏指示「そのキャラの画像を適切な大きさで
                // 載せてくださいキャラ名のところに」)。写真が無いキャラは名前だけ出す。
                +sp.bd.map(b=>'<span class="sbdi'+(b.i?" hasimg":"")+'">'
                  +(b.i?'<img src="'+esc(asrc(b.i))+'" alt="" loading="lazy" decoding="async">':"")
                  +'<span class="sbdt"><b>'+esc(b.d)+'</b>'+esc(b.n)+'</span></span>')
                  .join("")+'</div>':"")
             // 押すと由来が読める(2026-08-04・谷川氏指示「記念日をタッチしたら
             // その記念日の説明が見られるように」)。説明の無いものは押しても開かない。
             +((sp.anni&&sp.anni.length)
               ?'<div class="svhead sanhd">この機種に関係する記念日</div><div>'
                +sp.anni.map((a,i)=>(a.w
                  ?'<button type="button" class="sbdi sanni has-w" data-ai="'+i+'">'
                   +'<b>'+esc(a.d)+'</b>'+esc(a.n)+'</button>'
                  :'<span class="sbdi sanni"><b>'+esc(a.d)+'</b>'+esc(a.n)+'</span>'))
                  .join("")+'<div class="sanniw" hidden></div></div>':"")
             +'</div>':"")
          // 口コミ(2026-08-06に作り直し・谷川氏指示「口コミは口コミ数追加」
          // 「良い評価の口コミと悪い評価の口コミを適切な数のせる」「全部見るボタンを
          //   口コミの文字の右側辺りに作る」)。
          // 最初に出す数件は取得側(pick_voices)が良い/悪いの実際の割合で選んでいる。
          // 全部は kishu_voices.json にあり、**押されて初めて読む**(スペックと同じ考え)。
          +((sp.voices&&sp.voices.length)
            ?'<div class="svoice" data-vk="'+esc(mname)+'">'
             +'<div class="svhead">口コミ'
             +'<span class="svn">'+(sp.vN||sp.voices.length)+'件</span>'
             +((sp.vN&&sp.vN>sp.voices.length)
               ?'<button type="button" class="svall">全部見る</button>':"")
             +'</div><ul>'
             +sp.voices.map(v=>'<li>'+(v.p?'<span class="svp">'+esc(v.p)+'</span>':"")
               +fmt(v.b)+'</li>').join("")+'</ul></div>':"")
          // 数字の出どころ(手で調べた項目があるとき)。裏取りできた元を必ず添える
          +(sp.src?'<div class="ssrc">コイン単価・MY等の出どころ: '+esc(sp.src)+'</div>':"");
    }
    card.innerHTML='<button class="sclose" aria-label="閉じる">✕ 閉じる</button>'
      +'<div class="shead">'+(img?'<img src="'+esc(img)+'" alt="">':"")
      +'<div class="sname">'+esc(mname)+'</div></div>'+body;
    const vv=window.visualViewport;
    card.style.top=(vv?Math.max(0,vv.offsetTop)+10:10)+"px";
    const cs=getComputedStyle(card);
    const pad=(parseFloat(cs.paddingTop)||0)+(parseFloat(cs.paddingBottom)||0);
    card.style.maxHeight=Math.max(200,(vv?vv.height:window.innerHeight)-20-pad)+"px";
    card.querySelector(".sclose").addEventListener("click",()=>{ m.style.display="none"; });
    // 左上の筐体写真をもう一度押すと大きく見られる(2026-08-04・谷川氏指示
    // 「左上の機種筐体画像をさらにタップしたら筐体画像がアップで大きく出るように」)。
    // 一覧の写真は高さ64pxしかなく、盤面のデザインまでは読めないため。
    const hi=card.querySelector(".shead img");
    if(hi){
      hi.setAttribute("role","button");
      hi.setAttribute("tabindex","0");
      hi.setAttribute("aria-label","筐体の写真を大きく見る");
      hi.addEventListener("click",()=>openPhoto(kishuLarge(mname)||hi.src,mname));
    }
    // 節の中の図(ゲームフロー・リール配列・配当表・打ち方)も押すと大きく見られる
    // (2026-08-04)。カード幅では文字が小さすぎて読めないため。カードに1つだけ
    // リスナーを置いて委譲する(図の数だけ付けない)。
    // **カードは使い回される**ので、付けるのは1回だけにする(2026-08-05修正。
    // 開くたびに足していたため、10機種見たあとは1回の指で10回開く状態になっていた)。
    if(!card.dataset.imgTap){ card.dataset.imgTap="1";
    card.addEventListener("click",e=>{
      const im=e.target.closest(".usheet img, .ufig img, .uimg img");
      if(!im) return;
      e.stopPropagation();
      const cap=(im.closest(".usheet")||{}).querySelector
        ? (im.closest(".usheet").querySelector("summary")||{}).textContent||"" : "";
      // **機種名はその場で読む**(1回しか付けないリスナーなので、開いたときの
      // 名前を閉じ込めると、次に別の機種を開いても前の名前が出る)
      const nm=(card.querySelector(".sname")||{}).textContent||"";
      openPhoto(im.src,(cap?cap+" ／ ":"")+nm);
    });
    }
    // 「全部見る」(2026-08-06・谷川氏指示)。最初は良い/悪いの割合どおりに数件だけ
    // 出しているので、全部読みたいときの入口を口コミの見出しの右に置く。
    // **カードは使い回される**ので、リスナーは1回だけ付けて押された時点の中身を読む
    // (図のタップと同じ作法。開くたびに足すと押した回数だけ反応してしまう)。
    if(!card.dataset.vTap){ card.dataset.vTap="1";
    card.addEventListener("click",e=>{
      const b=e.target.closest(".svall");
      if(!b) return;
      e.stopPropagation();
      const box=b.closest(".svoice"), ul=box?box.querySelector("ul"):null;
      if(!box||!ul) return;
      const li=v=>'<li>'+(v.p?'<span class="svp">'+esc(v.p)+'</span>':"")+fmt(v.b)+'</li>';
      if(box.dataset.open==="1"){                 // たたむ
        box.dataset.open="0"; b.textContent="全部見る";
        if(box.dataset.few) ul.innerHTML=box.dataset.few;
        return;
      }
      b.disabled=true; b.textContent="読み込み中";
      voicesLoad().then(all=>{
        const vs=(all&&all[box.dataset.vk])||[];
        b.disabled=false;
        if(!vs.length){ b.textContent="全部見る";
                        showToast("口コミを読み込めませんでした",2400); return; }
        box.dataset.few=ul.innerHTML;             // たたむときに戻すため取っておく
        ul.innerHTML=vs.map(li).join("");
        box.dataset.open="1"; b.textContent="たたむ";
      }).catch(()=>{ b.disabled=false; b.textContent="全部見る"; });
    });
    }
    // 記念日を押すと、その下に由来を出す(もう一度押すと閉じる)。
    // 別の画面を重ねず同じ場所に開くので、どの記念日の話か分かる。
    const wbox=card.querySelector(".sanniw");
    card.querySelectorAll(".sanni.has-w").forEach(b=>{
      b.addEventListener("click",()=>{
        const a=(sp&&sp.anni)?sp.anni[+b.dataset.ai]:null;
        if(!a||!wbox) return;
        const same=b.classList.contains("is-on");
        card.querySelectorAll(".sanni.has-w").forEach(x=>x.classList.remove("is-on"));
        if(same){ wbox.hidden=true; return; }
        b.classList.add("is-on");
        // 記念日に本当に出ていたか(2026-08-04・谷川氏の着想「記念日を特定日の
        // 分析に使う」)。この店の実データで確かめた値を由来の下に添える。
        // **平均だけでなく中央値とプラス台率も出す**(1台の大勝ちで平均は跳ねる。
        // 実測: 7/11 大都技研の日は平均+2,546枚だが中央値は+200枚)。
        const kr=(KINENBI&&KINENBI[a.d+"|"+a.n])||null;
        const sgn=v=>(v>0?"+":"")+Number(v).toLocaleString();
        wbox.innerHTML='<div class="sanniwt"><b>'+esc(a.d)+'</b>'+esc(a.n)+'</div>'
          +'<div class="sanniwb">'+esc(a.w)+'</div>'
          +(kr?'<div class="sanniwr"><div class="sanniwrh">'+esc(kr.lab)
             +' この店の実績（該当'+kr.dai+'台）</div>'
             +'<div>当日の平均差枚 '+sgn(kr.day)+'枚'
             +'（中央値 '+sgn(kr.med)+'枚・プラス台 '+kr.plus+'%）</div>'
             +'<div>同じ台の平常時 '+(kr.base==null?"—":sgn(kr.base)+'枚')
             +' ／ その日の全館 '+sgn(kr.hall)+'枚</div>'
             +'<div class="sanniwrd">全館との差 '+sgn(kr.diff)+'枚</div></div>':"")
          +(a.src?'<div class="sanniws">出どころ: '+esc(a.src)+'</div>':"");
        wbox.hidden=false;
      });
    });
    // 節の末尾の「↑」で、その節を閉じて見出しの位置まで戻す(2026-08-04・谷川氏指示)。
    // 個々のボタンに付けず、カードに1つだけ置いて拾う(節は機種ごとに数が変わるため)。
    card.addEventListener("click",e=>{
      const b=e.target.closest(".upbk");
      if(!b) return;
      const d=b.closest("details");
      if(!d) return;
      d.open=false;
      d.scrollIntoView({block:"nearest"});
    });
  });
  m.style.display="block";
}

// 写真を画面いっぱいに出す(2026-08-04新設・谷川氏指示)。スペック画面の筐体写真から呼ぶ。
// **入れ物はその場で作る**(shell.html を触らずに済むので、過去の日付フォルダの
// 画面も新しい app.js で同じように動く)。どこを押しても閉じる=戻り方に迷わせない。
function openPhoto(src,cap){
  if(!src) return;
  let ov=document.getElementById("photoOv");
  if(!ov){
    ov=document.createElement("div");
    ov.id="photoOv";
    ov.setAttribute("role","dialog");
    ov.setAttribute("aria-label","写真を大きく表示");
    ov.innerHTML='<button class="pvclose" type="button">✕ 閉じる</button>'
      +'<img id="photoImg" alt=""><div class="pvcap"></div>'
      +'<div class="pvhint">画面のどこかを押すと戻ります</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click",()=>{ ov.hidden=true; });
  }
  const im=ov.querySelector("#photoImg");
  // 縦長の図(ゲームフロー)は幅いっぱいにして縦へ流す。**読み込んでから縦横比を見る**
  // (src を入れた直後は naturalHeight が 0 なので、その場で判定すると必ず外れる)。
  ov.classList.remove("tall");
  const fit=()=>{ if(im.naturalWidth&&im.naturalHeight/im.naturalWidth>1.6)
                    ov.classList.add("tall"); };
  im.onload=fit;
  im.src=src;
  if(im.complete) fit();
  ov.scrollTop=0;
  ov.querySelector(".pvcap").textContent=cap||"";
  ov.hidden=false;
}

function buildMini(dai,mname){
  const host=document.querySelector("#card h2");
  const old=document.getElementById("mini");
  if(old) old.remove();
  if(!host||!mname) return;
  // **見出し行(h2)の左端へ絶対配置**(2026-08-04の4回目・これが最終形)。
  // 置き場所を3回間違えたので理由を残す:
  //   1回目 #msub へ絶対配置 → 見出しのボタンはfloatでh2の高さに数えられておらず
  //         下の行へせり出しているため、写真が「✕ 閉じる」に重なった。
  //   2回目 h2 のfloat帯へインラインで → 重なりは消えたが**見出しと横幅を取り合い**、
  //         見出しが4.7〜7.3pxはみ出した(fitTitleを呼び直しても収まらない)。
  //   3回目 #msub の先頭へインラインで → floatの帯がこの行まで伸びているため写真が
  //         右上へ押し出され、見出しの日付が「…」で切れた(本番でのみ再現)。
  //         padding/text-indentで逃がすと今度は長い機種名が2行に割れた。
  // h2 の padding-left を写真ぶん広げてそこへ絶対配置すれば、#mtitle(BFC)の幅が
  // 自動で減り fitTitle が文字を詰める=見出しの幅も行の高さも壊さない。
  // 高さを行より大きくしないこと(fitCardの余裕は実測1.8pxしか無い)。
  kishuLoad().then(()=>{
    const f=kishuFile(mname);
    if(!f) return;                       // 写真の無い機種は何も出さない(枠だけ残さない)
    if(document.getElementById("mini")) return;
    const box=document.createElement("span");
    box.id="mini";
    const im=document.createElement("img");
    im.src=f; im.alt=""; im.decoding="async";
    im.onerror=()=>box.remove();
    box.appendChild(im);
    // 押すと要点スペックを出す(2026-08-04・谷川氏指示)。
    // つまみのドラッグと取り合わないよう、押した指が動いていないときだけ開く。
    box.setAttribute("role","button");
    box.setAttribute("aria-label","この機種の要点を見る");
    let sx=0,sy=0,moved=false;
    box.addEventListener("pointerdown",e=>{ sx=e.clientX; sy=e.clientY; moved=false; });
    box.addEventListener("pointermove",e=>{
      if(Math.abs(e.clientX-sx)>8||Math.abs(e.clientY-sy)>8) moved=true; });
    box.addEventListener("click",e=>{
      e.stopPropagation();
      if(!moved) openSpec(mname);
    });
    host.insertBefore(box, host.firstChild);
  });
}

// 文字の実幅を測るための隠し要素(2026-08-01)。**`#mtitle`のscrollWidthで測ってはいけない**
// (実機で「日数が隠れたまま」だった原因)。`text-overflow:ellipsis`が効いている要素の
// scrollWidthは、省略後の幅=clientWidthと同じ値を返すことがあり、その場合「入っている」と
// 誤判定して一度も縮まない。省略の影響を受けない別要素で測る。
let mspan=null;
function measIn(el,s,px){
  if(!mspan){
    mspan=document.createElement("span");
    mspan.style.cssText="position:absolute;left:-9999px;top:-9999px;"
      +"white-space:nowrap;visibility:hidden;pointer-events:none;";
    ((el&&el.parentElement)||document.body).appendChild(mspan);
  }
  const cs=getComputedStyle(el);
  mspan.style.fontFamily=cs.fontFamily;
  mspan.style.fontWeight=cs.fontWeight;
  mspan.style.letterSpacing=cs.letterSpacing;
  mspan.style.fontSize=px+"px";
  mspan.textContent=s;
  return mspan.getBoundingClientRect().width;
}
// 見出し用(検証スクリプトからも呼ぶ)。
function measTitle(s,px){ return measIn(document.getElementById("mtitle"),s,px); }
// 「当日最高 … ／ 最終 …（底打のため真値補正）」の行も1行に収める(2026-08-01谷川氏指示
// 「一行で収まらない場合は文字を小さくして調整」)。折り返すとカードが1行ぶん高くなり、
// fitCardがグラフを1段小さくしてしまう。測り方は見出しと同じで、隠し要素の実測。
function fitCap(){
  const c=document.getElementById("mcap");
  if(!c||!c.textContent)return;
  const w=c.clientWidth;
  if(!w)return;
  const pad=parseFloat(getComputedStyle(c).paddingLeft)
           +parseFloat(getComputedStyle(c).paddingRight);
  let px=11;
  c.style.fontSize="";
  while(px>8 && measIn(c,c.textContent,px)>w-pad-2) px-=0.5;
  c.style.fontSize=(px<11)?(px+"px"):"";
}
function fitTitle(){
  const t=document.getElementById("mtitle");
  if(!t||!curDai)return;
  const cands=titleCands();
  if(!cands.length)return;
  // 使える幅。#mtitleはBFC(display:block+overflow:hidden)なので、この幅は
  // 文字サイズに左右されない=縮めても変わらない(測り直す必要がない)。
  const avail=t.clientWidth;
  if(!avail)return;
  let px=13;
  // 余白3pxを見ておく(端末のフォント解決の誤差でギリギリ切れるのを避ける)
  while(px>8 && Math.max.apply(null,cands.map(s=>measTitle(s,px)))>avail-3) px-=0.5;
  t.style.fontSize=(px<13)?(px+"px"):"";
  titlePx=px;
  fitCap();
}
let cardMH=0,lastFitMH=0;
function fitCard(){
  const card=document.getElementById("card");
  const mh=cardMH||parseFloat(getComputedStyle(card).maxHeight);
  if(!mh||!isFinite(mh)||!curDays)return;
  lastFitMH=mh;
  for(const f of FITS){
    document.getElementById("chart").innerHTML=drawChart(curDays,curLabels,f[0],curBase,curIntra);
    card.style.setProperty("--tfs",f[1]+"px");
    card.style.setProperty("--tpad",f[2]+"px");
    // 端末ごとのフォント差・ツールバー分の測定ズレで溢れないよう余裕を持たせる
    // (2026-07-30実機報告「3週間1日平均が見切れる」を受け6px→20px、さらに同日夜の
    // 再報告を受け20px→32pxへ拡大。合わせて最小段[72,8.5,0.5]も追加し、より厳しい
    // 画面でも文字縮小だけで収まる余地を広げた)。
    if(card.scrollHeight<=mh-32){ fitTitle(); return; }
  }
  // どの段でも収まらない場合(2026-07-31・グラフ期間「全期間」=52行の表がこれに当たる)は、
  // 8.5pxまで縮めても結局スクロールになるだけで読めなくなる。読める大きさ(11px相当の段)へ
  // 戻してスクロールに委ねる。縮小は「スクロールを避けられるとき」だけ意味がある。
  const f=FITS[4];   // [164,12,3]=読める大きさの中位段(インデックスは並びを変えたら要確認)
  document.getElementById("chart").innerHTML=drawChart(curDays,curLabels,f[0],curBase,curIntra);
  document.getElementById("card").style.setProperty("--tfs",f[1]+"px");
  document.getElementById("card").style.setProperty("--tpad",f[2]+"px");
  fitTitle();
}
// カード(モーダル)を可視領域(visualViewport)の中心へ、見かけの拡大率を打ち消して配置する
// 共通ロジック(2026-07-31・絞り込みパネル追加に伴いfitModalから汎用関数へ切り出し)。
// 台番タップの#cardと絞り込みの#filterCardは中身は別物だが「ピンチズームしていても
// 適切な実寸で開く」という要件は同じなので、位置/サイズ計算は1箇所にまとめて再利用する。
// sheet=true(台番カード・2026-08-01のシート化)のときは、中央ではなく
// 「可視領域の上端に幅いっぱいで貼り付ける」。scaleの原点をtop leftにしてあるので、
// ピンチズームの打ち消し(1/vv.scale)を掛けても上端と左端は動かない。
// レイアウトビューポートの高さ(=position:fixedの基準になる高さ)。
// window.innerHeightはiOSでは「見えている高さ」を返すので、fixedの基準としては使えない。
function layoutH(){
  const d=document.documentElement;
  return (d&&d.clientHeight)?d.clientHeight:window.innerHeight;
}
function positionOverlayCard(card,maxW,sheet){
  const vv=window.visualViewport;
  if(!vv||!vv.width||!vv.height){
    if(sheet){
      card.style.left="0px"; card.style.top="0px"; card.style.bottom="auto";
      card.style.width=""; if(!card.classList.contains("dragging")) card.style.transform="";
      const mh0=window.innerHeight*0.90;
      card.style.maxHeight=mh0+"px"; return mh0;
    }
    card.style.left="50%"; card.style.top="50%";
    card.style.transform="translate(-50%,-50%)";
    // visualViewport非対応環境でもfitCardが数値の上限を使えるようにする
    // (CSSの92vhを読ませない=vh基準のズレを持ち込まない)。
    const mh=window.innerHeight*0.92;
    card.style.maxHeight=mh+"px"; return mh;
  }
  if(sheet){
    card.style.left=vv.offsetLeft+"px";
    card.style.bottom="auto";
    // #modalは position:fixed inset:0 =「レイアウトビューポート」全体。その上端から
    // 可視領域の上端までの距離が、そのまま top になる(=vv.offsetTop)。
    // 2026-08-01(谷川氏指示「台番タップ時のカードが下に配置されているのを上に配置」)で
    // 下端貼り付きから上端貼り付きへ変更した。
    // 下端のときは bottom = layoutH()-(offsetTop+height) という引き算が必要で、そこに
    // window.innerHeight を使って事故を起こしていた(2026-07-31修正済み。iOS Safariの
    // innerHeight は「見えている高さ(visual viewport)」を返す仕様で、レイアウト
    // ビューポートの高さではない。quirksmodeのviewport対応表でiPhoneはFull support /
    // MDNも「ピンチズームでinnerWidth・innerHeightが変わるブラウザがある」と明記。
    // そのためiOSでは bottom = vv.height-(offsetTop+vv.height) = -offsetTop → 0に
    // クランプされ、寄せた距離のぶんシートが可視領域の外へ押し出されていた)。
    // 上端は可視領域の原点そのものなので、この引き算自体が不要になり、レイアウト
    // ビューポート高さへの依存が消える=同じ種類の事故が原理的に起きなくなる。
    card.style.top=Math.max(0,vv.offsetTop)+"px";
    card.style.width=(vv.width*vv.scale)+"px";
    // ドラッグ中はJSがtransformを握っているので上書きしない。
    if(!card.classList.contains("dragging")) card.style.transform=`scale(${1/vv.scale})`;
    // 中央配置のときの92%より少し低い90%にする。下に島図と下部ツールバーが残り、
    // 「どの台を見ているか」と期間切替が視界から消えない。
    const mh1=vv.height*vv.scale*0.90;
    card.style.maxHeight=mh1+"px";
    return mh1;
  }
  card.style.left=(vv.offsetLeft+vv.width/2)+"px";
  card.style.top=(vv.offsetTop+vv.height/2)+"px";
  card.style.transform=`translate(-50%,-50%) scale(${1/vv.scale})`;
  card.style.width=Math.min(maxW, vv.width*vv.scale*0.94)+"px";
  const mh=vv.height*vv.scale*0.92;
  card.style.maxHeight=mh+"px";
  return mh;
}
function fitModal(){ cardMH=positionOverlayCard(document.getElementById("card"),390,true); }
// 絞り込みパネル(2026-07-31谷川氏指示「台番タップした時と同じようにズームしていても
// 絞り込みタップ時に絞り込み画面が適切な大きさで開くようにする」)。#cardと同じ仕組みで
// #filterCardも可視領域基準に配置する。フォーム内容は固定でfitCardのような文字サイズ
// 段階縮小は不要(収まらなければCSSのoverflow:autoでスクロールに任せる)。
function fitFilterModal(){ positionOverlayCard(document.getElementById("filterCard"),340); }
// 検索パネル(2026-08-01新設)も同じ扱い。
function fitSearchModal(){ positionOverlayCard(document.getElementById("searchCard"),340); }
// 2026-07-30(他ユーザー報告・実際の画面録画で確認): 台番タップ後にモーダルが「ブルブル」する
// 不具合の対策(第2版)。第1弾(fitCardのみ150msデバウンス)適用後も報告があり、録画を1コマずつ
// (30fps)差分解析したところ、fitModal(位置/サイズ追従)を「毎フレーム即時追従」させていたのが
// 真因と判明。iOS Safariはスクロール/タップに応じてツールバー(URLバー)が展開・収縮する際、
// visualViewportのheight/offsetTopを間引きなしで連続的に変化させる(~0.5〜1秒間)。この間
// fitModalが毎フレーム新しい値でカードのleft/top/width/maxHeightを書き換え続けるため、
// カードが繰り返し伸縮・移動して見える=「ブルブル」。
// 対策: fitModal/fitCard(モーダル表示中のみ)を150msトレーリングデバウンスに統合し、
// イベント連発が完全に収まってから最後の1回だけ位置/サイズを確定する
// (録画解析: 33フレーム連続で大きな差分が続く区間を確認→この一本化で解消する設計)。
// 合わせて#cardにtransitionを付け、デバウンス後の1回の補正も滑らかに見えるようにした。
let vvTimer=null, vvLate=[];
function onVVChange(){
  // バーの位置決めは**即時**に行う(2026-08-08・谷川氏報告「ズームすると真ん中にきて島図と
  // 重なってしまう」)。以前は下のデバウンス(150ms)の中でだけ呼んでいたため、指を離した瞬間に
  // iOSが最後の scroll/resize を出さない端末では、ピンチ途中の可視領域(scaleも offsetTop も
  // 最終値と違う)で計算した bottom のまま固まり、バーが島図の中段に浮いて見えていた。
  // fitTabbarは位置を書くだけでモーダルのような伸縮のチラつきが無いので即時実行してよい。
  fitTabbar();
  // 指を離した後に可視領域が遅れて確定する端末があるので、少し後にもう一度測り直す
  // (内訳パネルの開閉で既に使っている手当てと同じ考え方)。
  vvLate.forEach(clearTimeout);
  vvLate=[250,600].map(ms=>setTimeout(fitTabbar,ms));
  clearTimeout(vvTimer);
  vvTimer=setTimeout(()=>{
    // ツールバーはモーダルの開閉に関係なく常に追従させる(島図を見ている間も出ている)。
    fitTabbar();
    if(document.getElementById("modal").style.display==="block"){ fitModal(); fitCard(); }
    // 絞り込みパネルも同じ仕組みで追従させる(2026-07-31新設)。
    if(document.getElementById("filterModal").style.display==="block"){ fitFilterModal(); }
    if(document.getElementById("searchModal").style.display==="block"){ fitSearchModal(); }
  },150);
}
if(window.visualViewport){
  window.visualViewport.addEventListener("resize",onVVChange);
  window.visualViewport.addEventListener("scroll",onVVChange);
}
// 指を離した瞬間にも必ず測り直す(2026-08-08)。ピンチの終わりで visualViewport の
// scroll/resize が飛ばない端末があり、そこだけを頼りにするとバーが中段に取り残される。
// touchend は必ず来るので、これを最後の砦にする。gestureend はiOS Safari専用だが
// PWA(ホーム画面から起動)でも来るので両方に付ける。
["touchend","touchcancel","gestureend"].forEach(ev=>{
  document.addEventListener(ev,()=>{ fitTabbar(); setTimeout(fitTabbar,300); },{passive:true});
});
// 初期表示は幅フィット(CSS transform)。以降のズームは指のピンチ操作のみ
// (全体/幅/＋/−ボタンは2026-07-30谷川氏指示で削除)。
let BW=SHIMA.W,BH=SHIMA.H;
const IW=SHIMA.IW,IH=SHIMA.IH;   // 島図本体の実寸(2026-07-31・第2段階)
const board=document.getElementById("board"),stage=document.getElementById("stage");
// 下部固定ツールバーの実高さを測って余白へ反映する(2026-07-31・第1段階)。
// 行数やセーフエリアで高さが変わるため固定値にせず実測する。回転や表示切替でも取り直す。
function fitBar(){
  const tb=document.getElementById("tabbar"); if(!tb)return;
  // offsetHeightを使う(getBoundingClientRectはtransform後の見かけの高さを返すため、
  // ピンチ追従でscaleを掛けたときに余白が縮んでしまう)。
  const h=Math.ceil(tb.offsetHeight);
  document.documentElement.style.setProperty("--tbh",h+"px");
  fitTabbar();
  return h;
}
// 下部ツールバーを可視領域の下端に貼り付ける(2026-07-31)。
// #tabbarはposition:fixed=レイアウトビューポート基準なので、指のピンチで拡大して
// 寄せると画面の外に出てしまい、期間切替・検索・絞り込みに手が届かなくなっていた。
// 第1段階でバーを作った狙いは「ズーム・パンしても操作が常に手元にある」ことなので、
// 自前のダブルタップ拡大だけでなく指のピンチでも同じであるべき。
// 計算は台番カード(シート)と同一。scale(1/vv.scale)で見かけの大きさを一定に保ち、
// transform-origin:bottom left で下端と左端が動かないようにする。
function fitTabbar(){
  const tb=document.getElementById("tabbar"); if(!tb)return;
  const vv=window.visualViewport;
  if(!vv||!vv.width||!vv.height){
    tb.style.left=""; tb.style.right=""; tb.style.bottom="";
    tb.style.width=""; tb.style.transform=""; return;
  }
  tb.style.left=vv.offsetLeft+"px";
  tb.style.right="auto";
  // 可視領域の下に隠れている帯のぶんだけ持ち上げる。
  // **持ち上げるのは指で拡大しているときだけ**にする(2026-08-04・谷川氏報告
  // 「新台入替のところをタップして閉じたら下のバー達が中段にきてしまう」
  //  「更新押しても中段にとどまったまま」)。
  // この持ち上げを入れた理由は「ピンチで拡大して寄せるとバーが画面の外へ出る」ことで、
  // 等倍では position:fixed の bottom:0 がそのまま画面の下端に貼り付く
  // (iOSのツールバーは重なって表示されるだけで、固定要素はその上に出る)。
  // 等倍でも持ち上げていたため、可視領域の値がなにかの拍子に小さくなると
  // バーが島図の真ん中まで浮き上がり、読み込み直しても戻らなくなっていた。
  // 拡大中は持ち上げる量に上限を付けてはいけない。2倍で見ていると可視領域は実寸の半分
  // (844→422)になり、必要な持ち上げも422pxになる。上限で切るとバーが画面の外に残る
  // (実測でios_pinchの「2.0倍・上端を見ている」が落ちた)。
  const raw=layoutH()-(vv.offsetTop+vv.height);
  const zoomed=!!(vv.scale && vv.scale>1.01);
  const gap=zoomed?Math.max(0,raw):0;
  tb.style.bottom=gap+"px";
  tb.style.width=(vv.width*vv.scale)+"px";
  tb.style.transform=(vv.scale&&vv.scale!==1)?("scale("+(1/vv.scale)+")"):"";
  // バーの上に浮いている物(「全体に戻す」「矢印を消す」)も一緒に持ち上げる(2026-08-01)。
  // ※浮かせた凡例は2026-08-06に削除したのでこの一覧から外した。
  // CSSでは bottom:calc(var(--tbh)+12px) = レイアウトビューポート基準なので、
  // Safariのツールバーが出ている(可視領域が短い)ときや指のピンチで寄せたときに、
  // 可視領域基準へ移動したバーへ重なり、資料/更新ボタンが押せなくなる
  // (検証で「全体に戻すが資料ボタンを塞ぐ」として実際に再現した)。
  const bh=parseFloat(getComputedStyle(document.documentElement)
                      .getPropertyValue("--tbh"))||104;
  const sc=(vv.scale&&vv.scale!==1)?(1/vv.scale):1;
  // 「矢印を消す」も一緒に動かす(2026-08-04)。ピンチで寄せたときに画面外へ出ると、
  // 暗くした盤面を戻す手段が手元から消えてしまう。
  for(const id of ["zoomOut","mvClose"]){
    const el=document.getElementById(id);
    if(!el)continue;
    // 「全体に戻す」と同じ場所なので、両方出るときは矢印側を1段上へ
    const up=(id==="mvClose"&&zoomF>1)?46:0;
    el.style.bottom=(gap+bh+12+up)+"px";
    if(id==="mvClose"&&!el.classList.contains("show")){ continue; }
    else { el.style.right="auto"; el.style.left=(vv.offsetLeft+vv.width*vv.scale-el.offsetWidth-12)+"px"; }
    el.style.transformOrigin="bottom left";
    el.style.transform=(sc!==1)?("scale("+sc+")"):"";
  }
}
// ビュー切替(2026-07-31・第2段階)。island=島図だけ / docs=下部の資料テーブルだけ。
// 島図は「幅に合わせる」と画面の下半分が余白になるので、高さに合わせて画面いっぱいに使う
// (横は指でスクロールする)。資料は横に広い表なので従来どおり幅フィット＋ピンチで読む。
// zoomF=自前ズームの倍率(1=フィット。2026-08-01・ダブルタップ拡大で使う)。
// baseSc=そのビューでのフィット倍率 / curSc=実際に#boardへ掛かっている倍率(baseSc×zoomF)。
// keepScroll=true のときはスクロール位置を保つ(期間切替やズーム時に見ている場所を動かさない)。
let curView="island",zoomF=1,baseSc=1,curSc=1;
// 最後にピンチ操作をした時刻。タップ処理より前で宣言する(letは巻き上げされないので、
// 後ろで宣言すると「初期化前に参照した」で初期化ごと落ちる=urlLockで実害があった)。
let pinchAt=0;
// 最後に横へ払った時刻(2026-08-02・自前の横パン)。ここで宣言する理由は pinchAt と同じ。
// ブラウザがスクロールを担っていたときは、払った指でclickが出ることは無かった。
// 横を自前に移した以上、払っただけで台番カードが開かないよう自分で抑える必要がある。
let panAt=0;
// ---- 資料(2026-08-04・谷川氏指示) ----
// 「資料の内容を横スクロールは無しで縦スクロールだけにして、凡例・説明書・機種別出率・
//   機能をボタンにする。更新履歴ボタン追加」。
// それまでの資料は**島図と同じ盤面をそのまま縮小**して見せていた(xlsxの写し)。
// 印刷前提で3つの表が横に並んでいるため、画面では必ず横スクロールが要った。
// ここは SHIMA.docs(表の中身)から普通のHTMLとして組み直すので、幅に収まり縦だけで読める。
let docsBuilt=false;
// 選択期間の機種別出率を返す(2026-08-09)。直近7日=SHIMA.docs.rates(基準)。
// 他の期間=periods.json同梱の期間別rates(期間切替時に取得済み)。未取得なら基準で代用。
// curPeriod/PERIODSは後方で宣言されるlet(TDZ)なのでtry/catchで包む(呼ばれるのは初期化後)。
function ratesDocFor(){
  try{
    if(curPeriod!=="last7"&&PERIODS&&PERIODS[curPeriod]&&PERIODS[curPeriod].rates)
      return PERIODS[curPeriod].rates;
  }catch(e){}
  return (SHIMA&&SHIMA.docs&&SHIMA.docs.rates)||null;
}
// いま選んでいる期間の名前(下部バーのチップと同じ文言)を返す(2026-08-10)。
// 資料の見出しに【全期間】のように添えるために使う。PMETA/curPeriodは後方で
// 宣言されるconst/letなのでratesDocForと同じくtry/catchで包む(呼ばれるのは初期化後)。
function periodNameNow(){
  try{
    if(PMETA&&PMETA[curPeriod]&&PMETA[curPeriod].label) return PMETA[curPeriod].label;
  }catch(e){}
  const el=document.getElementById("pbrange");
  return (el&&el.textContent.trim())||"直近7日";
}
function buildDocs(){
  const host=document.getElementById("docsPanel");
  if(!host||docsBuilt) return;
  const D=(SHIMA&&SHIMA.docs)||{}, LOG=(SHIMA&&SHIMA.log)||[];
  const esc=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  // 見出しは**1行に収まる短さ**にする。xlsxの見出しには計算式の注記まで入っている
  // ものがあり(機種別出率の「総収支＝Σ〔…〕」)、そのままボタンに載せると
  // ボタンが5行になる。注記は中身の先頭へ回す。
  const cut=s=>{
    const t=String(s||"").replace(/\s+/g," ").trim();
    const i=t.search(/[（(]総収支|＝Σ|\n/);
    const j=t.indexOf("｜");
    const head=(j>0?t.slice(0,j):(i>0?t.slice(0,i):t)).trim();
    return [head, t.slice(head.length).replace(/^[｜|　\s]+/,"").trim()];
  };
  // alt は見出しの差し替え(2026-08-10・谷川氏指示「展開するまでは期間だけをカッコで
  // 囲んだ見出しにして、展開したら集計日付と計算式を出す」)。
  //   alt.head … summary に出す文字(既定の cut() の結果を上書きする)
  //   alt.pre  … 中身の先頭に置く注記の行(配列)。既定の注記より前に出す
  const sec=(key,label,inner,open,alt)=>{
    if(!inner) return "";
    const [head0,note]=cut(label);
    const head=(alt&&alt.head)||head0;
    const pl=((alt&&alt.pre)||[]).filter(Boolean)
      .map(x=>'<div>'+esc(x)+'</div>').join("");
    const pre=pl?'<div class="dnote">'+pl+'</div>':"";   // 1つの枠に数行(枠が並ばないように)
    return '<details class="dsec"'+(open?" open":"")+' data-k="'+key+'">'
      +'<summary>'+esc(head)+'</summary><div class="dbody">'
      +pre+(note?'<div class="dnote">'+esc(note)+'</div>':"")+inner
      // 開いた節の末尾にも閉じる手段を置く(2026-08-06・谷川氏指示「資料の各項目の
      // 展開したら最下部に展開を戻すボタンを入れる」)。機種別出率は59行あって、
      // 閉じるために見出しまで指で戻るのが手間だった。スペック側の「↑」と同じ考え方。
      +'<button type="button" class="dupbk" aria-label="この項目を閉じる">'
      +'↑ 閉じる</button>'
      +'</div></details>';
  };
  let html="";
  if(D.legend&&D.legend.rows&&D.legend.rows.length){
    html+=sec("legend",D.legend.t||"凡例",
      '<ul class="dleg">'+D.legend.rows.map(r=>'<li><i style="background:'
        +esc(r.bg||"#ccc")+'"></i><span>'+esc(r.t)+'</span></li>').join("")+'</ul>'
      // 「色に頼らない表示」の切替(2026-08-06)。島図に浮かせていた凡例を消したので、
      // 唯一の置き場所である資料タブの凡例の末尾へ移した。押したときの処理は
      // document への委譲なので、ここで作り直されても結び直しは要らない。
      // 2026-08-09 谷川氏指示: 凡例だけ常に開いた状態だったのを他の節と同じ「押したときだけ開く」へ
      +'<div id="legendSw"><span>色に頼らない表示</span>'
      +'<button class="sb" id="markBtn" type="button">記号を出す</button></div>');
  }
  if(D.manual&&D.manual.rows&&D.manual.rows.length){
    html+=sec("manual",D.manual.t||"説明書",
      '<dl class="ddl">'+D.manual.rows.map(r=>'<dt>'+esc(r[0])+'</dt><dd>'
        +esc(r[1])+'</dd>').join("")+'</dl>');
  }
  if(D.func&&D.func.rows&&D.func.rows.length){
    html+=sec("func",D.func.t||"機能",
      '<dl class="ddl">'+D.func.rows.map(r=>'<dt>'+esc(r[0])+'</dt><dd>'
        +esc(r[1])+'</dd>').join("")+'</dl>');
  }
  // 機種別出率は下部バーの選択期間に連動する(2026-08-09・谷川氏指示)。
  // 直近7日=SHIMA.docs.rates(基準)/他の期間=periods.jsonに同梱の期間別rates。
  // 期間データ未取得(通常は起きない=期間切替時に取得済み)のときは基準期間で代用する。
  const R=(typeof ratesDocFor==="function"?ratesDocFor():null)||D.rates;
  if(R&&R.rows&&R.rows.length){
    // 横に7列あると幅に入らないので、1機種=1枚のカードにして縦に積む
    // (見出しは行の中に小さく添える。表の横スクロールを作らないための形)。
    const c=R.cols||[];
    // 見出しは「機種別出率【全期間】」だけにする(2026-08-10・谷川氏指示)。
    // それまでは xlsx の見出しをそのまま載せていたので、押す前から
    // 「機種別出率（6/9〜8/8 最大61日・出率=(3G+差枚)/3G）」と2〜3行になっていた。
    // 日付(R.dt=島図の先頭見出し由来)と計算式は、開いたときに中身の先頭へ出す。
    const rt=String(R.t||"機種別出率").replace(/\s+/g," ").trim();
    const rm=cut(rt)[0].match(/^([^（(]+)[（(](.*)[）)]\s*$/)||[];
    const rbase=(rm[1]||"機種別出率").trim();
    const rin=(rm[2]||"").trim();                 // 「6/9〜8/8 最大61日・出率=(3G+差枚)/3G」
    const rfml=rin.split("・").filter(x=>x.indexOf("出率")===0)[0]||"";
    // 日付は R.dt が正。古いデータ(dt無し)のときは見出しの前半で代用する。
    // dt は「直近7日 8/2(日)〜8/8(土)」のように期間名が頭に付くが、それは見出しの
    // 【…】と重なるので落とす(全期間だけは頭に期間名が無いのでそのまま)。
    const pnm=periodNameNow();
    let rday=R.dt||rin.split("・")[0]||"";
    if(rday.indexOf(pnm)===0) rday=rday.slice(pnm.length).trim();
    html+=sec("rates",rt,
      '<ol class="drate">'+R.rows.map((r,i)=>{
        const v=r.v||[], fc=r.fc||[];
        return '<li><span class="dr-i">'+(i+1)+'</span>'
          // メーカー系を機種名の右に一行で添える(2026-08-09・谷川氏指示)。長い機種名側を
          // ellipsisで縮め、メーカー名は潰さない(CSS .dr-nw/.dr-mk)。
          +'<span class="dr-nw"><span class="dr-n">'+esc(v[0])+'</span>'
          +(r.mk?'<span class="dr-mk">'+esc(r.mk)+'</span>':"")+'</span>'
          +'<span class="dr-r" style="color:'+esc(fc[0]||"inherit")+'">'+esc(v[2])+'</span>'
          +'<span class="dr-s">'+esc(v[1])+'・'+esc(c[4]||"平均G")+' '+esc(v[4])
          +'・'+esc(c[5]||"平均差枚")+' '+esc(v[5])+'</span>'
          +'<span class="dr-y" style="color:'+esc(fc[1]||"inherit")+'">'+esc(v[6])+'</span></li>';
      }).join("")+'</ol>',false,
      {head:rbase+"【"+pnm+"】",
       pre:[rday?"集計 : "+rday:"", rfml?rfml.replace(/=/," = "):""]});
  }
  if(LOG.length){
    html+=sec("log","更新履歴",
      '<ol class="dlog">'+LOG.map(e=>'<li><div class="dlh"><span class="dld">'
        +esc(e.d)+'</span><span class="dlt">'+esc(e.t)+'</span>'
        +(e.tag?'<span class="dlg">'+esc(e.tag)+'</span>':"")+'</div>'
        +'<ul>'+(e.it||[]).map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></li>')
        .join("")+'</ol>');
  }
  host.innerHTML=html||'<div class="dempty">資料がありません</div>';
  // 節の末尾の「↑ 閉じる」(2026-08-06・谷川氏指示)。節ごとにボタンを結ばず、
  // 資料の入れ物に1つだけ置いて拾う(資料は作り直されるが入れ物は同じなので、
  // ここで1回付ければ足りる)。閉じたあとは見出しが画面に入る位置まで戻す。
  if(!host.dataset.upTap){ host.dataset.upTap="1";
    host.addEventListener("click",e=>{
      const b=e.target.closest(".dupbk");
      if(!b) return;
      const d=b.closest("details");
      if(!d) return;
      d.open=false;
      d.scrollIntoView({block:"nearest"});
    });
  }
  // 作り直した「記号を出す/消す」に、いまの入切を映しておく(2026-08-06)
  if(window.syncMarkBtn) window.syncMarkBtn();
  docsBuilt=true;
}
function setView(v,keepScroll){
  curView=v;
  // 資料は盤面ではなく専用のパネルで見せる(2026-08-04)
  {const dp=document.getElementById("docsPanel");
   if(dp){ if(v==="docs"){ buildDocs(); dp.hidden=false; } else { dp.hidden=true; } }
   const wr=document.getElementById("wrap");
   if(wr) wr.style.display=(v==="docs")?"none":"";}
  board.classList.toggle("v-island",v==="island");
  board.classList.toggle("v-docs",v==="docs");
  const barH=fitBar()||104;
  const availH=Math.max(200,window.innerHeight-barH-4), availW=window.innerWidth-4;
  let w,h,sc,ty;
  if(v==="island"){
    w=IW; h=IH; ty=0;
    sc=Math.max(availW/w, Math.min(availH/h, 0.6));   // 高さフィット(幅フィットを下回らない)
  }else{
    w=BW; h=BH-IH; ty=-IH;                            // 資料テーブルだけを上へ寄せる
    // 資料は印刷前提の横長の表。幅に合わせると文字が5px以下になって読めないので、
    // 「文字が読める倍率(0.5=元18ptが約12px)」を既定にして、横は指でスクロールしてもらう。
    // 2026-07-31(谷川氏指示「縦にスクロールせずに済むように収める」):
    // 0.5固定だと画面の高さを少し超えて縦スクロールが出ていた(実測: 使える高さ729pxに対し
    // 直近7日/全期間=765px・単日=777.5px・水曜のみ=786.5px。期間で表の行数が違うので
    // 資料の高さも変わる)。縦に収まる倍率へ下げる。必要倍率は0.4634〜0.4765=既定から
    // 7パーセントほど下がるだけなので、文字の読みやすさはほとんど変わらない。
    // (このテンプレートはPythonの書式文字列なので、コメントにパーセント記号を書かない)
    // 下限0.38は保険(将来さらに表が伸びたときに読めない大きさまで縮めない。
    // そのときは従来どおり縦スクロールに委ねる)。
    sc=Math.min(0.5,availH/(h||1));
    if(sc<0.38) sc=0.38;
  }
  // フィット倍率(baseSc)に自前ズーム(zoomF)を掛けたものが実際の倍率(curSc)。
  baseSc=sc; curSc=sc*zoomF;
  board.style.width=w+"px"; board.style.height=h+"px";
  board.style.transform=`scale(${curSc}) translate(0,${ty}px)`;
  // 盤面はCSS transformで縮小して表示するので、**中の線や印も同じ倍率で縮む**。
  // フィット表示の倍率は実測0.226(台番セルの生寸法93×53pxが画面上21×12pxになる)なので、
  // 例えば3pxの枠は0.68pxにしかならず、ほぼ見えない。「画面上で何px」を保ちたい印は
  // CSSで calc(3px / var(--zsc)) と書けるように、今の倍率をここで配る(2026-08-02)。
  board.style.setProperty("--zsc",String(curSc));
  // セル同士の重なり(2026-08-04・谷川氏報告「拡大したら消えたが、全台で見るとまだ
  // うっすら継ぎ目が残る」)。盤面px固定の0.6pxではフィット表示(倍率0.23)で画面上
  // 0.14pxまで縮み、隣り合うセルの境界に下地が透けて薄い線に見える。**画面上の太さ**を
  // 一定(0.8px)に保ちたいので、倍率で割った値を配る。上限は台番の文字が中央寄せで
  // 動かない範囲(素のセルは93×53px)。
  board.style.setProperty("--ov",(Math.min(6,0.8/(curSc||1))).toFixed(2)+"px");
  // #stageの実寸=見た目の寸法(=#wrapがスクロール範囲として認識する値)。#wrap自体には
  // 幅/高さを指定しない(#stageの実寸にそのまま追従させる=無限スクロール対策の要)。
  stage.style.width=(w*curSc)+"px"; stage.style.height=(h*curSc)+"px";
  // 盤面が使える高さより小さいときだけ、上下の真ん中へ寄せる(2026-08-10・谷川氏指示)。
  // 道すじの矢印は「元と先の両方を画面に入れる」ためにフィットより引くので、
  // そのままだと盤面が画面の上端に貼り付き、下半分がまるごと余白になっていた。
  // 通常のフィットは高さぴったり(h*curSc==availH)なのでこの余白は0=従来と同じ。
  // 拡大中(zoomF>1)も盤面のほうが高いので0。資料は別のパネルで見せるので島図だけ。
  const gapY=(v==="island")?Math.max(0,(availH-h*curSc)/2):0;
  stage.style.marginTop=gapY?gapY+"px":"";
  document.getElementById("docsBtn").classList.toggle("is-on",v==="docs");
  document.getElementById("zoomOut").classList.toggle("show",zoomF>1);
  if(!keepScroll){ document.getElementById("wrap").scrollTop=0; window.scrollTo(0,0); }
  // 拡大中の現在地(2026-08-01)。倍率やビューが変わったら出し直す。
  if(typeof whereSoon==="function") whereSoon();
}
document.getElementById("docsBtn").addEventListener("click",()=>{
  // 資料は横長の表なので拡大状態を持ち込まない(島図へ戻るときもフィットから始める)。
  zoomF=1;
  setView(curView==="docs"?"island":"docs");
  syncUrl();
});
window.addEventListener("orientationchange",()=>setTimeout(()=>setView(curView),300));
setView("island");
// ---- ダブルタップ拡大(2026-08-01・第2段階) ----
// フィット表示だと台番セルは約21x12px。読むにも押すにも小さいので、ダブルタップで一気に
// 3.5倍(=約73x42px)まで寄れるようにし、もう一度のダブルタップでフィットに戻す。
// 「タップした位置を動かさずに拡大する」のが要点(指で押さえた台がそのまま大きくなる)。
const ZOOM_IN=3.5;
// 横=#wrap自身のスクロール / 縦=文書スクロール(#wrapは高さ指定なし=縦は文書側が伸びる)。
// どちらが動くかを意識せずに済むよう、必要な移動量を渡すだけの形にまとめる。
// 器が別々なままなのは意図的(縦をブラウザに残さないとiOS Safariのツールバーが
// 引っ込まず画面が狭くなる)。指1本で斜めに動かせない件は、横だけJS側で動かす
// 自前パン(このすぐ下)で解いている。
function scrollBy2(dx,dy){
  document.getElementById("wrap").scrollLeft+=dx;
  window.scrollBy(0,dy);
}
// 盤面座標(bx,by)が画面上の(cx,cy)に来るようスクロールを合わせる。
function anchorTo(bx,by,cx,cy){
  const r=stage.getBoundingClientRect();
  scrollBy2((r.left+bx*curSc)-cx,(r.top+by*curSc)-cy);
}
// 画面上の点(cx,cy)を固定したまま倍率を変える。
function setZoom(zf,cx,cy){
  zf=Math.max(1,Math.min(6,zf));
  if(Math.abs(zf-zoomF)<0.01)return;
  const r=stage.getBoundingClientRect();
  const bx=(cx-r.left)/curSc, by=(cy-r.top)/curSc;   // 倍率変更「前」の盤面座標
  zoomF=zf;
  setView(curView,true);                              // 倍率・#stage実寸を引き直す
  anchorTo(bx,by,cx,cy);
}
document.getElementById("zoomOut").addEventListener("click",()=>{
  zoomF=1; setView(curView,true);
  document.querySelectorAll(".hitfocus").forEach(x=>x.classList.remove("hitfocus"));
});
// 移動の矢印を消す(2026-08-04・谷川氏指示「矢印を消すボタンを出す」)。
// 矢印そのものを押しても消えるが、暗くしている間の逃げ道は必ず画面に置いておく。
(function(){
  const b=document.getElementById("mvClose");
  if(b) b.addEventListener("click",e=>{ e.stopPropagation(); clearMove(); });
})();
// ---- 2本指ピンチも自前で受ける(2026-07-31・谷川氏指示) ----
// 背景: 谷川氏報告「二本指でズームした時に全体に戻すボタンが出てこない/ダブルタップの
// ときは出てくる」。ブラウザ自身のピンチ(ページズーム)は**ページ側から倍率を戻す手段が
// 標準に存在しない**(W3C CSSWGに「visual viewportの倍率を戻す方法を追加したい」という
// 提案#9787が2024年1月から出ている=つまり現時点で無い。viewportメタを書き換える
// 回避策もiOS10以降はユーザーのピンチ操作が優先されて効かない)。
// そのため「全体に戻す」ボタンを出しても押して戻せない=出さないのが正しい状態だった。
// 対処: 島図の上でのピンチはブラウザに渡さず、ダブルタップ拡大と同じzoomFを動かす。
// これで「全体に戻す」が効くようになり、さらにページ自体が拡大しなくなるので、
// 固定要素(台番カード・下部ツールバー)が可視領域から外れる問題も原理的に起きなくなる。
// 台番カードの中(#modalは#wrapの外)は従来どおりブラウザのピンチを残す
// =表の文字を指で拡大して読める(アクセシビリティを削らない)。
(()=>{
  const wrap=document.getElementById("wrap");
  // 倍率の更新は1フレームに1回へまとめる(指を動かすたびにsetView=盤面の再計算が
  // 走ると重い。ブルブル対策と同じ考え方で、描画の頻度を画面に合わせる)。
  let q=null,raf=0;
  const queueZoom=(zf,cx,cy)=>{
    q={zf:zf,cx:cx,cy:cy};
    if(raf)return;
    raf=requestAnimationFrame(()=>{ raf=0; const p=q; q=null; if(p)setZoom(p.zf,p.cx,p.cy); });
  };
  if("ongesturestart" in window){
    // Safari(WebKit)はピンチをgestureイベントで通知する(e.scale=開始時からの倍率)。
    // preventDefaultでブラウザのページズームを止める。
    let z0=1,gx=0,gy=0;
    // GestureEventはWebKit独自で仕様書が無い。clientX/clientYが取れない環境に当たっても
    // NaNで壊れないよう、取れなければ画面の中心を拡大の中心にする。
    const gpt=(e,d)=>(typeof e.clientX==="number"&&isFinite(e.clientX))
      ? (d==="x"?e.clientX:e.clientY) : (d==="x"?window.innerWidth/2:window.innerHeight/2);
    wrap.addEventListener("gesturestart",e=>{
      e.preventDefault(); z0=zoomF; gx=gpt(e,"x"); gy=gpt(e,"y"); pinchAt=Date.now();
    },{passive:false});
    wrap.addEventListener("gesturechange",e=>{
      e.preventDefault(); pinchAt=Date.now(); queueZoom(z0*e.scale,gx,gy);
    },{passive:false});
    wrap.addEventListener("gestureend",e=>{ e.preventDefault(); pinchAt=Date.now(); },{passive:false});
  }else{
    // Safari以外は指2本のtouchイベントから距離の比で倍率を出す。
    let d0=0,z0=1;
    const dist=t=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    const mid=t=>({x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2});
    wrap.addEventListener("touchstart",e=>{
      if(e.touches.length===2){ d0=dist(e.touches); z0=zoomF; pinchAt=Date.now(); }
    },{passive:true});
    wrap.addEventListener("touchmove",e=>{
      if(e.touches.length===2&&d0>0){
        e.preventDefault(); pinchAt=Date.now();
        const c=mid(e.touches);
        queueZoom(z0*dist(e.touches)/d0,c.x,c.y);
      }
    },{passive:false});
    const done=e=>{ if(e.touches.length<2){ d0=0; pinchAt=Date.now(); } };
    wrap.addEventListener("touchend",done,{passive:true});
    wrap.addEventListener("touchcancel",done,{passive:true});
  }
})();
// ---- 指1本の「横」の移動は自前で受ける(2026-08-02・谷川氏報告「斜めに動かせない」) ----
// 島図は 横=#wrap / 縦=文書 と器が分かれている。両方をブラウザに任せると、指1本の
// 操作でブラウザが器を1つしか選ばない(ラッチする)ため、斜めに払うと先に横が選ばれて
// 縦が最後まで動かない(実測: 斜め払いで 横+158 / 縦+0)。
// そこで app.css の touch-action:pan-y で「縦だけブラウザに任せ」、横はここで動かす。
// 縦と横の担当が分かれるので取り合いが起きず、斜めがそのまま動く。
// **縦まで自前にしてはいけない**。ページ本体のスクロールを止めると iOS Safari が
// 上下のツールバーを引っ込めなくなり画面が狭くなる(2026-08-02に一度やって差し戻した)。
// 縦をどちらが動かすかは**払い始めに1回だけ決めて、指を離すまで変えない**
// (2026-08-02の2回目・谷川氏報告「動くは動くけどぎこちない」の対策)。
// 最初の実装は touchmove ごとに「ページが実際に動いたか」を見て肩代わりを判断して
// いたが、ブラウザのスクロールは一拍遅れて反映されるので、動いた/動かないが
// パタパタ入れ替わって縦が途切れる。さらに慣性が横=自前・縦=ブラウザと減り方の
// 違うものになり、斜めに滑らせると軌跡が曲がる。担当を固定すればどちらも消える。
//   縦寄り(60度以上) : ブラウザに任せる。慣性もツールバーの引っ込みも本来のまま
//   それ以外(斜め・横): preventDefaultでブラウザを止め、両軸ともJSが動かす
// 60度という境目は実測から採った(真横から50度まではブラウザが縦を動かさず、
// 60度で動き出す=ブラウザが自分で動かす角度だけをブラウザに残す形)。
// **縦を常に自前にしてはいけない**。ページ本体のスクロールが起きなくなると
// iOS Safariが上下のツールバーを引っ込めず画面が狭くなる(2026-08-02に差し戻した)。
(function(){
  const wrap=document.getElementById("wrap");
  let panId=null,px=0,py=0,sx=0,sy=0,mode=0;       // mode 0=未定 1=縦はブラウザ 2=両軸自前
  let refX=0,refY=0,refT=0,vx=0,vy=0,glide=0,dist=0;
  let qx=0,qy=0,raf=0;
  const stopGlide=()=>{ if(glide){ cancelAnimationFrame(glide); glide=0; } };
  // 移動の適用は1フレームに1回へまとめる(touchmoveのたびに書き換えると描画と
  // ずれてカクつく。ピンチの倍率更新と同じ考え方)。
  const flush=()=>{
    raf=0;
    if(qx)wrap.scrollLeft-=qx;
    if(qy)window.scrollBy(0,-qy);
    qx=qy=0;
  };
  const queue=(dx,dy)=>{
    qx+=dx; qy+=dy;
    if(!raf)raf=requestAnimationFrame(flush);
  };
  wrap.addEventListener("touchstart",e=>{
    stopGlide();                                   // 滑っている最中に触ったら止める
    if(e.touches.length!==1){ panId=null; return; }
    const t=e.touches[0];
    panId=t.identifier; px=sx=refX=t.clientX; py=sy=refY=t.clientY;
    refT=Date.now(); vx=vy=0; dist=0; mode=0; qx=qy=0;
  },{passive:true});
  wrap.addEventListener("touchmove",e=>{
    if(panId===null||e.touches.length!==1)return;  // 2本指はピンチ側の担当
    const t=e.touches[0];
    if(t.identifier!==panId)return;
    if(mode===0){
      // 払い始めの向きで担当を決める。8px動くまでは待つ(最初の1〜2pxは
      // 手ぶれで向きが定まらず、決め打つと逆の担当に入ってしまう)。
      const adx=Math.abs(t.clientX-sx), ady=Math.abs(t.clientY-sy);
      if(adx+ady<8)return;
      mode=(ady>adx*1.7)?1:2;                      // 1.7倍≒60度
    }
    // 自前で動かすと決めたときだけブラウザのスクロールを止める。
    // **判定を8pxで済ませているのはこのため**(iOSはスクロールが始まった後の
    // preventDefaultを無視するので、始まる前に決めきる必要がある)。
    if(mode===2&&e.cancelable)e.preventDefault();
    const dx=t.clientX-px, dy=t.clientY-py;
    px=t.clientX; py=t.clientY; dist+=Math.abs(dx)+Math.abs(dy);
    queue(dx,mode===2?dy:0);                       // 縦はブラウザ担当なら触らない
    // 速度は「少し離れた2点」から出す(1フレームぶんの差分は揺れが大きく、
    // 指を止めてから離したのに滑る・逆へ飛ぶといった誤爆になる)。
    const now=Date.now();
    if(now-refT>40){
      vx=(t.clientX-refX)/(now-refT); vy=(t.clientY-refY)/(now-refT);
      refX=t.clientX; refY=t.clientY; refT=now;
    }
  },{passive:false});
  const end=()=>{
    if(panId===null)return;
    panId=null;
    if(dist<6){ mode=0; return; }                  // ほぼ動いていない=タップ扱いのまま通す
    panAt=Date.now();                              // 払った直後のclickを抑える
    const self=(mode===2); mode=0;
    if(Date.now()-refT>90)return;                  // 止めてから離した=滑らせない
    // 指を離した後の惰性。**自分が動かした軸にだけ付ける**
    // (島図は横が3000px以上あるので、惰性が無いと端まで何度も払うことになる)。
    // 縦をブラウザが動かしていたときはブラウザ側の惰性が効くので自前では付けない。
    // 担当を固定してあるので、斜めに滑らせても両軸が同じ減り方=軌跡が曲がらない。
    let ax=Math.max(-90,Math.min(90,vx*16));       // px/ms → 1フレーム(約16ms)ぶん
    let ay=self?Math.max(-90,Math.min(90,vy*16)):0;
    if(Math.abs(ax)<1.2&&Math.abs(ay)<1.2)return;
    const step=()=>{
      if(Math.abs(ax)>0.35)wrap.scrollLeft-=ax;
      if(Math.abs(ay)>0.35)window.scrollBy(0,-ay);
      ax*=0.94; ay*=0.94;                          // 1秒ほどで止まる減り方
      glide=(Math.abs(ax)>0.35||Math.abs(ay)>0.35)?requestAnimationFrame(step):0;
    };
    glide=requestAnimationFrame(step);
  };
  wrap.addEventListener("touchend",end,{passive:true});
  wrap.addEventListener("touchcancel",end,{passive:true});
})();
// タップの振り分け。#wrapのキャプチャ段で受けるので、台番セル自身のクリック処理より先に走る。
// - 2回目のタップが300ms以内・36px以内に来たらダブルタップ=拡大/縮小。
// - 台番タップは、ダブルタップと見分けるため300ms待ってからカードを開く。押した瞬間に
//   .tap:activeのオレンジ枠が出るので、待っている間も無反応には見えない。
//   当初は「拡大中は待たずに即開く」にしていたが、それだと拡大中に台番の上でダブルタップ
//   しても1回目でカードが開いてしまい、2回目はカードの背景に当たって「縮小できない」
//   状態になった(島図は面積の8割が台番セルなので、余白を狙わせるのは現実的でない)。
//   どの倍率でも同じ操作になるほうが説明もしやすいので、300msの待ちは全域で共通にした。
//   検証スクリプトは el.click() ではなく renderCard() を直接呼んでカードの寸法だけを測る。
let lastTapT=0,lastTapX=0,lastTapY=0,tapTimer=null;
document.getElementById("wrap").addEventListener("click",e=>{
  // ピンチ直後のクリックは無視する(2026-07-31・自前ピンチの導入に伴う)。
  // 指を離す順番によっては最後の1本がタップと解釈され、拡大した直後に
  // 台番カードが開いたり、ダブルタップ判定に巻き込まれたりする。
  if(Date.now()-pinchAt<400){ lastTapT=0; return; }
  // 横へ払った直後のクリックも無視する(2026-08-02・自前の横パン)。
  // ブラウザがスクロールしていたときは払うとclickが出なかったが、自前で動かすと
  // 指を離した所でclickが出るため、払うたびに台番カードが開いてしまう。
  if(Date.now()-panAt<320){ lastTapT=0; return; }
  const t=(window.performance&&performance.now)?performance.now():Date.now();
  const x=e.clientX,y=e.clientY;
  const dbl=(t-lastTapT<300)&&(Math.abs(x-lastTapX)<36)&&(Math.abs(y-lastTapY)<36);
  lastTapT=t; lastTapX=x; lastTapY=y;
  if(dbl){
    lastTapT=0;
    if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}
    e.preventDefault(); e.stopPropagation();
    setZoom(zoomF>1?1:ZOOM_IN,x,y);
    return;
  }
  const cell=e.target.closest?e.target.closest(".tap"):null;
  if(cell){
    e.stopPropagation();
    const dai=cell.dataset.dai;
    tapTimer=setTimeout(()=>{ tapTimer=null; renderCard(dai,winForBoard()); },300);
  }
},true);
// 期間切替(2026-07-31谷川氏指示「単日/水曜のみ/直近7日/全期間を切り替えられるように」)。
// PERIODSは期間ごとに「基準版と1セルでも違うセル」の完成形(スタイル/クラス/中身)を持つ。
// 切替時はそのセルだけを貼り替える。絞り込みのハイライト(filt-hit/filt-dim/lbl-hit)は
// 期間に依存しない条件(直近7日/全期間/3週間)で付いているので、貼り替えで消えないよう
// 退避して付け直す。
// 2026-08-01(第3段階): 期間差分は外部JSON(PERIODS_URL)へ出して初回は読まない。
// 実測でHTML3007KBのうち期間差分が1834KB(61%)を占めており、しかも「チップを押した
// ときにしか要らない」データだった。HTMLに残すのはPMETA(チップの文言と盤面サイズ)と
// TOUCH(貼替対象のキー)だけ。
// 直近7日(基準)へ戻すための差分も持たない。初期DOMをそのままスナップショットしておき、
// そこから復元する(=戻るためのデータ転送もゼロ)。
const PMETA=SHIMA.pmeta, TOUCH=SHIMA.touch, PERIODS_URL=SHIMA.purl;
let PERIODS=null, periodsReq=null, curPeriod="last7";
// 初期DOM(=直近7日)の貼替対象セルを控える。DOMに無いキーはnull=「この期間には無いセル」。
const BASE_SNAP=(()=>{
  const snap={};
  TOUCH.forEach(k=>{
    const el=document.querySelector('[data-k="'+k+'"]');
    snap[k]= el ? {c:el.className, s:el.style.cssText, t:el.innerHTML,
                   d:el.dataset.dai||"", l:el.dataset.lbl||""} : null;
  });
  return snap;
})();
const KEEP_CLS=["filt-hit","filt-dim","lbl-hit","lbl-dim"];
// 絞り込み・検索のハイライトは期間に依存しないので、貼り替えで消えないよう退避して付け直す。
function paintCell(k,c,s,t,d,l){
  let el=document.querySelector('[data-k="'+k+'"]');
  if(!el){ el=document.createElement("div"); el.dataset.k=k; board.appendChild(el); }
  const on=KEEP_CLS.filter(x=>el.classList.contains(x));
  el.className=c+(on.length?" "+on.join(" "):"");
  el.style.cssText=s; el.style.display="";
  el.innerHTML=t;
  if(d) el.dataset.dai=d; else delete el.dataset.dai;
  if(l) el.dataset.lbl=l; else delete el.dataset.lbl;
}
function restoreBase(){
  TOUCH.forEach(k=>{
    const v=BASE_SNAP[k];
    if(!v){ const el=document.querySelector('[data-k="'+k+'"]'); if(el) el.style.display="none"; return; }
    paintCell(k,v.c,v.s,v.t,v.d,v.l);
  });
}
function loadPeriods(){
  if(PERIODS) return Promise.resolve(PERIODS);
  if(periodsReq) return periodsReq;
  periodsReq=fetch(PERIODS_URL,{cache:"no-cache"}).then(r=>{
    if(!r.ok) throw new Error("HTTP "+r.status);
    return r.json();
  }).then(j=>{ PERIODS=j; return j; }).catch(e=>{ periodsReq=null; throw e; });
  return periodsReq;
}
function finishPeriod(p,meta,remember){
  // 盤面の実寸が期間で変わる(下部の表の行数が違う)ため、拡大率と#stageの実寸を取り直す。
  // 島図本体(IW/IH)は期間で変わらないので、資料側の高さだけ更新してビューを引き直す。
  BW=meta.W; BH=meta.H;
  // 期間を切り替えても拡大率と見ている場所を保つ(同じ島を単日→水曜→直近7日と見比べる
  // 使い方が主なので、切替のたびに全体表示へ戻ると比較が途切れる)。
  setView(curView,true);
  document.querySelectorAll(".pchip").forEach(b=>{
    b.classList.toggle("is-on",b.dataset.p===p); b.classList.remove("loading");
  });
  document.getElementById("pbrange").textContent=meta.label;
  curPeriod=p;
  // URLで指定されて開いたときは自分の既定を書き換えない(2026-08-01)。共有リンクを踏んだ
  // だけで次回から他人の期間で開くようになるのは意図と違う。
  if(remember!==false){ try{ localStorage.setItem("shimaheat-period",p); }catch(e){} }
  syncUrl();
  // 期間を切り替えるとセルを貼り替えるのでピンの印も付け直す(2026-08-01)。
  if(typeof paintPins==="function") paintPins();
  // 色に頼らない記号も同じ理由で付け直す(貼り替えで消えるため)。
  try{ window.dispatchEvent(new Event("shimaheat-period")); }catch(e){}
  // 資料の機種別出率を選択期間に連動させる(2026-08-09・谷川氏指示)。
  // 資料を一度でも組み立て済みなら作り直し対象にし、資料ビューを見ている最中なら
  // その場で組み直す(開いていた節は開いたまま保つ)。
  if(docsBuilt){
    const opens=Array.from(document.querySelectorAll('#docsPanel details[open]'))
      .map(d=>d.dataset.k);
    docsBuilt=false;
    if(curView==="docs"){
      buildDocs();
      opens.forEach(k=>{
        const d=document.querySelector('#docsPanel details[data-k="'+k+'"]');
        if(d) d.open=true;
      });
    }
  }
}
function applyPeriod(p,remember){
  const meta=PMETA[p]; if(!meta) return;
  if(p==="last7"){ restoreBase(); finishPeriod(p,meta,remember); return; }
  if(!PERIODS){
    // 未取得なら取りに行く。押したチップに読み込み中の印を出す(無反応に見せない)。
    const chip=document.querySelector('.pchip[data-p="'+p+'"]');
    if(chip) chip.classList.add("loading");
    loadPeriods().then(()=>applyPeriod(p,remember)).catch(()=>{
      if(chip) chip.classList.remove("loading");
      showToast("期間データを読み込めませんでした",2600);
    });
    return;
  }
  const P=PERIODS[p]; if(!P){ finishPeriod(p,meta,remember); return; }
  const hidden=new Set(P.hide||[]);
  (P.set||[]).forEach(([k,s,c,t,d,l])=>paintCell(k,c,s,t,d,l));
  hidden.forEach(k=>{ const el=document.querySelector('[data-k="'+k+'"]'); if(el) el.style.display="none"; });
  finishPeriod(p,meta,remember);
}
document.querySelectorAll(".pchip").forEach(b=>{
  b.addEventListener("click",()=>applyPeriod(b.dataset.p));
});
// 前回選んだ期間を覚えておく(配色と同じ考え方)。存在しない期間が保存されていても
// 既定(直近7日)に落ちるだけで壊れない。
// URLで期間が指定されていればそれを最優先にする(共有されたURLを開いたとき、
// 自分の前回の選択で上書きされてしまわないように)。
(()=>{ const up=INIT_Q.get("p")||""; let p=up;
  if(!p){ try{ p=localStorage.getItem("shimaheat-period")||"last7"; }catch(e){} }
  applyPeriod(PMETA[p]?p:"last7", !up); })();
// 初回描画が落ち着いたころに裏で取っておく(チップを押した時点では手元にある状態にする)。
// 初回表示の邪魔をしないよう、requestIdleCallbackがあればそれに乗せる。
(()=>{ const go=()=>loadPeriods().catch(()=>{});
  if(window.requestIdleCallback) requestIdleCallback(go,{timeout:4000});
  else setTimeout(go,1500); })();
// ---- 下部バーの開閉(2026-08-03・谷川氏要望) ----
// バーは4段(新台告知/データ鮮度/期間チップ/操作ボタン)で169px=画面の22%を占める。
// 島図を広く見たいときに畳めるようにし、その状態を覚えておく。
// 畳むのは中身(.tbbody)の高さで、#tabbar自身のtransformは使わない
// (fitTabbarがピンチ追従でtransformを直接書き換えるので取り合いになる)。
const BAR_KEY="shimaheat-bar";
function setBar(min,remember){
  const tb=document.getElementById("tabbar"),
        btn=document.getElementById("barToggle"),
        tx=document.getElementById("barToggleTx");
  if(!tb||!btn)return;
  tb.classList.toggle("is-min",min);
  btn.setAttribute("aria-expanded",min?"false":"true");
  btn.setAttribute("aria-label",min?"操作バーを表示する":"操作バーを隠す");
  if(tx)tx.textContent=min?"操作を出す":"操作を隠す";
  if(remember){ try{ localStorage.setItem(BAR_KEY,min?"min":"open"); }catch(e){} }
  // **空いた高さを島図へ回す**。fitBar()だけだと --tbh(下余白)は縮むが島図の倍率が
  // 元のままで、畳んだぶんがただの空白になる(2026-08-03の実測: 120px空いても
  // 倍率0.2023のまま・島図の増加0px)。setViewが中でfitBarも呼ぶのでこれ1つでよい。
  // keepScroll=trueで見ている場所を保つ(畳んだ拍子に別の島へ飛ばない)。
  setView(curView,true);
}
document.getElementById("barToggle").addEventListener("click",()=>{
  setBar(!document.getElementById("tabbar").classList.contains("is-min"),true);
});
(function(){
  let v=null; try{ v=localStorage.getItem(BAR_KEY); }catch(e){}
  if(v==="min")setBar(true,false);
})();
// ライト/ダーク切替(2026-07-30夜谷川氏指示)。<head>内の同期スクリプトが初回描画前に
// data-themeを既に設定済みなので、ここではボタンのアイコンを現在値に合わせて初期化し、
// クリックでトグル+localStorage保存するだけでよい(島図の塗り色・文字色には触れない=
// heat_html.pyのcl["bg"]/cl["fc"]によるインラインstyleがCSS変数より常に優先されるため)。
const THEME_KEY="shimaheat-theme", themeBtn=document.getElementById("themeBtn");
// 2026-07-31: ボタンの中身をアイコン(SVG)＋文言に変えたので、textContentごと差し替えるのを
// やめ、補足文言(次に切り替わる先)だけを書き換える。「今どちらか」ではなく「押すとどうなるか」
// を出すほうが、初見でも押した結果が分かる。
const setThemeIcon=t=>{ const s=document.getElementById("themeSub");
  if(s) s.textContent = (t==="dark") ? "明るい配色にする" : "暗い配色にする"; };
setThemeIcon(document.documentElement.getAttribute("data-theme")||"light");
themeBtn.addEventListener("click",()=>{
  const next=(document.documentElement.getAttribute("data-theme")==="dark")?"light":"dark";
  document.documentElement.setAttribute("data-theme",next);
  try{ localStorage.setItem(THEME_KEY,next); }catch(e){}
  setThemeIcon(next);
  // モーダルを開いたまま切り替えた場合、グラフの線色(TC=chartColors())は描画時点で固定される
  // ため、開いたままだと古いテーマの色で残ってしまう→curDaysがあれば同じ設定で再描画する。
  if(curDays && document.getElementById("modal").style.display==="block"){
    const CH=parseFloat(document.getElementById("chart").querySelector("svg")?.getAttribute("viewBox")?.split(" ")[3])||CH0;
    document.getElementById("chart").innerHTML=drawChart(curDays,curLabels,CH,curBase,curIntra);
  }
});
// 更新＆リセットボタン(2026-07-31新設・同日「更新ボタンは更新＆リセット」と定義)。
// キャッシュを回避して最新のデプロイ内容を取り直すため、単純なlocation.reload()ではなく
// その時刻のクエリ文字列を付けて再読込する(Cloudflare Pages配信のHTMLがブラウザ/中間
// キャッシュに残っている場合の取りこぼし対策)。再読込によって絞り込み条件・ハイライト・
// ズーム/パンの位置も同時に初期状態へ戻る=「リセット」も兼ねる。念のため再読込前にも
// 絞り込みの入力と表示を明示的に消しておく(再読込が中断された場合でも中途半端に残らない)。
// 短いメッセージを画面下(バーの上)に出す共通関数(2026-07-31新設)。
let toastTimer=null;
function showToast(msg,ms){
  const t=document.getElementById("toast"); if(!t)return;
  t.textContent=msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove("show"), ms||1800);
}
document.getElementById("refreshBtn").addEventListener("click",()=>{
  const btn=document.getElementById("refreshBtn");
  if(btn.classList.contains("busy"))return;       // 連打で二重に走らせない
  btn.classList.add("busy");                      // アイコンが回り始める
  showToast("更新しています…",6000);
  try{ document.getElementById("fClear").click(); }catch(e){}
  // 再読込後に「終わった」と伝えるための印。時刻も入れて古い印は無視する。
  try{ sessionStorage.setItem("shimaheat-refresh",String(Date.now())); }catch(e){}
  // 2026-08-01: 状態をURLに載せるようにしたので、更新でもその状態を保つ
  // (期間や開いていた台がリセットされると「更新=最初からやり直し」になってしまう)。
  const go=()=>{const u=new URLSearchParams(location.search); u.set("r",String(Date.now()));
   location.href = location.pathname + "?" + u.toString();};
  // オフライン用に保存した内容を先に捨てる(2026-08-01・谷川氏報告「更新しても
  // 反映されない」)。Service Workerを入れた結果、更新を押しても保存済みの版が
  // 返っていた。**保存済みを消してから読み直す**=更新は必ず最新になる。
  // 消せない/応答が無い環境でも1.2秒で先へ進む(更新が固まらないようにする)。
  let moved=false;
  const once=()=>{ if(!moved){ moved=true; go(); } };
  setTimeout(once,1200);
  (async()=>{
    try{
      if(window.caches){
        const ks=await caches.keys();
        await Promise.all(ks.filter(k=>k.indexOf("shimaheat")===0).map(k=>caches.delete(k)));
      }
      if(navigator.serviceWorker){
        const r=await navigator.serviceWorker.getRegistration("/atsuta/");
        if(r) await r.update();
      }
    }catch(e){}
    once();
  })();
});
// 再読込直後の完了通知(印が30秒以内なら出して消す)。
(()=>{
  let t=0;
  try{ t=parseInt(sessionStorage.getItem("shimaheat-refresh"),10)||0; }catch(e){}
  if(t && Date.now()-t < 30000){
    try{ sessionStorage.removeItem("shimaheat-refresh"); }catch(e){}
    setTimeout(()=>showToast("✓ 最新に更新しました",2200),350);
  }
})();
// 絞り込み(2026-07-31新設・谷川氏指示「相関する台を絞り込み、癖や傾向を読み解きたい」)。
// 直近7日差枚合計・全期間トータル差枚(データ取得開始日からの累計)・3週間出率の3条件(AND)で
// 台番セルを判定し、該当は黄色縁取り・非該当は薄く(opacity)する(機種名欄は2026-07-31に削除)。
// 島図の塗り色(差枚ヒートの意味を持つ色)自体は変更しない(既存のライト/ダーク方針と同じ)。
const filterBtn=document.getElementById("filterBtn"), filterModal=document.getElementById("filterModal");
filterBtn.addEventListener("click",()=>{
  filterModal.style.display="block";
  fitFilterModal();
  // 台番タップ時と同じ保険(2026-07-30第4件由来): 開いた直後はvisualViewportの値が
  // まだ確定していないことがあるため、次フレームでもう一度だけ位置/サイズを取り直す。
  requestAnimationFrame(()=>{ if(filterModal.style.display==="block")fitFilterModal(); });
});
document.getElementById("filterClose").addEventListener("click",()=>{ filterModal.style.display="none"; });
filterModal.addEventListener("click",e=>{ if(e.target.id==="filterModal") filterModal.style.display="none"; });
// 台ごとの集計値(直近7日合計・全期間トータル・3週間出率)を都度計算する。
// 全期間トータル=base(データ取得開始日〜3週間窓の前日までの累計)+3週間分の合計
// (2026-07-30の実装<3週間累積グラフのbase>と同じ考え方を流用)。
function filterStats(dai){
  const m=DATA.machines[dai]; if(!m)return null;
  // 2026-07-31: 埋め込む日数を全期間(52日)へ広げたため、3週間の集計は末尾21日を明示して
  // 切り出す(従来は配列全体=21日だった)。全期間トータルは全日分の合計。
  let sum7=0,sum21=0,g21=0,sumAll=0;
  m.d.slice(-WEEK).forEach(x=>{ if(x[0]!=null)sum7+=x[0]; });
  m.d.slice(-NDAYS).forEach(x=>{ if(x[0]!=null)sum21+=x[0]; if(x[1]!=null)g21+=x[1]; });
  m.d.forEach(x=>{ if(x[0]!=null)sumAll+=x[0]; });
  return {name:m.n, sum7:sum7, total:(m.b||0)+sumAll, rate21:rate(sum21,g21)};
}
function parseNum(id){ const v=document.getElementById(id).value; return v===""?null:parseFloat(v); }
// 押して選ぶ条件(2026-08-04・谷川氏指示「絞り込みに末尾、位置区分、曜日、ゾロ目の日も」)。
// もう一度押すと外れる。何も選ばなければ条件にならない(空欄と同じ扱い)。
document.querySelectorAll("#fSue .ch,#fPos .ch,#fDow .ch").forEach(b=>{
  b.addEventListener("click",()=>{ b.classList.toggle("on"); });
});
const chipsOn=id=>Array.from(document.querySelectorAll("#"+id+" .ch.on"))
  .map(b=>b.dataset.v);
// 位置区分の当てはめ。マスターは「外角/外角2/中央外1/内角3…」と細かいので、
// 角台(外角・内角)と、その内側/外側、中央の5つにまとめて選べるようにする。
function posGroup(p){
  if(!p) return "";
  if(p==="外角") return "外角";
  if(p==="内角") return "内角";
  if(p.indexOf("外角")===0) return "外";
  if(p.indexOf("内角")===0) return "内";
  return "中";
}
// ゾロ目の日(1/1・2/2…11/11)。日付ラベルは「M/D(曜)」形式。
function isZoro(lab){
  const m=/^(\d+)\/(\d+)/.exec(lab||"");
  return !!m && m[1]===m[2];
}
// 選んだ曜日・ゾロ目の日だけの差枚合計。選んでいなければ null。
function daySum(dai,sel){
  const m=DATA.machines[dai]; if(!m||!sel.length) return null;
  const L=DATA.labels||[]; let sum=0, n=0;
  m.d.forEach((x,i)=>{
    const lab=L[i]||"";
    const wd=(/\(([^)]+)\)/.exec(lab)||[])[1]||"";
    const hit=sel.some(v=>v==="zoro"?isZoro(lab):v===wd);
    if(hit&&x&&x[0]!=null){ sum+=x[0]; n++; }
  });
  return n?sum:null;
}
// よく使う条件(2026-08-01新設)。押すと一度すべての欄を空にしてから、そのボタンの
// 条件だけを入れて絞り込む。前の条件が残って「なぜか0台」になるのを防ぐため。
document.querySelectorAll(".fpre .pre").forEach(b=>{
  b.addEventListener("click",()=>{
    ["f7min","f7max","fTmin","fTmax","fRmin","fRmax","fDmin","fDmax"].forEach(id=>{
      const el=document.getElementById(id); if(el)el.value="";
    });
    // 指定は data-set="fRmin=105,f7min=1" 形式。**data-fRmin のような書き方は使えない**
    // (HTMLのdata属性は小文字化されるので、大文字を含むid(fRmin)と結び付かない)。
    (b.dataset.set||"").split(",").forEach(kv=>{
      const [k,v]=kv.split("=");
      const el=k&&document.getElementById(k.trim());
      if(el) el.value=(v||"").trim();
    });
    document.getElementById("fApply").click();
  });
});
document.getElementById("fApply").addEventListener("click",()=>{
  // 機種名の入力欄は谷川氏指示で削除(2026-07-31)。数値3条件(直近7日差枚/全期間トータル/
  // 3週間出率)だけで絞り込む。機種名は該当台のラベルが光ることで結果側から分かる。
  const f7min=parseNum("f7min"), f7max=parseNum("f7max");
  const fTmin=parseNum("fTmin"), fTmax=parseNum("fTmax");
  const fRmin=parseNum("fRmin"), fRmax=parseNum("fRmax");
  const fDmin=parseNum("fDmin"), fDmax=parseNum("fDmax");
  const sue=chipsOn("fSue"), pos=chipsOn("fPos"), dow=chipsOn("fDow");
  const active = [f7min,f7max,fTmin,fTmax,fRmin,fRmax,fDmin,fDmax].some(v=>v!=null)
    || sue.length>0 || pos.length>0 || dow.length>0;
  let hitN=0;
  // 検索で付いた「今飛んだ1台」の強調は、条件で絞り直すと意味が変わるので落とす(2026-08-01)。
  document.querySelectorAll(".hitfocus").forEach(x=>x.classList.remove("hitfocus"));
  // 該当台が指す機種名ラベルの座標キー(2026-07-31新設・「機種名も一緒にハイライト」)。
  const hitLbl=new Set();
  document.querySelectorAll(".tap").forEach(el=>{
    const dai=el.dataset.dai, st=filterStats(dai);
    let ok=!!st;
    if(ok && f7min!=null && st.sum7<f7min) ok=false;
    if(ok && f7max!=null && st.sum7>f7max) ok=false;
    if(ok && fTmin!=null && st.total<fTmin) ok=false;
    if(ok && fTmax!=null && st.total>fTmax) ok=false;
    if(ok && fRmin!=null && (st.rate21==null||st.rate21<fRmin)) ok=false;
    if(ok && fRmax!=null && (st.rate21==null||st.rate21>fRmax)) ok=false;
    if(ok && sue.length && sue.indexOf(String(dai).slice(-1))<0) ok=false;
    if(ok && pos.length && pos.indexOf(posGroup((DATA.machines[dai]||{}).p))<0) ok=false;
    if(ok && (fDmin!=null||fDmax!=null)){
      const ds=daySum(dai,dow);
      if(ds==null) ok=false;
      else {
        if(fDmin!=null && ds<fDmin) ok=false;
        if(fDmax!=null && ds>fDmax) ok=false;
      }
    }
    el.classList.toggle("filt-dim", active && !ok);
    el.classList.toggle("filt-hit", active && ok);
    if(active && ok){ hitN++; if(el.dataset.lbl)hitLbl.add(el.dataset.lbl); }
  });
  // 機種名ラベル側(.tapでないdata-lbl保持セル)へ波及させる。該当は光らせ、外れは薄くする。
  document.querySelectorAll("[data-lbl]:not(.tap)").forEach(el=>{
    const on=hitLbl.has(el.dataset.lbl);
    el.classList.toggle("lbl-hit", active && on);
    el.classList.toggle("lbl-dim", active && !on);
  });
  document.getElementById("fCount").textContent = active ? ("該当: "+hitN+"台 / 839台") : "条件を入力して絞り込むボタンを押してください";
});
document.getElementById("fClear").addEventListener("click",()=>{
  ["f7min","f7max","fTmin","fTmax","fRmin","fRmax","fDmin","fDmax"]
    .forEach(id=>{ const el=document.getElementById(id); if(el)el.value=""; });
  document.querySelectorAll("#fSue .ch,#fPos .ch,#fDow .ch")
    .forEach(b=>b.classList.remove("on"));
  clearHits();
  document.getElementById("fCount").textContent="";
  syncUrl();
});
// ---- 検索(2026-08-01・第2段階) ----
// 台番か機種名を入れて該当台へ飛ぶ。結果の見せ方は絞り込みと同じ(該当=黄色・非該当=薄く)に
// そろえ、そのうえで「今飛んだ1台」だけをオレンジの拍動で示す。
// ハイライトの付け外しは絞り込みと共通の関数にして、片方をクリアしたらもう片方も消える
// (2つの仕組みが同じクラスを奪い合って中途半端な状態が残らないようにする)。
function clearHits(){
  document.querySelectorAll(".tap").forEach(el=>{ el.classList.remove("filt-dim","filt-hit","hitfocus"); });
  document.querySelectorAll(".lbl-hit,.lbl-dim").forEach(el=>{ el.classList.remove("lbl-hit","lbl-dim"); });
}
function applyHits(daiSet){
  const hitLbl=new Set();
  document.querySelectorAll(".tap").forEach(el=>{
    const on=daiSet.has(el.dataset.dai);
    el.classList.toggle("filt-hit",on);
    el.classList.toggle("filt-dim",!on);
    if(on&&el.dataset.lbl)hitLbl.add(el.dataset.lbl);
  });
  document.querySelectorAll("[data-lbl]:not(.tap)").forEach(el=>{
    const on=hitLbl.has(el.dataset.lbl);
    el.classList.toggle("lbl-hit",on);
    el.classList.toggle("lbl-dim",!on);
  });
}
// 機種名の表記ゆれ吸収(生成側のPython _loose_norm と同じ考え方をJSへ移したもの)。
// 全角英数→半角・カタカナ→ひらがな・型式の頭の「L/LB」除去・記号と空白の除去。
// 「からくり」で「Lからくりサーカス2」、「ハナハナ」で「ハナハナホウオウ〜」に当たるようにする。
function snorm(s){
  s=String(s||"").toLowerCase();
  s=s.replace(/[Ａ-Ｚａ-ｚ０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  s=s.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
  s=s.replace(/^(lb|l)\s*/,"");
  return s.replace(/[\s・,.。、\-−ー〜~!！?？'"()（）\[\]【】:：;；\/／&＆+＋]/g,"");
}
const SIDX=Object.keys(DATA.machines).map(d=>({d:d,n:DATA.machines[d].n||"",k:snorm(DATA.machines[d].n)}));
const searchModal=document.getElementById("searchModal");
const sq=document.getElementById("sq"),sres=document.getElementById("sres"),sCount=document.getElementById("sCount");
// 該当台へ寄る: 島図ビューに戻し、3.5倍まで拡大して画面中央へ持ってきて、拍動で示す。
function focusDai(dai){
  const el=document.querySelector('.tap[data-dai="'+dai+'"]');
  if(!el)return false;
  if(curView!=="island"){ zoomF=1; setView("island"); }
  const bx=el.offsetLeft+el.offsetWidth/2, by=el.offsetTop+el.offsetHeight/2;
  zoomF=Math.max(zoomF,ZOOM_IN);
  setView(curView,true);
  // 画面(可視領域)の中央へ持ってくる。下端の島などスクロールが端で止まる場合は
  // 行けるところまで(=画面内には必ず入る)。
  const barH=fitBar()||104;
  anchorTo(bx,by,window.innerWidth/2,(window.innerHeight-barH)/2);
  document.querySelectorAll(".hitfocus").forEach(x=>x.classList.remove("hitfocus"));
  void el.offsetWidth;            // 同じ台を続けて押したときもアニメを頭から再生させる
  el.classList.add("hitfocus");
  return true;
}
// ---- 移動台の道すじを見せる(2026-08-04・谷川氏指示) ----
// 「移動台は機種名をタップすると、元々配置されていた位置をゆっくり光点滅させて、
//   そこから矢印をグィーと引っ張って、新しく配置された場所を光点滅させる」
// 島図の上に1本だけSVGを重ねて、元→先の順に見せる。盤面はCSSで拡大縮小するので、
// 座標は**盤面の中の座標(offsetLeft/offsetTop)**で描く(画面pxではない)。
let mvTimers=[], mvRaf=0;
function clearMove(){
  mvTimers.forEach(t=>clearTimeout(t)); mvTimers=[];
  if(mvRaf){ cancelAnimationFrame(mvRaf); mvRaf=0; }
  document.querySelectorAll(".mv-from,.mv-to").forEach(el=>{
    el.classList.remove("mv-from","mv-to");
  });
  const ov=document.getElementById("mvArrow"); if(ov) ov.remove();
  const vl=document.getElementById("mvVeil"); if(vl) vl.remove();
  const cb=document.getElementById("mvClose");
  if(cb) cb.classList.remove("show");
  // 現在地チップは **class で出し入れする**(2026-08-04修正)。ここで
  // style.display を直に書くと、インライン指定が .show より強いため
  // 「移動を1回見たら、拡大しても現在地が二度と出ない」状態になっていた。
  const chip=document.getElementById("whereChip");
  if(chip){ chip.style.display=""; chip.classList.remove("show"); }
  // 道すじを見せるためにフィットより引いていたら、フィットへ戻す(2026-08-10)。
  // 引いたままだと台番が小さいままになり、「全体に戻す」ボタンは zoomF>1 の
  // ときしか出ないので手動では戻せない。
  if(zoomF<1){ zoomF=1; setView(curView,true); }
}
// 見せている物によってボタンの言い方を変える(2026-08-06・谷川氏指示)。
// 道すじ(矢印)を出しているときは「矢印を消す」、増台/減台で台を光らせているだけの
// ときは矢印が無いので「元に戻す」にする。押したときの動きはどちらも clearMove。
function showMvClose(label){
  const b=document.getElementById("mvClose");
  if(!b) return;
  b.textContent="✕ "+label;
  b.setAttribute("aria-label",label);
  b.classList.add("show");
  if(typeof fitTabbar==="function") fitTabbar();
}
function daiBox(list){
  let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9,n=0;
  (list||[]).forEach(d=>{
    const el=document.querySelector('.tap[data-dai="'+d+'"]');
    if(!el) return;
    n++;
    x1=Math.min(x1,el.offsetLeft); y1=Math.min(y1,el.offsetTop);
    x2=Math.max(x2,el.offsetLeft+el.offsetWidth);
    y2=Math.max(y2,el.offsetTop+el.offsetHeight);
  });
  return n?{x1:x1,y1:y1,x2:x2,y2:y2,cx:(x1+x2)/2,cy:(y1+y2)/2}:null;
}
function markDais(list,cls){
  (list||[]).forEach(d=>{
    const el=document.querySelector('.tap[data-dai="'+d+'"]');
    if(el) el.classList.add(cls);
  });
}
function showMove(from,to,name){
  clearHits(); clearMove();
  if(curView!=="island"){ zoomF=1; setView("island"); }
  const board=document.getElementById("board");
  const a=daiBox(from), b=daiBox(to);
  if(!board||!a||!b) return false;
  // 元と先の両方が入るように、いったん全体表示へ戻す(離れた島へ動くことが多いため)
  zoomF=1; setView(curView,true);
  // 少し曲げて引っ張る(直線だと島の上を横切って何を指しているか分かりにくい)
  const mx=(a.cx+b.cx)/2, my=(a.cy+b.cy)/2;
  const dx=b.cx-a.cx, dy=b.cy-a.cy, len=Math.hypot(dx,dy)||1;
  const bend=Math.min(len*0.22,220);
  const px=mx-dy/len*bend, py=my+dx/len*bend;
  const d="M "+a.cx+" "+a.cy+" Q "+px+" "+py+" "+b.cx+" "+b.cy;
  // **フィットより引いて、矢印の全体を画面に入れる**(2026-08-10・谷川氏報告
  // 「矢印やはり出ません＝全体表示に戻るだけ」の真因)。島図のフィット(setView)は
  // **高さ合わせ**なので、盤面は画面より横に広い(実測: 幅390pxの画面で盤面1279px)。
  // 真ん中を画面中央へ寄せるだけだと、盤面を横断する移動は両端が画面の外へ出る。
  // からくり2の実測値は 元 x=-125〜-50(左外) / 穂先 x=441〜458(右外)で、
  // 見えていたのは線の途中だけ＝「何も起きていない」ように見えていた。
  // 元・先・曲がりの制御点を全部含む箱が収まる倍率まで引く。ここだけ zoomF が
  // 1 を下回る(下限0.15は引きすぎ防止)。消したときは clearMove が 1 へ戻す。
  const barH0=fitBar()||104;
  zoomF=Math.min(1,lightZoom({x1:Math.min(a.x1,b.x1,px),y1:Math.min(a.y1,b.y1,py),
                              x2:Math.max(a.x2,b.x2,px),y2:Math.max(a.y2,b.y2,py)},
                             barH0,0.15));
  if(zoomF!==1) setView(curView,true);
  const ov=document.createElementNS("http://www.w3.org/2000/svg","svg");
  ov.id="mvArrow";
  // **SVGは線の周りだけに縮める**(2026-08-10・谷川氏報告「からくり2の矢印を押すと
  // エラーになって画面が切り替わる」の真因)。それまでは盤面と同じ5642x3247で敷いて
  // いた。線を伸ばすアニメーションは毎フレーム stroke-dashoffset を書き換えるので、
  // **線の外接矩形の全体**が描き直しの対象になる。この矩形は移動距離とともに広がり、
  // からくり2(元=左下2135付近 → 先=右上3220付近・直線距離3305px)では盤面の52パーセント
  // を覆う。次点の北斗で27パーセント、他の19機種は全部10パーセント未満で、
  // 実機でも「からくり2と北斗だけ落ちて短い移動の機種は出る」と一致した。
  // 二次ベジェは3つの制御点の凸包から出ないので、その外接矩形に線の太さと穂先の分を
  // 足した大きさがあれば足りる。viewBox の原点をずらせば線の座標(盤面座標)はそのまま使える。
  const sc0=curSc||1;
  const PAD=Math.max(24,14/sc0);                 // 線の太さ(glow)と穂先がはみ出す分
  const bx1=Math.min(a.cx,b.cx,px)-PAD, by1=Math.min(a.cy,b.cy,py)-PAD;
  const bx2=Math.max(a.cx,b.cx,px)+PAD, by2=Math.max(a.cy,b.cy,py)+PAD;
  const bw=Math.max(1,bx2-bx1), bh=Math.max(1,by2-by1);
  ov.style.left=bx1+"px"; ov.style.top=by1+"px";
  ov.setAttribute("width",bw);
  ov.setAttribute("height",bh);
  ov.setAttribute("viewBox",bx1+" "+by1+" "+bw+" "+bh);
  // **矢印そのものは押しても消えない**(2026-08-05・谷川氏指示「矢印本体を押した時に
  // 解除しないように。解除は矢印を消すボタンだけにして」)。2026-08-04は矢印を押しても
  // 消せる作りにしていたが、線は盤面の広い範囲を横切るので、台を見ようとして触った
  // だけで消えてしまう。当たり判定用の透明な太線(.mvhit)ごと外し、矢印は指を
  // 素通りさせる=線の下にある台番セルはこれまでどおり押せる。
  // **穂先は線と一緒に進ませる**(2026-08-04・谷川氏指摘「三角は伸びていくときに
  // 一緒に動いていくのが普通だよね」)。SVGの marker-end は線の終点にいきなり描かれ、
  // 線が伸びている間も動かないので使わない。穂先は別のパスにして、毎フレーム
  // getPointAtLength() で今の先端へ置き、進む向きへ回す。
  // 影を薄く1枚敷くと、暗くした盤面の上でも線が沈まない(色は足さない)。
  ov.innerHTML='<path class="mvglow" d="'+d+'" fill="none" stroke="rgba(0,0,0,.45)"'
    +' stroke-linecap="round"/>'
    +'<path class="mvpath" d="'+d+'" fill="none" stroke="#ff9800"'
    +' stroke-linecap="round"/>'
    +'<path class="mvhead" d="M -7.5 -5.6 L 5.4 0 L -7.5 5.6 Q -4.2 0 -7.5 -5.6 Z"'
    +' fill="#ff9800"/>';
  // 他の台を暗くする幕(2026-08-04・谷川氏指示)。盤面と同じ大きさで敷き、
  // 元と先の台(z-index:11)だけが幕の上に残る。
  const veil=document.createElement("div");
  veil.id="mvVeil";
  veil.style.width=board.offsetWidth+"px";
  veil.style.height=board.offsetHeight+"px";
  board.appendChild(veil);
  board.appendChild(ov);
  showMvClose("矢印を消す");
  // 元と先の真ん中を画面の中央へ持ってくる(盤面は横に長く、フィット表示でも
  // 端は画面の外にあるため。これが無いと矢印が見えないまま終わる)
  const barH=fitBar()||104;
  anchorTo(mx,my,window.innerWidth/2,(window.innerHeight-barH)/2);
  const path=ov.querySelector(".mvpath");
  const glow=ov.querySelector(".mvglow");
  const head=ov.querySelector(".mvhead");
  const L=path.getTotalLength();
  // **穂先は新しい台の外枠で止める**(2026-08-05・谷川氏指示「到着したときに隠れて
  // しまう台番の外枠あたりで止まればよい」)。終点は台番の集まりの中心なので、
  // そのまま進むと穂先が台の上に乗って何を指しているのか分からなくなる。
  // 終点側から少しずつ戻り、箱の外へ出た所を到着点にする。
  let Lend=L;
  {const inBox=(pt)=>pt.x>=b.x1-2&&pt.x<=b.x2+2&&pt.y>=b.y1-2&&pt.y<=b.y2+2;
   const step=Math.max(2,L/240);
   let s=L;
   while(s>0&&inBox(path.getPointAtLength(s))) s-=step;
   // 箱同士が大きく重なっている機種(島の中の短い移動)は、削ると線が消えてしまう。
   // その場合は削らない(矢印は台より前に描くので隠れない)。
   if(s>L*0.25) Lend=s;}
  [path,glow].forEach(p=>{ p.style.strokeDasharray=L; p.style.strokeDashoffset=L; });
  ov.style.opacity="0";
  // **線と穂先は同じ1つの進み具合(rAF)で描く**。CSSのtransitionで線だけ動かすと、
  // 穂先の位置を別に計算することになり、機種によって数十px先行/遅れる。
  const put=(e)=>{
    const s=Lend*e;
    path.style.strokeDashoffset=String(L-s);
    glow.style.strokeDashoffset=String(L-s);
    const p1=path.getPointAtLength(s);
    const p0=path.getPointAtLength(Math.max(0,s-1.5));
    const ang=Math.atan2(p1.y-p0.y,p1.x-p0.x)*180/Math.PI;
    // 穂先の大きさは**画面上で一定**にする(盤面はCSSで縮小されるため)
    const sc=1/(curSc||1);
    head.setAttribute("transform","translate("+p1.x+" "+p1.y+") rotate("+ang
                      +") scale("+sc+")");
  };
  const slow=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  markDais(from,"mv-from");
  // **矢印は最初から見える状態で置く**(2026-08-05・谷川氏報告「普通に機種名タップすると
  // 画面が点滅して全体画面にもどるだけで矢印アニメーションでません」)。
  // それまでは1.1秒のあいだ opacity:0 で完全に隠し、タイマーで動かし始めていた。
  // iOSはスクロールの慣性が残っている間などにタイマーや rAF を遅らせるので、
  // 「暗くなるだけで何も出ない」ように見える時間が長かった。
  // いまは押した瞬間に穂先が元の位置に立つ(見えている)。
  put(0.02);
  ov.style.opacity="1";
  const finish=()=>{
    if(mvRaf){ cancelAnimationFrame(mvRaf); mvRaf=0; }
    put(1); head.classList.add("arrived"); markDais(to,"mv-to");
  };
  if(slow){ finish(); }                       // 動きを減らす設定では一気に出す
  else {
    const DUR=1400, t0=(window.performance&&performance.now)?performance.now():Date.now();
    let done=false;
    const step=(ts)=>{
      const now=(typeof ts==="number")?ts
        :((window.performance&&performance.now)?performance.now():Date.now());
      const p=Math.min(1,(now-t0)/DUR);
      // 出だしはゆっくり・中ほどで速く・着地でまた静かに(easeInOutCubic)
      const e=p<0.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;
      put(e);
      if(p<1){ mvRaf=requestAnimationFrame(step); }
      else if(!done){ done=true; mvRaf=0; head.classList.add("arrived");
                      markDais(to,"mv-to"); }
    };
    mvRaf=requestAnimationFrame(step);
    // **保険**: rAF が止められていても必ず着地させる(端末の省電力や別タブへの
    // 切替で rAF は止まる。止まったまま線が途中で固まるのを防ぐ)。
    mvTimers.push(setTimeout(()=>{ if(!done){ done=true; finish(); } },DUR+900));
  }
  // 見終わったら自動で消す(消し忘れて島図が光ったままにならないように)。
  // 2026-08-05に「解除はボタンだけ」の指示へ合わせて一度外したが、**谷川氏の指示で
  // 戻した**(同日)。指で押して消えるのが困るという趣旨であって、時間切れは残す。
  mvTimers.push(setTimeout(clearMove,14000));
  const chip=document.getElementById("whereChip");
  if(chip){ chip.textContent=name+" の移動"; chip.style.display="";
            chip.classList.add("show");
            mvTimers.push(setTimeout(()=>{ chip.classList.remove("show"); },5000)); }
  return true;
}

// 増台・減台は **その台番を光らせるだけ** にする(2026-08-05・谷川氏指示「増台、減台の
// 機種名もタップしたらそれぞれ、増台した台番、減台した台番が光点滅、周り暗い状態に
// なるようにしてください」)。増えただけ/減っただけの機種は行き先も出どころも無いので
// 矢印が引けない。幕・光り方・消し方は移動の道すじと同じものを使い回す。
//   増台 … その日にこの機種になった台番(iretae.json の dai)
//   減台 … その日にこの機種でなくなった台番(同 gone)
// 光らせた台の集まり(daiBoxの結果)が画面に収まる自前ズームの倍率を返す(2026-08-06)。
// baseSc はフィット表示の倍率なので、盤面の寸法に掛けて画面上の大きさに直してから比べる。
// 周りの台も見えるように箱の1.35倍を「入るべき大きさ」として数える(ぴったり寄せると
// その台が島のどのあたりに居るのか分からなくなる)。上限はダブルタップと同じ3.5倍。
// minZ は倍率の下限(既定1=フィットより寄ることはあっても引くことはしない)。
// 道すじの矢印だけは 1 を下回らせる=フィットより引く(2026-08-10。理由は showMove 側)。
function lightZoom(a,barH,minZ){
  const availW=Math.max(80,window.innerWidth-8);
  const availH=Math.max(80,window.innerHeight-barH-8);
  const bw=Math.max(1,a.x2-a.x1)*1.35*baseSc;
  const bh=Math.max(1,a.y2-a.y1)*1.35*baseSc;
  return Math.max(minZ===undefined?1:minZ,Math.min(ZOOM_IN,Math.min(availW/bw,availH/bh)));
}
function showLights(dais, name, kind) {
  clearHits(); clearMove();
  if(curView!=="island"){ zoomF=1; setView("island"); }
  const board=document.getElementById("board");
  const a=daiBox(dais);
  if(!board||!a) return false;
  zoomF=1; setView(curView,true);
  const veil=document.createElement("div");
  veil.id="mvVeil";
  veil.style.width=board.offsetWidth+"px";
  veil.style.height=board.offsetHeight+"px";
  board.appendChild(veil);
  // 減台は「元は此処に居た」ので出発点と同じ橙、増台は「新しく入った」ので到着と同じ黄。
  markDais(dais, kind==="minus" ? "mv-from" : "mv-to");
  // 矢印は出していないので「矢印を消す」では意味が通らない(2026-08-06・谷川氏指示
  // 「減台、増台した台を光らせた時は矢印を消すボタンの表示ではなく、元に戻す」)。
  showMvClose("元に戻す");
  // 光らせた台の付近まで寄る(2026-08-06・谷川氏指示「増台、減台の台を光らせた時は
  // その付近をズーム表示するようにする」)。それまでは全体表示のまま中心を合わせるだけで、
  // フィット表示の台番セルは画面上21x12pxしかなく、どこが光っているのか分からなかった。
  // 入り切らないほど散らばっているときは1倍(=全体表示)のまま、今までどおり見せる。
  const barH=fitBar()||104;
  zoomF=lightZoom(a,barH);
  setView(curView,true);
  anchorTo(a.cx,a.cy,window.innerWidth/2,(window.innerHeight-barH)/2);
  mvTimers.push(setTimeout(clearMove,14000));
  const chip=document.getElementById("whereChip");
  if(chip){ chip.textContent=name+(kind==="minus"?" の減台 ":" の増台 ")+dais.length+"台";
            chip.style.display=""; chip.classList.add("show");
            mvTimers.push(setTimeout(()=>{ chip.classList.remove("show"); },5000)); }
  return true;
}

// 機種名を押したときの選択肢(2026-08-05・谷川氏指示「機種名タップ時にそれぞれ選択肢を
// 出すようにして、選択肢をタップして動作するようにしてください」)。
// それまでは入替のあった機種は問答無用で場所の表示になり、スペックが開けなかった。
// choices = [{t:見出し, r:押したときの動き}, ...]
let actRun=[];
function pickAction(name,choices){
  const ov=document.getElementById("actPick");
  const ti=document.getElementById("actTitle");
  const ls=document.getElementById("actList");
  // 器が無い版(古いHTMLを掴んだとき)は、選択肢を出さず先頭の動きをそのまま行う
  if(!ov||!ls){ if(choices[0]) choices[0].r(); return; }
  actRun=choices.map(c=>c.r);
  if(ti) ti.textContent=name;
  ls.innerHTML=choices.map((c,i)=>
    '<button class="apbtn" type="button" data-i="'+i+'">'+esc(c.t)+'</button>').join("");
  ov.hidden=false;
}
function pickClose(){ const ov=document.getElementById("actPick"); if(ov) ov.hidden=true; }
(function(){
  const ov=document.getElementById("actPick");
  if(!ov) return;
  ov.addEventListener("click",e=>{
    const b=e.target.closest&&e.target.closest(".apbtn");
    if(b){ const i=+b.dataset.i; pickClose(); if(actRun[i]) actRun[i](); return; }
    // 「閉じる」か、カードの外(背景)を押したら引っ込める
    if((e.target.closest&&e.target.closest("#actClose"))||e.target===ov) pickClose();
  });
})();
// 機種名から出せる選択肢を組み立てる。入替の動きが無い機種は null(=スペックを直に開く)。
function actChoices(nm,mv,li){
  if(mv) return [{t:"機種スペックを見る",r:()=>openSpec(nm)},
                 {t:"元の位置→今の位置を矢印で見る（"+mv.t.length+"台）",
                  r:()=>showMove(mv.f,mv.t,nm)}];
  if(li) return [{t:"機種スペックを見る",r:()=>openSpec(nm)},
                 {t:(li.k==="minus"?"減った台番":"増えた台番")
                    +"を光らせる（"+li.d.length+"台）",
                  r:()=>showLights(li.d,nm,li.k)}];
  return null;
}

// 島図の機種名ラベルからも道すじを出す(2026-08-04・谷川氏指示
// 「島図の機種名をタップしたときに道筋でるようにしてください」)。
// 入替の内訳(iretae.json)を1回だけ読んで「機種名 → 元の台番/新しい台番」を持つ。
// LIGHTS は「矢印は引けないが光らせられる機種」(増台・減台)。2026-08-05追加。
// NEWSET は新台の機種名。島図xlsxの機種名ラベルの下地は **新台も増台も同じ薄赤**
// (apply_iretae_style.py の FILL_NEW=FFC7CE)で見分けが付かないので、
// 入替の内訳から新台だけを拾って画面側で塗り替える
// (2026-08-05・谷川氏指示「新台と増台が同じ機種名の薄赤になってるので新台は違う色に
//   して常にゆらゆら燃えてるエフェクトをかけて欲しい」)。
let MOVES=null, LIGHTS=null, NEWSET=null, movesP=null;
function movesLoad(){
  if(movesP) return movesP;
  movesP=fetch("iretae.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(ir=>{
      MOVES={}; LIGHTS={}; NEWSET=new Set();
      // **「移動台」の区分だけを見ない**(2026-08-04・谷川氏指摘「からくり2はもともと
      // 禁書2の場所あたりにあったよね?」)。島ごと引っ越して台数も変わった機種は
      // 増台/減台に分類されるので、区分で絞ると道すじが出なかった。
      // 元の台番(from)と新しい台番(dai)の両方を持っている物はすべて道すじを出せる。
      ((ir&&ir.cats)||[]).forEach(c=>{
        (c.items||[]).forEach(it=>{
          const k=snorm(it.name);
          if(c.key==="new") NEWSET.add(k);     // 新台のラベルを燃やす(2026-08-05)
          if(it.from&&it.from.length&&it.dai&&it.dai.length){
            MOVES[k]={f:it.from,t:it.dai,n:it.name};
            return;                      // 道すじが引ける機種はそちらを優先する
          }
          // 片方しか無い機種は光らせるだけにする(2026-08-05・谷川氏指示)。
          //   増台 … その日にこの機種になった台番(dai)が増えた台
          //   減台 … その日にこの機種でなくなった台番(gone)が減った台
          if(c.key==="plus"&&it.dai&&it.dai.length)
            LIGHTS[k]={d:it.dai,n:it.name,k:"plus"};
          else if(c.key==="minus"&&it.gone&&it.gone.length)
            LIGHTS[k]={d:it.gone,n:it.name,k:"minus"};
        });
      });
      // 中身が空(取れなかった)ときは覚え込まない。**次に押したときに取り直す**
      // (2026-08-05修正。電波が弱い一瞬に押すと、以後ずっと道すじが出ない状態だった)
      if(!Object.keys(MOVES).length&&!Object.keys(LIGHTS).length&&!NEWSET.size)
        movesP=null;
      return MOVES;
    }).catch(()=>{ MOVES={}; LIGHTS={}; NEWSET=new Set(); movesP=null; return MOVES; });
  return movesP;
}
// 新台の機種名ラベルに印を付ける。塗り替えと炎の動きはCSS(.lbl-new)が持つ。
// 期間を切り替えるとセルごと貼り替わるので、そのたびに付け直す。
function paintNewLabels(){
  if(!NEWSET||!NEWSET.size) return;
  document.querySelectorAll(".lbl-new").forEach(el=>el.classList.remove("lbl-new"));
  document.querySelectorAll("[data-lbl]:not(.tap)").forEach(el=>{
    const nm=nameOfLbl(el.dataset.lbl);
    if(nm&&NEWSET.has(snorm(nm))) el.classList.add("lbl-new");
  });
}
window.addEventListener("shimaheat-period",()=>{ paintNewLabels(); });
// 起動時に1回。iretae.json は movesLoad が覚えるので、あとの機種名タップは待たされない。
movesLoad().then(()=>paintNewLabels()).catch(()=>{});
// ラベルのキー(data-lbl)から機種名を引く。ラベル自身は文字を短縮してあるので、
// **同じキーを持つ台番セルの機種名**を使う(略称と正式名の食い違いを避ける)。
function nameOfLbl(key){
  const t=document.querySelector('.tap[data-lbl="'+CSS.escape(key)+'"]');
  const m=t&&DATA.machines[t.dataset.dai];
  return m?m.n:"";
}
document.getElementById("board").addEventListener("click",e=>{
  if(Date.now()-panAt<320) return;         // 島図を払った直後のクリックは捨てる
  const el=e.target.closest&&e.target.closest("[data-lbl]:not(.tap)");
  if(!el||!el.dataset.lbl) return;
  const nm=nameOfLbl(el.dataset.lbl);
  if(!nm) return;
  movesLoad().then(M=>{
    const k=snorm(nm);
    // 入替の動きがある機種は選択肢を出す(2026-08-05)。無い機種は今までどおり直にスペック。
    const ch=actChoices(nm,M[k],LIGHTS&&LIGHTS[k]);
    if(ch) pickAction(nm,ch);
    else openSpec(nm);
  });
});

let sHits=[];
function runSearch(){
  const raw=(sq.value||"").trim();
  sHits=[];
  if(!raw){ sres.innerHTML=""; sCount.textContent=""; clearHits(); syncUrl(); return; }
  if(/^\d+$/.test(raw)){
    // 台番: 完全一致→前方一致→部分一致の順に、見つかった段で打ち切る
    sHits=SIDX.filter(o=>o.d===raw);
    if(!sHits.length) sHits=SIDX.filter(o=>o.d.indexOf(raw)===0);
    if(!sHits.length) sHits=SIDX.filter(o=>o.d.indexOf(raw)>=0);
  }else{
    const k=snorm(raw);
    if(k) sHits=SIDX.filter(o=>o.k.indexOf(k)>=0);
  }
  sHits.sort((a,b)=>(parseInt(a.d,10)||0)-(parseInt(b.d,10)||0));
  sCount.textContent = sHits.length ? ("該当: "+sHits.length+"台"+(sHits.length>60?"(先頭60台を表示)":""))
                                    : "該当する台がありません";
  sres.innerHTML = sHits.slice(0,60).map(o=>
    '<button class="sitem" data-d="'+o.d+'"><b>'+esc(o.d)+'</b><span>'+esc(o.n)+'</span></button>').join("");
  if(sHits.length) applyHits(new Set(sHits.map(o=>o.d))); else clearHits();
  syncUrl();
}
let sTimer=null;
sq.addEventListener("input",()=>{ clearTimeout(sTimer); sTimer=setTimeout(runSearch,140); });
// キーボードの「検索」で先頭の候補へ飛ぶ(候補が1件のときはそのまま目的の台)。
sq.addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;
  e.preventDefault(); clearTimeout(sTimer); runSearch();
  if(sHits.length){ sq.blur(); searchModal.style.display="none"; focusDai(sHits[0].d); }
});
sres.addEventListener("click",e=>{
  const b=e.target.closest?e.target.closest(".sitem"):null;
  if(!b)return;
  sq.blur(); searchModal.style.display="none";
  focusDai(b.dataset.d);
});
document.getElementById("searchBtn").addEventListener("click",()=>{
  searchModal.style.display="block";
  fitSearchModal();
  requestAnimationFrame(()=>{ if(searchModal.style.display==="block")fitSearchModal(); });
});
document.getElementById("searchClose").addEventListener("click",()=>{ searchModal.style.display="none"; });
searchModal.addEventListener("click",e=>{ if(e.target.id==="searchModal") searchModal.style.display="none"; });
document.getElementById("sClear").addEventListener("click",()=>{
  sq.value=""; sres.innerHTML=""; sCount.textContent=""; sHits=[]; clearHits(); syncUrl();
});
// ---- 状態のURL反映(2026-08-01・第3段階) ----
// 「いま見ているもの」をURLに載せて、そのまま人に送れる/開き直せるようにする。
//   p=期間(single/wed/last7/all) ※既定の直近7日のときは付けない
//   v=docs   資料ビューのときだけ
//   q=検索語 (機種名や台番)
//   d=台番   台番カードを開いているとき
//   w=グラフ期間(7/21/0) ※dがあるときだけ意味を持つ
// 拡大率とスクロール位置は端末の画面サイズで見え方が変わるのでURLには入れない。
// 代わりにdがあれば開いた側でその台まで寄せる(focusDai)ので、狙いは同じことができる。
// 履歴はreplaceStateで書き換える(戻るボタンの履歴を汚さない)。
function syncUrl(){
  if(urlLock)return;
  const u=new URLSearchParams();
  if(curPeriod&&curPeriod!=="last7") u.set("p",curPeriod);
  if(curView==="docs") u.set("v","docs");
  const q=(document.getElementById("sq").value||"").trim();
  if(q) u.set("q",q);
  if(document.getElementById("modal").style.display==="block"&&curDai){
    u.set("d",curDai);
    if(curWin!==NDAYS) u.set("w",String(curWin));
  }
  const s=u.toString();
  const url=location.pathname+(s?"?"+s:"");
  // 台番カードが開いた瞬間だけ履歴を1つ積む(2026-08-01)。
  // Androidの戻る操作・端末のスワイプバックで「カードだけ閉じる」ようにするため。
  // それ以外(期間切替・検索・資料)は従来どおり書き換えのみ=戻る操作の履歴を汚さない。
  const open=document.getElementById("modal").style.display==="block"&&!!curDai;
  try{
    if(open&&!cardPushed){ history.pushState({shimaheatCard:1},"",url); cardPushed=true; }
    else{ history.replaceState(open?{shimaheatCard:1}:null,"",url); }
  }catch(e){}
}
// 戻る操作(popstate)でカードを閉じる。閉じる側からは history.back() を呼んで
// 同じ経路に寄せる=履歴が片方向に伸び続けない。(宣言はスクリプト前方)
window.addEventListener("popstate",()=>{
  cardPushed=false;
  const md=document.getElementById("modal");
  if(md&&md.style.display==="block"){ backClosing=true; closeCard(true); backClosing=false; }
});
function restoreFromUrl(){
  const u=INIT_Q;
  if(!u.toString())return;
  urlLock=true;
  try{
    // 期間(p)は初期化時にURL優先で適用済みなのでここでは触らない。
    if(u.get("v")==="docs") setView("docs");
    const q=u.get("q");
    if(q){ document.getElementById("sq").value=q; runSearch(); }
    const d=u.get("d");
    if(d&&DATA.machines[d]){
      const w=parseInt(u.get("w"),10);
      // 島図ビューのときだけ台まで寄せる(資料ビューで開かれたら位置合わせはしない)
      if(curView==="island") focusDai(d);
      renderCard(d,isNaN(w)?curWin:w);
    }
  }catch(e){}
  urlLock=false;
  syncUrl();
}
// 台番カード・検索・期間・ビューのどれが変わってもURLを取り直す。
document.getElementById("modal").addEventListener("click",()=>setTimeout(syncUrl,0));
document.getElementById("searchBtn").addEventListener("click",()=>setTimeout(syncUrl,0));
// 共有ボタン。標準の共有シートが使えれば使い、無ければURLをコピーする。
document.getElementById("shareBtn").addEventListener("click",async e=>{
  e.stopPropagation();
  syncUrl();
  const url=location.href;
  const title=curDai?("台"+curDai+" ／ "+(DATA.machines[curDai]||{}).n):"熱田 島図ヒート";
  try{
    if(navigator.share){ await navigator.share({title:title,url:url}); return; }
  }catch(err){ if(String(err&&err.name)==="AbortError")return; }
  try{ await navigator.clipboard.writeText(url); showToast("URLをコピーしました",2200); }
  catch(err){ showToast("URLをコピーできませんでした",2200); }
});
// ---- つまみを上へスワイプして閉じる(2026-08-01・上端シート化で向きを反転) ----
// 受け付けるのは「つまみ」だけにする。カード本体でも拾うと、表を上下にスクロールしたい
// だけの操作が閉じる動作と取り合いになる(中身が21〜52行あるので致命的)。
// 判定は「90px以上上げた」か「速く払い上げた(0.5px/ms以上)」。指を離した位置だけでなく
// 動かし方も見るのは、短くさっと払う操作でも閉じられるようにするため。
// 向きはシートの貼り付き先と必ずそろえる(上端に貼るなら上へ払って消す)。逆向きに動かすと
// 画面外の何もない側へ引っ張ることになり、どちらへ払えば消えるのかが分からなくなる。
(()=>{
  const card=document.getElementById("card");
  const grip=document.getElementById("cardGrip");
  let y0=0,t0=0,dy=0,active=false;
  const scaleNow=()=>{ const vv=window.visualViewport; return (vv&&vv.scale)?vv.scale:1; };
  const start=y=>{ active=true; dy=0; y0=y; t0=Date.now(); card.classList.add("dragging"); };
  const move=y=>{
    if(!active)return;
    dy=Math.max(0,y0-y);                       // 下方向へは動かさない(伸びない)
    const s=scaleNow();
    card.style.transform=`translateY(${(-dy*s).toFixed(1)}px) scale(${1/s})`;
  };
  const end=()=>{
    if(!active)return;
    active=false;
    const v=dy/Math.max(1,Date.now()-t0);      // px/ms
    if(dy>90||v>0.5){ closeCard(true); return; }
    card.classList.remove("dragging");         // 戻す(transitionが効く)
    const s=scaleNow();
    card.style.transform=`scale(${1/s})`;
  };
  // 掴める範囲はつまみ本体と、その真上に重ねた透明な帯(#gripExt)の2つ。
  // 細いバーだけを狙わせない=指の太さで外しても同じ操作になる。
  // 2026-08-01の下部移設まで受け口は「見出し行」「機種名の行」だったが、つまみが
  // 下へ移ったのでカードの上端側は普通の文字(選択・スクロールできる)に戻した。
  const ext=document.getElementById("gripExt");
  for(const el of [grip,ext]){
    el.addEventListener("touchstart",e=>{ start(e.touches[0].clientY); },{passive:true});
    el.addEventListener("touchmove",e=>{ move(e.touches[0].clientY); e.preventDefault(); },{passive:false});
    el.addEventListener("touchend",end);
    el.addEventListener("touchcancel",end);
    // マウス(PC・検証)でも同じように動かせるようにしておく
    el.addEventListener("mousedown",e=>{ start(e.clientY); e.preventDefault(); });
  }
  window.addEventListener("mousemove",e=>{ if(active) move(e.clientY); });
  window.addEventListener("mouseup",end);
  // つまみを押すだけ(動かさない)でも閉じられる=タップの逃げ道。
  // これは見た目のバーがある本体だけ。延長部は表が見えている場所なので、押しただけで
  // 閉じると誤操作に見える(払う操作のときだけ閉じる)。
  // 2026-08-01: 延長部をつまみの子要素にしたので、クリックが本体へ上がってくる。
  // 発生元が本体そのもの(e.target===grip)のときだけ閉じる。
  grip.addEventListener("click",e=>{ if(e.target!==grip) return; if(dy<6) closeCard(true); });
})();
restoreFromUrl();
// ---- データの鮮度表示とオフライン対応(2026-08-01・第4段階) ----
// 画面に「いつ時点のデータか」を常に出す。裏で新しい版が用意できたら、その行を
// 押せる案内に変えて読み込み直す。Service Workerは前回の内容を即出して
// (ホール内は電波が弱いことがある)、裏で最新に入れ替える。
// ---- ピン留め(2026-08-01) ----
// 気になる台を覚えておいて、翌日以降も1タップで開けるようにする。
// 保存はlocalStorage(端末内)。台番の配列だけを持つ=データが入れ替わっても壊れない。
const PIN_KEY="shimaheat-pins";
function loadPins(){
  try{ const v=JSON.parse(localStorage.getItem(PIN_KEY)||"[]");
       return Array.isArray(v)?v.map(String):[]; }catch(e){ return []; }
}
function savePins(a){ try{ localStorage.setItem(PIN_KEY,JSON.stringify(a)); }catch(e){} }
function paintPins(){
  const pins=loadPins();
  document.querySelectorAll(".tap.pinned").forEach(el=>el.classList.remove("pinned"));
  pins.forEach(d=>{
    const el=document.querySelector('.tap[data-dai="'+d+'"]');
    if(el) el.classList.add("pinned");
  });
  const box=document.getElementById("pinList");
  if(box){
    // 2026-08-02: 1件ずつ外せるように、チップを「台番(押すと飛ぶ)」と「✕(外す)」の
    // 2つのボタンに分けた。従来は外す手段がカードの★しか無かった。
    box.innerHTML=pins.length
      ? pins.map(d=>{ const m=DATA.machines[d]||{};
          return '<span class="pinchip"><button class="go" data-dai="'+d+'">台'+d
               + (m.n?" "+esc(m.n.slice(0,10)):"")+'</button>'
               + '<button class="rm" data-dai="'+d+'" aria-label="台'+d
               + 'のピンを外す">✕</button></span>'; }).join("")
      : '<div class="none">まだありません。台番カードの★で追加できます。</div>';
    box.querySelectorAll(".go").forEach(b=>{
      b.addEventListener("click",()=>{
        document.getElementById("searchModal").style.display="none";
        focusDai(b.dataset.dai);
        renderCard(b.dataset.dai,winForBoard());
      });
    });
    box.querySelectorAll(".rm").forEach(b=>{
      b.addEventListener("click",e=>{
        e.stopPropagation();
        const d=b.dataset.dai;
        savePins(loadPins().filter(x=>x!==d));
        paintPins();
        showToast("台"+d+" のピンを外しました",1600);
      });
    });
  }
  const pc=document.getElementById("pinClear");
  if(pc){ pc.hidden=!pins.length; if(!pins.length) pinAskOff(); }
  const btn=document.getElementById("pinBtn");
  if(btn&&curDai) btn.classList.toggle("is-on",pins.indexOf(String(curDai))>=0);
}
// 「すべて外す」は取り返しがつかないので2度押しにする(端末の確認ダイアログは使わない=
// PWAでは唐突に見えるため)。1度目は文言が変わり、3.5秒で元に戻る。
// **タイマーの宣言はスクリプト前方**(urlLockの隣)。paintPins()は初期化中の
// applyPeriod()からも呼ばれるので、ここでletを宣言するとTDZで初期化ごと落ちる。
function pinAskOff(){
  clearTimeout(pinAskTimer); pinAskTimer=0;
  const pc=document.getElementById("pinClear");
  if(pc){ pc.classList.remove("ask"); pc.textContent="すべて外す"; }
}
(()=>{
  const pc=document.getElementById("pinClear");
  if(!pc)return;
  pc.addEventListener("click",e=>{
    e.stopPropagation();
    if(pc.classList.contains("ask")){
      const n=loadPins().length;
      savePins([]); pinAskOff(); paintPins();
      showToast("ピンを"+n+"件すべて外しました",2000);
      return;
    }
    pc.classList.add("ask");
    pc.textContent="もう一度で全部外す";   // 幅の狭い端末でも見出しと同じ行に収まる長さ
    clearTimeout(pinAskTimer);
    pinAskTimer=setTimeout(pinAskOff,3500);
  });
})();
document.getElementById("pinBtn").addEventListener("click",e=>{
  e.stopPropagation();
  if(!curDai)return;
  const d=String(curDai), pins=loadPins(), i=pins.indexOf(d);
  if(i>=0){ pins.splice(i,1); showToast("ピンを外しました",1600); }
  else{ pins.unshift(d); showToast("ピン留めしました(検索から開けます)",2000); }
  savePins(pins.slice(0,40));
  paintPins();
});
paintPins();   // 起動時にピンの印を付ける
// ---- 拡大中の現在地(2026-08-01) ----
// 画面のまんなかにある台を拾って「機種名 台番あたり」を出す。拡大していないときは
// 全体が見えているので出さない。判定は elementFromPoint=実際にそこに見えている物。
function updateWhere(){
  const chip=document.getElementById("whereChip");
  if(!chip)return;
  const modalOpen=document.getElementById("modal").style.display==="block";
  if(zoomF<=1.05||curView!=="island"||modalOpen){ chip.classList.remove("show"); return; }
  const vv=window.visualViewport;
  const cx=(vv?vv.offsetLeft+vv.width/2:window.innerWidth/2);
  const cy=(vv?vv.offsetTop+vv.height/2:window.innerHeight/2);
  const el=document.elementFromPoint(cx,cy);
  const tap=el&&el.closest?el.closest(".tap"):null;
  let txt="";
  if(tap){
    const dai=tap.dataset.dai, m=DATA.machines[dai];
    txt=(m&&m.n?m.n+"　":"")+"台"+dai+" あたり";
  }else if(el&&el.closest){
    const c=el.closest(".cell");
    const t=c&&c.textContent?c.textContent.trim():"";
    if(t) txt=t.replace(/\s+/g," ").slice(0,24);
  }
  if(!txt){ chip.classList.remove("show"); return; }
  chip.textContent=txt;
  chip.classList.add("show");
}
function whereSoon(){
  clearTimeout(whereTimer);
  whereTimer=setTimeout(updateWhere,120);
}
window.addEventListener("scroll",whereSoon,{passive:true});
document.getElementById("wrap").addEventListener("scroll",whereSoon,{passive:true});
// ---- 色に頼らない表示(2026-08-01) ----
// 島図の左下に浮かせていた凡例(「吸—出」の細い色帯)は2026-08-06に削除した
// (谷川氏指示「吸出の凡例の画像は削除」。台番セルに重なるため)。
// 色の意味は「資料」タブの凡例表で見る。ただし記号の段づけにはこの並びが要るので、
// 生成時にxlsxから読み取った色の定義そのものは今までどおり持っておく。
const LEGEND=SHIMA.legend;
(()=>{
  if(!LEGEND.length)return;
  // セルの背景色から凡例の何段目かを判定して、左上に「↑↑ ↑ − ↓ ↓↓」を重ねる。
  // **色は生成済みのHTMLに入っている値をそのまま使う**ので、色と記号が食い違わない。
  // 9段は記号にすると読み取れないので、上位2段/上位2段/中央/下位2段…と5つに畳む。
  const MARKS=["↑↑","↑↑","↑","↑","−","↓","↓","↓↓","↓↓",""];
  const norm=s=>{
    const m=(s||"").match(/rgba?\(([^)]+)\)/);
    if(!m)return (s||"").toLowerCase();
    const p=m[1].split(",").map(x=>parseInt(x,10));
    return "#"+p.slice(0,3).map(x=>("0"+(x||0).toString(16)).slice(-2)).join("");
  };
  const MKEY={};
  LEGEND.forEach((x,i)=>{ MKEY[norm(x.c)]=MARKS[i]||""; });
  let painted=false;
  function paintMarks(){
    document.querySelectorAll(".tap").forEach(el=>{
      if(el.querySelector(".mk"))return;
      const k=norm(getComputedStyle(el).backgroundColor);
      const t=MKEY[k];
      if(!t)return;
      const s=document.createElement("span");
      s.className="mk"; s.textContent=t; s.setAttribute("aria-hidden","true");
      el.appendChild(s);
    });
    painted=true;
  }
  // ボタンは資料タブの凡例の中にあり、資料を開くたびに作り直される(2026-08-06)。
  // そのため参照は都度引き直し、押したときの処理は document への委譲にする。
  const MKEYS="shimaheat-marks";
  const paint=on=>{
    const mb=document.getElementById("markBtn");
    if(!mb)return;
    mb.classList.toggle("is-on",!!on);
    mb.textContent=on?"記号を消す":"記号を出す";
  };
  const setMarks=on=>{
    if(on&&!painted) paintMarks();
    document.body.classList.toggle("marks",!!on);
    paint(!!on);
    try{ localStorage.setItem(MKEYS,on?"1":"0"); }catch(e){}
  };
  // 資料を組み立て直したあとに、いまの入切をボタンへ映し直すための入口
  window.syncMarkBtn=()=>paint(document.body.classList.contains("marks"));
  document.addEventListener("click",e=>{
    if(!e.target.closest("#markBtn"))return;
    e.stopPropagation();
    setMarks(!document.body.classList.contains("marks"));
  });
  let on0=false;
  try{ on0=localStorage.getItem(MKEYS)==="1"; }catch(e){}
  setMarks(on0);
  // 期間を切り替えるとセルを貼り替えるので、記号も付け直す。
  window.addEventListener("shimaheat-period",()=>{
    painted=false;
    if(document.body.classList.contains("marks")) paintMarks();
  });
})();
const GENAT=SHIMA.genat, DATADAY=SHIMA.dataday;
(()=>{
  const el=document.getElementById("dataStat");
  if(!el)return;
  // 「反映」と書くのは、この日付が **島図の色に実際に入っている最終日** だから
  // (2026-08-05・谷川氏指示。以前は「データ 8/4まで」と書きながら色は8/3までという
  //  食い違いが起きた。生成側は島図xlsxの対象期間からこの日付を取り、
  //  カード側データの最終日と違えば配信そのものを止める)。
  const base="データ "+DATADAY+"分まで反映 ／ "+GENAT+" 更新";
  el.textContent=base;
  let ready=false;
  const toNew=()=>{
    if(ready)return;
    ready=true;
    el.classList.add("is-new");
    el.textContent="新しいデータがあります ／ タップで表示";
    fitBar();
  };
  el.addEventListener("click",()=>{
    if(ready) location.reload();
    else showToast(base,2600);
  });
  if(!("serviceWorker" in navigator))return;
  // 登録は初回描画の邪魔をしないよう後回しにする。
  const reg=()=>navigator.serviceWorker.register("/atsuta/sw.js",{scope:"/atsuta/"})
    .then(r=>{
      // 既に別の版が控えている / これから見つかる、どちらも拾う。
      if(r.waiting) toNew();
      r.addEventListener("updatefound",()=>{
        const w=r.installing;
        if(!w)return;
        w.addEventListener("statechange",()=>{
          // controllerが居る=初回インストールではない=中身が入れ替わった
          if(w.state==="installed" && navigator.serviceWorker.controller) toNew();
        });
      });
      // 中身(HTML/JSON)だけが変わった場合はSWからの合図で知る。
      navigator.serviceWorker.addEventListener("message",e=>{
        if(e.data && e.data.type==="content-updated") toNew();
      });
      // データとUIの分離(2026-08-02)。app.js / app.css は内容ハッシュ付きのURLなので
      // SW側で名前を決め打ちできない。**このページが実際に読んだURLを教えて**保存させる。
      // SWの登録は初回描画の後なので最初の読み込み分はSWを通っておらず、これをやらないと
      // 「圏外で開き直すとUIだけ取れない」になる。
      navigator.serviceWorker.ready.then(rr=>{
        const w=rr.active; if(!w)return;
        const us=[].slice.call(
          document.querySelectorAll('link[rel="stylesheet"],script[src]'))
          .map(e=>e.href||e.src).filter(Boolean);
        w.postMessage({type:"assets",urls:us});
      }).catch(()=>{});
    }).catch(()=>{});
  if(window.requestIdleCallback) requestIdleCallback(reg,{timeout:4000});
  else setTimeout(reg,1500);
})();
// 新台入替の告知(2026-08-02新設・谷川氏指示)。入替日は朝9:00〜12時ごろに台番と機種が
// 入れ替わるので、その日に開いた人へ「今日は配置が変わる」と先に知らせる。
// 中身は notice.json(毎日の告知チェック check_castle_shindai.py が書く)。
// **初回描画の邪魔をしないよう後回しで読む**。取れなくても画面は何も変わらない
// (告知が無い日=予定なしと同じ扱い)。
(()=>{
  const bar=document.getElementById("shindai");
  if(!bar)return;
  const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  const open=n=>{
    let m=document.getElementById("noticeModal");
    if(!m){
      m=document.createElement("div"); m.id="noticeModal";
      m.innerHTML='<div id="noticeCard"></div>';
      document.body.appendChild(m);
      m.addEventListener("click",e=>{ if(e.target===m) m.style.display="none"; });
    }
    const sec=(t,arr,cls)=>arr.length? '<div class="nsecwrap '+(cls||"")+'">'
      +'<div class="nsec">'+t+'</div><ul>'
      +arr.map(i=>"<li>"+esc(i.name)+(i.add?" 計":" ")+i.n+"台</li>").join("")
      +"</ul></div>":"";
    const d=n.detail||{pachi:[],slot:[]};
    // 右上にも閉じるボタンを置く(2026-08-04・谷川氏指示「閉じるボタンを右上にも作る」)。
    // 内訳は縦に長いので、下まで送らないと閉じられないのは手間。台番カードの「✕ 閉じる」と
    // 同じ見た目・同じ位置にして、押す場所を覚え直さなくて済むようにする。
    document.getElementById("noticeCard").innerHTML=
      '<button class="nclose ntop" aria-label="閉じる">✕ 閉じる</button>'
      +"<h3>"+esc(n._head||n.title)+"</h3><div class='nsum'>"+esc(n.summary||"")+"<br>"
      // 入替が済んでいるときは「島図の配置も更新済み」をここで伝える(見出しは1行に保つ)
      +((dayDiff(n.date)||0)<0?"島図の配置も更新済みです。<br>":"")
      +esc(n.note||"")+"</div>"
      +'<div id="iretae"></div>'
      +sec("スロット",(d.slot||[]),"n-slot")+sec("パチンコ",(d.pachi||[]),"n-pachi")
      +'<button class="nclose">閉じる</button>';
    // 入替の内訳(新台・増台・減台・移動台・撤去台)を筐体画像つきで出す(2026-08-04・
    // 谷川氏指示「新台の情報のみではなく増台減台撤去台の情報ものせて」)。
    // **後から差し込む**=iretae.jsonが取れなくても、従来の新台一覧はそのまま出る。
    fetch("iretae.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(ir=>{
      const host=document.getElementById("iretae");
      if(!ir||!ir.cats||!ir.cats.length||!host) return;
      // 告知が無い時期に「台入替」ボタンから開いた場合、見出しが空のままになる。
      // 内訳が持っている入替日から作り直す(2026-08-04)。
      if(!(n._head||n.title) && ir.date){
        const h=document.querySelector("#noticeCard h3");
        if(h) h.textContent=mdw(ir.date)+" 新台入替の内訳";
      }
      host.innerHTML=ir.cats.map(c=>{
        const cards=c.items.map(it=>{
          const sub=(c.key==="plus"||c.key==="minus")
            ? it.before+"→"+it.n+"台"
            : it.n+"台";
          const pic=it.img
            ? '<img src="'+esc(asrc("kishu/"+it.img))+'" alt="" loading="lazy" decoding="async">'
            : '<span class="noimg">画像なし</span>';
          // 区分は問わない(増台/減台でも島ごと引っ越していれば道すじを出す・2026-08-04)
          const mv=(it.from&&it.from.length&&it.dai&&it.dai.length)
            ? ' data-mv-from="'+esc(it.from.join(","))+'" data-mv-to="'
              +esc(it.dai.join(","))+'"' : "";
          // 道すじが引けない増台/減台は、その台番を光らせるだけにする(2026-08-05)。
          const lt=(c.key==="plus")?(it.dai||[]):(c.key==="minus")?(it.gone||[]):[];
          const lit=(!mv&&lt.length)
            ? ' data-lit="'+esc(lt.join(","))+'" data-lk="'+esc(c.key)+'"' : "";
          return '<li class="icard'+((mv||lit)?" ismove":"")+'" data-n="'+esc(it.name)+'"'
            +mv+lit+'>'
            +'<span class="ipic">'+pic+'</span>'
            +'<span class="iname">'+esc(it.name)+'</span>'
            +'<span class="inum">'+esc(sub)+'</span></li>';
        }).join("");
        const tot=c.items.reduce((a,it)=>a+(c.key==="plus"||c.key==="minus"
          ? Math.abs(it.d||0) : it.n),0);
        return '<div class="icat"><div class="ihead" style="--ic:'+esc(c.color)+'">'
          +'<span class="ibadge">'+esc(c.label)+'</span>'
          +'<span class="icnt">'+c.items.length+'機種 '+tot+'台</span></div>'
          +'<ul class="ilist">'+cards+'</ul></div>';
      }).join("");
      // 内訳のカードも押すと要点スペックを出す(2026-08-04・台番カードの写真と同じ扱い)。
      host.addEventListener("click",e=>{
        const li=e.target.closest && e.target.closest(".icard");
        if(!li) return;
        // 移動台は**機種名を押したとき**だけ、元の位置→新しい位置を見せる
        // (写真やその他の場所を押したときは今までどおりスペックを出す)。
        // 機種名を押したときは島図のラベルと同じ選択肢を出す(2026-08-05・谷川氏指示)。
        // 写真やその他の場所を押したときは今までどおりスペックを直に開く。
        const nm=li.dataset.n||"";
        if(e.target.closest(".iname") && (li.dataset.mvTo||li.dataset.lit)){
          const mv=(li.dataset.mvFrom&&li.dataset.mvTo)
            ? {f:li.dataset.mvFrom.split(","),t:li.dataset.mvTo.split(",")} : null;
          const lt=li.dataset.lit
            ? {d:li.dataset.lit.split(","),k:li.dataset.lk} : null;
          const ch=actChoices(nm,mv,lt);
          if(ch){
            // 場所を見る方を選んだら、内訳の画面を閉じてから島図を見せる
            const orig=ch[1].r;
            ch[1]={t:ch[1].t,r:()=>{
              const m=document.getElementById("noticeModal");
              if(m) m.style.display="none";
              orig();
            }};
            pickAction(nm,ch);
            return;
          }
        }
        if(nm) openSpec(nm);
      });
      // 内訳が出せたら、同じ内容を文字で並べている旧リストは消す
      // (2026-08-04・実機で「新台が画像つきカードと文字リストで二度出る」ため)。
      // パチンコも内訳に「パチンコ新台」として入るようになったら文字リストは要らない。
      const os=document.querySelector("#noticeCard .n-slot");
      if(os) os.remove();
      const hasPachi=ir.cats.some(c=>c.key==="pachi");
      const op=document.querySelector("#noticeCard .n-pachi");
      if(op && hasPachi) op.remove();
      else if(op){ const h=op.querySelector(".nsec");
                   if(h) h.textContent="パチンコの新台(ホール告知)"; }
    }).catch(()=>{});
    const card=document.getElementById("noticeCard");
    // 可視領域の上端に寄せる(台番カードと同じ考え方。ピンチズーム中でも画面内に出す)。
    // **高さも可視領域基準にする**(2026-08-04)。CSSの max-height:80vh はレイアウト
    // ビューポート基準なので、Safariのツールバーが出ているとカードが画面の下へはみ出し、
    // 「閉じる」に指が届かなくなる。5分類の内訳は縦に長いので実害が出やすい。
    const vv=window.visualViewport;
    card.style.top=(vv?Math.max(0,vv.offsetTop)+10:10)+"px";
    // max-height は**中身の高さ**なので、器の余白と枠のぶんを引く(2026-08-04)。
    // 引き忘れると上下の余白24pxぶんだけ下へはみ出す(検証で「上10 下858」と出た)。
    const ccs=getComputedStyle(card);
    const cpad=(parseFloat(ccs.paddingTop)||0)+(parseFloat(ccs.paddingBottom)||0)
              +(parseFloat(ccs.borderTopWidth)||0)+(parseFloat(ccs.borderBottomWidth)||0);
    card.style.maxHeight=
      Math.max(200,(vv?vv.height:window.innerHeight)-20-cpad)+"px";
    m.style.display="block";
    // 開閉のたびに下部バーの位置を測り直す(2026-08-04・谷川氏報告「閉じたらバーが中段に
    // きてしまう」)。パネルの表示で可視領域が動くことがあり、その途中の値のまま
    // バーが貼り付くと戻らなくなる。閉じた後に必ず正しい位置へ引き直す。
    const relayout=()=>{ try{ fitBar(); }catch(e){} };
    relayout();
    for(const b of card.querySelectorAll(".nclose")){
      b.addEventListener("click",()=>{
        m.style.display="none"; relayout(); setTimeout(relayout,250);
      });
    }
    m.addEventListener("click",e=>{ if(e.target===m){ relayout(); setTimeout(relayout,250); } });
  };
  // 見出しは**開いた時点の日付から組み立てる**(2026-08-04・谷川氏報告
  // 「下部の最新情報で8/3新台入替とあるが8/3新台入替済とかなら意味合いは分かる」)。
  // 旧実装は notice.json に焼き込まれた n.title と n.days をそのまま出していたため、
  // 告知チェック(12:40/20:40)が次に走るまで「本日」「明日」が過去の日付に貼り付いたままになり、
  // 8/4の朝に「明日 8/3(月) 新台入替」という有り得ない表示が出ていた(実機で確認)。
  const WD="日月火水木金土";
  const parse=iso=>{ const p=String(iso||"").split("-").map(Number);
    return p.length===3 && p.every(v=>v>0) ? new Date(p[0],p[1]-1,p[2]) : null; };
  const dayDiff=iso=>{ const b=parse(iso); if(!b) return null;
    const t=new Date(), a=new Date(t.getFullYear(),t.getMonth(),t.getDate());
    return Math.round((b-a)/86400000); };
  const mdw=iso=>{ const b=parse(iso);
    return (b.getMonth()+1)+"/"+b.getDate()+"("+WD[b.getDay()]+")"; };
  const headline=n=>{
    const dd=dayDiff(n.date);
    if(dd===null) return n.title||"";          // 日付が無い告知は従来どおり
    if(dd>1)  return mdw(n.date)+" 新台入替";
    if(dd===1)return "明日 "+mdw(n.date)+" 新台入替";
    if(dd===0)return "本日 "+mdw(n.date)+" 新台入替";
    // 済んだ入替の見出しは短く保つ(2026-08-04・谷川氏指示「一行に収まるようにしてください」)。
    // 「島図の配置も更新済み」まで入れると内訳パネルの見出しが2行になり、右上の
    // 閉じるボタンに押されて折り返す。配置が更新済みであることは本文側で伝える。
    return mdw(n.date)+" 新台入替済";
  };
  const show=n=>{
    if(!n || !(n.title||n.date)) return;
    const dd=dayDiff(n.date);
    // 先すぎる告知は出さない。済んだ告知は入替日から3日目までで打ち切る
    // (2026-08-08・谷川氏指示「4日目以降は新台入替の表示を出さなくてよい」)。
    // 入替日=1日目(dd=0)、2日目=dd-1、3日目=dd-2 → 4日目(dd-3)以降は非表示。
    // 以前は1週間(dd<-7)残していたが、配置が変わった理由を伝える役目は数日で終わり、
    // 出し続けると見慣れて読まれなくなるため短くした。
    if(dd!==null && (dd>14 || dd<-2)) return;
    n._head=headline(n);
    bar.hidden=false;
    // 見出しと台数を別の行にする(2026-08-04・谷川氏指示「途中で改行いれる」)。
    // 1行に詰めると「…更新済み パチンコ・スロット24機種214台」が続いて読みにくい。
    bar.innerHTML=esc(n._head)+"<br>"+esc(n.summary||"");
    // 当日と前日だけ強く出す(毎日目立つと見慣れて読まれなくなる)
    bar.classList.toggle("is-soon", dd!==null && dd>=0 && dd<=1);
    bar.addEventListener("click",()=>open(n));
    fitBar();
  };
  // 「台入替」ボタン(2026-08-04・谷川氏指示)。告知帯は入替の前後だけ出る一時的な物なので、
  // いつでも内訳を開ける入口を下部バーに常設する。告知が無ければ iretae.json だけで開く。
  const ibtn=document.getElementById("iretaeBtn");
  let cur=null;
  if(ibtn){
    ibtn.disabled=true;                       // 内訳が有ると分かるまで押せなくしておく
    ibtn.addEventListener("click",()=>open(cur||{}));
    fetch("iretae.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(ir=>{
      if(ir&&ir.cats&&ir.cats.length) ibtn.disabled=false;
    }).catch(()=>{});
  }
  const load=()=>fetch("notice.json",{cache:"no-store"})
    .then(r=>r.ok?r.json():null).then(n=>{ cur=n||null; show(n); }).catch(()=>{});
  if(window.requestIdleCallback) requestIdleCallback(load,{timeout:5000});
  else setTimeout(load,1800);
})();
// オプチャ情報(2026-08-04・谷川氏指示「オプチャ情報ボタンを台入替の右側に設置」)。
// トリノメ(LINEオープンチャットの監視ビューア)の熱田だけを開く。別アプリなので
// 新しいタブで開き、島図の状態(拡大位置・絞り込み)を失わないようにする。
// ホーム画面から起動したPWAでは window.open が塞がれることがあるので、その時は同じ画面で開く。
(()=>{
  const b=document.getElementById("opechatBtn");
  if(!b)return;
  const url="https://opechat-viewer.pages.dev/?store="
    +encodeURIComponent("プレイランドキャッスル熱田");
  b.addEventListener("click",()=>{
    const w=window.open(url,"_blank","noopener");
    if(!w) location.href=url;
  });
})();
// ---- 今日の午前中(2026-08-10・谷川氏指示「昼の途中経過を島図に出す」) ----
// 昼スナップは12:30に取れるが、このHTMLは夜間(2〜4時)に作られているので焼き込めない。
// 押したときに hiru.json(その日の 台番→途中差枚)を読み、島図の**色だけ**差し替える。
// 文字(台番・位置区分)はそのままにする=どこの台かを見失わないため。
// もう一度押すか期間を切り替えると、いまの期間の色に戻す(restoreBase/applyPeriodを流用)。
//
// 出どころは publish_hiru.py。水曜だけ手で回す全館版(839台)があればそちら、
// 無ければ毎日12:30の自動版(ノーマル機241台)。値の無い台は hiru.json に入っていないので、
// ここで灰色に伏せる=「今日はまだ回っていない/対象外」が一目で分かる。
(()=>{
  const btn=document.getElementById("hiruBtn");
  if(!btn)return;
  // 色は資料の凡例と同じ物差しを使う(単日ビューと見比べて違和感が出ないように)。
  // 並びは LEGEND と同じ: 絶好調→大不調→データ無。境目も凡例の文言どおり。
  const CUT=[1500,800,300,100,-99,-299,-799,-1499];
  // データ無(添字9)は黒(2026-08-10・谷川氏指示「薄青との色の違いが分かりにくい」)。
  // 微プラスの薄青(#D7E5F2)と旧来の薄灰(#D9D9D9)が並ぶと見分けが付かなかった。
  const col=i=>((LEGEND&&LEGEND[i]&&LEGEND[i].c)||
                ["#3D6FB0","#6FA8DC","#A9CCE3","#D7E5F2","#FDF3D0",
                 "#FBD7B0","#F4A582","#E8483C","#C00000","#111111"][i]);
  // 濃い帯の上で黒字は読めない(memory: shimazu-heat-line-and-text-visibility)。
  const ink=i=>(i===0||i===7||i===8||i===9)?"#ffffff":"#111111";
  const band=v=>{ for(let i=0;i<CUT.length;i++){ if(v>=CUT[i]) return i; } return 8; };

  let on=false, data=null, titleEl=null, titleWas=null;
  // 島図の上端の見出し(「対象期間：6/9(火)〜8/9(日) 最大62日」)を探す。
  // 資料テーブル側(.tc)にも「対象期間の差枚平均」という別の文言があるので、そちらは除く。
  const findTitle=()=>[...document.querySelectorAll("#board [data-k]")]
    .find(e=>!e.classList.contains("tc")&&(e.textContent||"").indexOf("対象期間")===0);
  const WD="日月火水木金土";
  const paint=()=>{
    document.querySelectorAll(".tap[data-dai]").forEach(el=>{
      const v=data.v[el.dataset.dai];
      if(typeof v==="number"){ const i=band(v);
        el.style.backgroundColor=col(i); el.style.color=ink(i); }
      else { el.style.backgroundColor=col(9); el.style.color=ink(9); }
    });
    // 見出しも昼の顔にする(2026-08-10・谷川氏指示)。色だけ変えて見出しが
    // 「対象期間：…」のままだと、いつの数字を見ているのか分からなくなる。
    // 元の文字は覚えておいて、消すときに書き戻す(期間の貼り替えに頼らない)。
    titleEl=titleEl||findTitle();
    if(titleEl){
      if(titleWas===null) titleWas=titleEl.innerHTML;
      const p=String(data.date).split("-").map(Number);
      const d=new Date(p[0],p[1]-1,p[2]);
      titleEl.textContent="今日の午前中："+p[1]+"/"+p[2]+"("+WD[d.getDay()]+") "
        +data.at+"時点 "+(data.kind==="all"?"全機種":"ノーマル機")+data.n+"台";
    }
  };
  const titleBack=()=>{
    if(titleEl&&titleWas!==null){ titleEl.innerHTML=titleWas; titleWas=null; }
  };
  const off=()=>{
    on=false; btn.classList.remove("is-on");
    btn.textContent="今日の午前中"+(data&&data.at?" "+data.at:"");
    titleBack();
    // いまの期間の色を引き直す(自前で元の色を覚えておくより確実)。
    if(typeof applyPeriod==="function") applyPeriod(curPeriod,false);
    else if(typeof restoreBase==="function") restoreBase();
  };
  // 期間を切り替えたら昼の色は消える(貼り替えで上書きされる)ので、印も戻しておく。
  // 見出しは貼り替えの対象でないことがあるので、こちらでも明示的に書き戻す。
  window.addEventListener("shimaheat-period",()=>{
    if(on){ on=false; btn.classList.remove("is-on");
            btn.textContent="今日の午前中"+(data&&data.at?" "+data.at:"");
            titleWas=null; titleEl=null; }   // 貼り替え後の文字が正しいので覚え直す
  });
  btn.addEventListener("click",()=>{
    if(on){ off(); return; }
    if(data){ on=true; btn.classList.add("is-on");
              btn.textContent="今日の午前中 "+data.at+" ✕"; paint(); return; }
    btn.classList.add("loading");
    fetch("hiru.json",{cache:"no-store"}).then(r=>{
      if(!r.ok) throw new Error("HTTP "+r.status);
      return r.json();
    }).then(j=>{
      btn.classList.remove("loading");
      // 古い日の数字を今日の顔で見せない(端末の日付で照合する)。
      const d=new Date(), ymd=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")
        +"-"+String(d.getDate()).padStart(2,"0");
      if(!j||!j.v||j.date!==ymd){
        showToast("今日の午前中の分はまだありません",2600); return;
      }
      data=j; on=true; btn.classList.add("is-on");
      btn.textContent="今日の午前中 "+j.at+" ✕";
      paint();
      showToast((j.kind==="all"?"全機種":"ノーマル機")+" "+j.n+"台 / "+j.at+" 時点",2600);
    }).catch(()=>{
      btn.classList.remove("loading");
      showToast("今日の午前中の分はまだありません",2600);
    });
  });
})();
