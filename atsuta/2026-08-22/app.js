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
// ピン強調のオンオフの保存キー(2026-08-20)。paintPins()→paintPinHl()から参照され、
// そのpaintPins()は初期化中のapplyPeriod()からも呼ばれる。**前方で宣言する**
// (上のpinAskTimerと同じ罠。後ろに置くとTDZで初期化ごと落ちる)。
const PINHL_KEY="shimaheat-pinhl";
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
// CW0=グラフの横幅(viewBoxの幅)。**スマホはこの356のまま**(いままでの見え方を1つも
// 変えない)。2カラム(パソコン)のときだけ、fitCard が実際の枠の幅を測って chartCW に入れる
// =viewBoxの幅と画面上の幅が一致し、SVGの中の文字が引き伸ばされなくなる(2026-08-14)。
const CW0=356,PX=3,CH0=164;
let chartCW=CW0;
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
  const CW=chartCW||CW0;      // 2カラムのときだけ広い値が入る(既定は従来と同じ356)
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
// 「単日」の表記はシマヒートの中で全部そろえる(2026-08-11・谷川氏指示
// 「単日ボタンはシマヒート内で全て 単日(○/○(曜日)) の表記にする」)。
// 日付はデータの最終日(=単日ヒートの対象日)。曜日は DATA.labels の書き方を
// そのまま使う(表の日付列・グラフ下の曜日と必ず同じ判定になる)。
function singleLabel(){
  const md=(DAYG&&DAYG.md)||"";
  if(!md) return "単日";
  let lab=md;
  (DATA.labels||[]).forEach(x=>{ if(x.split("(")[0]===md) lab=x; });
  // 「単日 8/10(月)」の形(2026-08-11・谷川氏指示「単日○/○(曜日)の表記に全て変える」)。
  // 単日＝前日(データの最終日)のこと。
  return "単日 "+lab;
}
// 下部バーの期間チップ・カードのグラフ期間・絞り込みの期間の3か所を一度に直す。
// HTML側(make_heat_html.py)で文言を持たせると3か所に散るので、ここで一本化する。
// 絞り込みは2026-08-12から期間が1つ(#fPer)になった(それまでは #fVper と #fRper)。
(()=>{
  const put=()=>{
    const lab=singleLabel();
    document.querySelectorAll('.pchip[data-p="single"],.mchip[data-w="1"],'
      +'#fPer .ch[data-v="single"]')
      .forEach(b=>{ b.textContent=lab; });
  };
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",put);
  else put();
})();
function renderDay(dai){
  // 「今日の午前中」を出しているときは、**今日の軌跡**で描く(2026-08-11・谷川氏指示
  // 「今日の午前中のグラフも表示するようにしてください」)。
  // 出どころは hiru.json の s(昼スナップのチャート画像を数値化したもの)。
  // 出していないときは今までどおり直近の確定日の軌跡(DAYG)。
  const H=window.HIRU;
  // ★「午前中を見ているか(hOn)」と「その台の軌跡があるか(hiruOn)」を分ける
  //   (2026-08-14夕・谷川氏報告「灰色の台ひらくと単日のグラフがでてる。
  //    単日は選択から外して午前中だけにしてください」)。
  //   それまでは1つの旗で兼ねていたため、軌跡の無い台は**単日へ落ちて**
  //   前日のグラフが出て、期間の印も「単日」が光っていた。
  const hOn=cardHiru();
  const hiruOn=!!(hOn&&H.data.s&&H.data.s[String(dai)]);
  const m=DATA.machines[dai];
  // 午前中を見ている間は単日の軌跡を借りない(借りると前日のグラフが出る)
  const s=hiruOn?H.data.s[String(dai)]:(hOn?null:((DAYG.s||{})[dai]));
  if(!m) return false;
  // 軌跡(スランプグラフの読み取り)が無い台でも単日を開けるようにする(2026-08-11・
  // 谷川氏報告「ノーマル以外の機種の単日が選べなくなってる」)。単日のグラフ画像は
  // 839台のうち339台ぶんしか取っていないため、それ以外の台は押しても**無反応**だった。
  // 当日の差枚とG数はマトリクスに全台ぶんあるので、表と数字はそのまま出せる。
  // グラフだけ「朝0 → 当日差枚」の直線にして、推移の記録が無いことを注記に書く。
  const noSer=!(s&&s.length>=3);
  // 真値=マトリクスの当日差枚(単日ヒートと同じ値)。ラベルは「7/30(木)」形式。
  // 午前中のときは昼スナップの差枚が真値(こちらもチャートの終端読みだが、
  // 底打ちの補正まで済んでいる同じ値をヒートに使っている)。
  let real=null;
  if(hOn) real=(H.data.v||{})[String(dai)];
  else DATA.labels.forEach((lb,i)=>{ if(lb.split("(")[0]===DAYG.md) real=m.d[i][0]; });
  if(typeof real!=="number") real=null;
  // 終端は必ずマトリクスの真値へ合わせる(画像から読んだ値には数十枚の誤差が出るうえ、
  // 底打ち台は谷が潰れて終端も過小になるため)。始点0は動かさず全体を比率で伸縮する。
  // 注記は「底打ちを真値へ戻した」と言える差(50枚超)があるときだけ出す。
  let ser, fixed=false, noGraph=false, noData=false;
  if(noSer){
    if(real==null){
      // 午前中は「グラフなし」として開く(2026-08-14夕・谷川氏指示「午前中はグラフ
      // なしならグラフ無しとかグラフに書いてください」)。単日へ落として前日の
      // グラフを見せると、今日の数字だと読み違える。
      // ★当日の数字が無い台も「データ無」として開く(2026-08-17・谷川氏指示
      //   「グラフはデータ無しの表示にして欲しい。プラマイゼロの差枚のグラフと
      //    見誤る可能性があるため」)。それまでは午前中以外は開かず無反応だった。
      //   入替で中身が変わった台はこの状態になる(その日はまだ実績が無い)。
      noGraph=true; ser=[0]; noData=!hOn;
    }else ser=[0,real];
  }else{
    const endv=s[s.length-1];
    ser=s.slice();
    if(real!=null && endv!==0 && real!==endv){
      const k=real/endv;
      ser=s.map(v=>Math.round(v*k));
      fixed=Math.abs(real-endv)>50;
    }
  }
  curDai=dai; curWin=1;
  // 単日も同じ形にそろえる(台番の行に日付・機種名の行は機種名だけ・2026-07-31)。
  // 日付には曜日を付ける(2026-08-01谷川氏指示「カードの上部の日付に曜日を追加」)。
  // DATA.labelsが「7/31(金)」形式なので、当日のラベルをそのまま使う(曜日の算出を
  // ここで作り直さない=表の日付列・グラフ下の曜日と必ず同じ判定になる)。
  let dlab=DAYG.md;
  DATA.labels.forEach(lb=>{ if(lb.split("(")[0]===DAYG.md) dlab=lb; });
  document.getElementById("mtitle").textContent="台"+dai+" "
    +(hOn?((H.data.date?hiruDayLabel(H.data.date):"今日")+"午前中 "
           +((H.data.sat||H.data.at||"")+" 時点"))
         :(dlab+" 単日"));
  document.getElementById("msub").textContent=m.n;
  buildMini(dai,m.n);
  syncMhiru();
  // 昼を出しているときは期間の印を光らせない(下部バーと同じ扱い・2026-08-11)
  // 午前中を見ている間は期間の印を光らせない(下部バーと同じ扱い・2026-08-11)。
  // ★hiruOn ではなく hOn で見る(2026-08-14夕)。軌跡の無い台で hiruOn が偽になり、
  //   「午前中」と「単日」が両方光っていた(谷川氏の実機写真で判明)。
  document.querySelectorAll(".mchip").forEach(b=>{ if(b.id!=="mhiruBtn")
    b.classList.toggle("is-on",!hOn&&b.dataset.w==="1"); });
  const lo=Math.min(...ser), hi=Math.max(...ser);
  // 軌跡が無い台は最高・最低に意味が無いので、当日差枚だけを書く(2026-08-11)
  // 入替で中身が変わった台は「いつ変わったか」を書く(2026-08-17)。
  const chgMd=(window.SHIMA&&SHIMA.chg)?SHIMA.chg[String(dai)]:"";
  const noDataMsg=chgMd
    ? ("この日のデータはありません（"+chgMd+"の入替でこの台の機種が変わりました）")
    : "この日のデータはありません";
  document.getElementById("mcap").textContent=noData
    ? noDataMsg
    : noGraph
    ? "午前中のグラフはまだ出ていません（取得元のスランプグラフが空のため）。回数だけ出しています"
    : noSer
    ? ("当日差枚 "+fmt(ser[ser.length-1])+"（この台は途中の推移の記録がありません）")
    : ("当日最高 "+fmt(hi)+" ／ 当日最低 "+fmt(lo)
    // 注記は短く(2026-08-01谷川氏指示「底打のため真値補正」)。1行に収めるため。
    +" ／ 最終 "+fmt(ser[ser.length-1])+(fixed?"（底打のため真値補正）":""));
  paintHiru(dai);
  // drawChartは「日毎の増減」を受け取って累積を描く作りなので、軌跡(累積値)を差分へ直して渡す。
  // 当日の推移なので基準(base)は0=朝スタート。
  const days=ser.map((v,i)=>[v-(i?ser[i-1]:0),null]), labels=ser.map(()=>"");
  // 当日のG数(マトリクスの実数)。単日の横軸=ゲーム数の目盛りに使うので、drawChartを
  // 呼ぶ前に取る(表のG数と同じ値。以前は表を作る所で取っていたため描画に間に合わず、
  // intraにtrueを渡していて目盛りが一度も出なかった)。G数が無い日はtrue=目盛り無し。
  let g=null;
  // ★hOn で見る(2026-08-14夕)。軌跡の無い台で hiruOn が偽になり、G数だけ前日の値
  //   (529G)が出ていた。午前中を見ている間は必ず午前中の回数を使う。
  if(hOn){ const kk=(H.data.k||{})[String(dai)]; g=kk&&typeof kk.g==="number"?kk.g:null; }
  else DATA.labels.forEach((lb,i)=>{ if(lb.split("(")[0]===DAYG.md) g=m.d[i][1]; });
  curDays=days; curLabels=labels; curBase=0; curIntra=(g>0)?g:true;
  curNoGraph=noGraph;
  // グラフが無い台は**線を引かずに理由を書く**(2026-08-14夕・谷川氏指示)。
  // 0の直線を引くと「ちょうど±0で推移した」と読めてしまう。
  document.getElementById("chart").innerHTML=noData
    ? '<div class="nograph">データ無<span>'+esc(noDataMsg)+'</span></div>'
    : noGraph
    ? '<div class="nograph">グラフなし<span>この台の午前中のスランプグラフが'
      +'取得元にまだ出ていません</span></div>'
    : drawChart(days,labels,CH0,0,curIntra);
  // 表は当日1行だけ(G数はマトリクス側の当日値)。
  const v=noGraph?null:ser[ser.length-1], rr=rate(v,g);
  // 累計差枚(2026-08-01): 単日でも「その日の終わりまでの通算差枚」を出す。
  // 他の窓の最終行と同じ値になるよう、全日付を頭から当日まで足す(基準はm.b=窓外の累積)。
  let dacc=m.b||0;
  for(let i=0;i<DATA.labels.length;i++){
    if(m.d[i][0]!=null) dacc+=m.d[i][0];
    if(DATA.labels[i].split("(")[0]===DAYG.md) break;
  }
  // 日付セルも他の期間と同じ「7/31(金)」形式にそろえる(曜日は土日だけ色が付く)。
  // 午前中は「途中」なので累計差枚は出さない(その日の終わりの値ではないため)
  document.getElementById("mbody").innerHTML=
    `<tr><td>${hOn?"午前中":wdHtml(dlab)}</td><td class="${cls(v)}">${fmt(v)}</td>`
    +(hOn?"<td>−</td>":`<td class="${cls(dacc)}">${fmt(dacc)}</td>`)
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
// 日付ラベル("8/13(木)")が、絞り込みで選んだ曜日かどうか(2026-08-14)。
// 集計詳細・内容詳細も曜日で絞れるようにするため、期間キー "fdow" の判定を1つにまとめる。
function inFdow(lab){
  if(!FDOW.length) return false;
  const wd=(/\(([^)]+)\)/.exec(lab||"")||[])[1]||"";
  return FDOW.indexOf(wd)>=0;
}
// 絞り込みパネルで選ばれている曜日(2026-08-14)。例 ["水","木"]。
// #fApply が当たるたびに更新し、カードの「曜日」ボタン(win=-2)がこれを見る。
// 絞り込みの結果と、そこから開いた台のグラフが**同じ日を見ている**状態にするため。
let FDOW=[];
// カードの「曜日」ボタンの文字と出し入れ。曜日を選んでいないときは出さない。
function syncMdow(){
  const b=document.getElementById("mdowBtn"); if(!b) return;
  b.hidden=!FDOW.length;
  if(FDOW.length) b.textContent=FDOW.join("")+"のみ";
}
function renderCard(dai,win){
    if(win===1){ if(renderDay(dai))return; win=NDAYS; }
    syncMdow();
    const m=DATA.machines[dai];
    if(!m)return;
    curDai=dai; curWin=win;
    // 「← 絞り込み」は一覧から開いたときだけ(openDaiFromList が出す)。
    // 島図・検索・ピン一覧・URL復元から開いたときは戻り先が違うので隠す。
    {const bf=document.getElementById("backFilter"); if(bf) bf.hidden=true;}
    // win=-1 は「水曜のみ」(2026-08-06・谷川氏指示「カード内にも水曜のみボタン追加」)。
    // 窓の長さではなく**日を抜き出す**ので、他の期間とは組み立てが違う。
    // win=-2 は「絞り込みで選んだ曜日だけ」(2026-08-14・谷川氏指示「曜日選択して絞り込んで
    // 台番押したときはその時の曜日だけのグラフと下の数字表にする」)。水曜のみ(-1)と
    // 組み立ては同じで、抜き出す曜日が1つか複数かの違いしかないので同じ道を通す。
    const dowSel=(win===-2&&FDOW.length)?FDOW.slice()
                :(win===-1?["水"]:null);
    const wedOnly=!!dowSel;   // 飛び飛びの日を抜き出すモード(水曜のみ/選んだ曜日のみ)
    const N=DATA.labels.length, n=(win>0?Math.min(win,N):N), cut=wedOnly?0:N-n;
    let days, labels;
    if(wedOnly){
      const idx=[];
      DATA.labels.forEach((L,i)=>{
        const wd=(/\(([^)]+)\)/.exec(L||"")||[])[1]||"";
        if(dowSel.indexOf(wd)>=0) idx.push(i);
      });
      days=idx.map(i=>m.d[i]); labels=idx.map(i=>DATA.labels[i]);
    }else{
      days=m.d.slice(cut); labels=DATA.labels.slice(cut);
    }
    // 前後の「数字が無い日」を落とす(2026-08-12・谷川氏報告「新台などで水曜日は
    // まだ1回のはずが9回になってる」)。入替で入った台は入替より**前が空**なので、
    // そのままだと「6/10(水)〜8/5(水) 9回」のように実際より長い期間に見え、
    // グラフにも意味の無い平らな線が伸びていた。
    // **途中の欠測(休業日など)は落とさない**=間が空いていること自体が情報のため。
    // 全部空の台は何も落とさない(「データなし」の表示に任せる)。
    {
      let s=0, e=days.length-1;
      while(s<=e && (!days[s] || days[s][0]==null)) s++;
      while(e>=s && (!days[e] || days[e][0]==null)) e--;
      if(s<=e && (s>0 || e<days.length-1)){
        days=days.slice(s,e+1); labels=labels.slice(s,e+1);
      }
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
    // 1日しか無い台は「8/5(水)〜8/5(水)」と同じ日を2度書かない(2026-08-12)
    const rng=(labels.length>1)?(labels[0]+"〜"+labels[labels.length-1]):(labels[0]||"");
    document.getElementById("mtitle").textContent="台"+dai+" "+rng
      +" "+labels.length+(wedOnly?"回":"日");
    document.getElementById("msub").textContent=m.n;
  buildMini(dai,m.n);
    // 水曜のみ(-1)も選べるようになったので、窓の値をそのまま突き合わせる(2026-08-06)。
    // 以前は「0より大きくなければ0」と丸めていたため、-1だと全期間が点いてしまう。
    syncMhiru();
    document.querySelectorAll(".mchip").forEach(b=>{ if(b.id!=="mhiruBtn")
      b.classList.toggle("is-on",(parseInt(b.dataset.w,10)||0)===win); });
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
    paintHiru(dai);
    curDays=days; curLabels=labels; curBase=base; curIntra=false; curNoGraph=false;
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
    const wlabel=wedOnly?(dowSel.join("")+"曜"+labels.length+"回 ")
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
  // 曜日で絞り込んでいるときは、その曜日だけで開く(2026-08-14・谷川氏指示)。
  // 島図の期間より絞り込みの意図を優先する=光っている台を押したら、絞った条件と
  // 同じ日のグラフが出るのが自然なため。
  if(FDOW.length) return -2;
  if(curPeriod==="all") return 0;
  if(curPeriod==="single") return 1;
  if(curPeriod==="last7") return 7;
  if(curPeriod==="wed") return -1;   // カードにも水曜のみを足した(2026-08-06)
  // 3週間が抜けていた(2026-08-14夜・谷川氏報告「直近3週間を選んでるのに台番押したら
  // 違う期間でデータ表示されてしまってる」)。島図側のキーは **"3w"**(期間チップを作る
  // make_heat_html.PERIOD_SRC の並び)で、カード側の窓は NDAYS(=3週間のmchipのdata-w)。
  // 対応が無いと下の `return curWin`(前に開いたときの窓)へ落ち、島図と食い違っていた。
  // ★期間を増やしたら**必ずここにも足す**。落ちても画面は出るので気づきにくい。
  if(curPeriod==="3w"||curPeriod==="nd21") return NDAYS;
  return curWin;
}
document.querySelectorAll(".tap").forEach(el=>{
  el.addEventListener("click",()=>{
    // 台番を押すたびに島図の状態へそろえる(2026-08-14夕・谷川氏指示)。
    // 前に開いたカードで期間を切り替えていても、次に開くときは
    // 「島図でいま選んでいる期間(午前中を含む)」で開く。
    mHiruOff=false;
    renderCard(el.dataset.dai,winForBoard());
  });
});
// グラフ期間チップ(2026-07-31新設)。押した窓で描き直し、次回タップ時も同じ窓で開く。
document.querySelectorAll(".mchip").forEach(b=>{
  b.addEventListener("click",e=>{
    e.stopPropagation();
    // カード内の「今日の午前中」は期間ではないので、下部バーの同じボタンへ回す
    // (data-w を持たないため、そのまま通すと 0=全期間 として扱われてしまう)。
    if(b.id==="mhiruBtn"){
      // 午前中の数字が無い台では効かせない(2026-08-11・谷川氏指示)。
      // 見た目は disabled で暗くしてあるが、押した扱いが別経路(委譲や
      // プログラムからの click)で届くこともあるのでここでも止める。
      if(b.disabled) return;
      // 島図は午前中のまま、カードだけ別の期間を見ている状態なら**カードを戻すだけ**
      // (2026-08-14夕)。ここで島図の午前中まで消すと、戻るつもりが全部消える。
      if(window.HIRU&&window.HIRU.on&&window.HIRU.data&&mHiruOff){
        mHiruOff=false;
        if(curDai) renderCard(curDai,1);
        return;
      }
      const hb=document.getElementById("hiruBtn");
      if(hb) hb.click();
      return;
    }
    const w=parseInt(b.dataset.w,10)||0;
    // 午前中を出している間は、**いま光っている期間をもう一度押すと解除**して
    // 午前中だけの状態へ戻す(2026-08-12・谷川氏指示)。
    // 午前中の見え方は「単日(w=1)＋HIRU.on」の組み合わせなので、単日へ戻せば
    // グラフも表も見出しも午前中の顔に戻り、期間チップは1つも光らなくなる
    // (renderCard の単日の道が hiruOn のとき印を消しているため)。
    // 午前中を出していないときは戻る先が無いので、今までどおり押し直しても変わらない。
    const hiruOn=!!(window.HIRU&&window.HIRU.on&&window.HIRU.data);
    // 2026-08-14夕: **単日(w=1)も他の期間と同じ扱いにする**(谷川氏報告
    // 「単日を押しても単日が選択されなくなってしまった」)。それまでは
    // 「午前中＝単日＋HIRU.on」だったため、単日を押しても午前中のままだった。
    // いま光っている期間をもう一度押すと午前中へ戻す(2026-08-12の約束は残す)。
    if(hiruOn&&b.classList.contains("is-on")){
      mHiruOff=false;
      try{ localStorage.setItem("shimaheat-mwin","1"); }catch(err){}
      if(curDai) renderCard(curDai,1);
      return;
    }
    // 期間を選んだらカードは午前中から外れる(島図の午前中はそのまま)
    mHiruOff=true;
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
  // 「詳細」の開閉は**閉じたら忘れる**(2026-08-12)。次に台番を開いたときは
  // 畳まれた状態から始める、が元の約束。期間の切り替えでは覚えたまま。
  detOpen=false; detDai=null;
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
// いま開いているカードが「グラフなし」の台か(2026-08-14夕)。
// fitCard は文字の大きさを合わせるたびに **curDays からグラフを描き直す** ので、
// この旗が無いと「グラフなし」の表示が直後に0の直線で上書きされる(実測で踏んだ)。
let curNoGraph=false;
// カードが午前中を見ているか(2026-08-14夕・谷川氏指示「単純に午前中を選択している
// 状態で台番を押したらカード内でも午前中のみ押された状態にする、他の期間を押したら
// 切り替わっていくようにする。他の期間を押した状態で台番を押すとカード内も同じ期間
// だけが押された状態でひらくように」)。
// 既定は島図の午前中に従う。カードの中で期間チップを押したときだけ**一時的に外れる**。
// ★この仕組みが無いと、島図が午前中の間はカードで単日を押しても午前中のままになる
//   (午前中の見え方が「単日＋HIRU.on」の組み合わせだったため)。
let mHiruOff=false;
function cardHiru(){
  return !!(window.HIRU&&window.HIRU.on&&window.HIRU.data&&!mHiruOff);
}
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
    // 「今日の午前中」の欄が設定別の数字を引くので、外からも見えるようにする(2026-08-11)
    .then(j=>{SPEC=j||{};window.SPEC=SPEC;return SPEC;})
    .catch(()=>{SPEC={};window.SPEC=SPEC;return SPEC;});
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
      hi.addEventListener("click",
        ()=>openPhoto(kishuLarge(mname)||hi.src,mname,true));
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
// 説明の図は**専用の軽いページ(fig.html)を同じタブで開く**(2026-08-17)。
//
// なぜ全画面の覆い(openPhoto)を使わないか: 谷川氏の実機で、期待値表やAI予想の
// パネルを開いたまま図を拡大すると、**表示はできるのに直後に落ちる**
// (画面収録で確認。6秒目以降『問題が繰り返し起きました』)。
// ★矢印がiOSで落ちた件では「収録すると直る＝描画負荷」だったが、今回は
//   **収録中でも落ちている**ので描画負荷ではなく、メモリ不足の線が濃い。
//   パネル(期待値表は42タブぶんの表)を抱えたまま全画面の層を足すのが効いていた。
//
// ★最初は「新しいタブで画像そのものを開く」形にしたが、谷川氏の報告
//   「落ちなくはなったが元の画面に戻れない」。画像だけのページには戻る手立てが無く、
//   新しいタブなので履歴も無い(history.back が効かない)。
//   そこで **同じタブで fig.html へ移動する** 形にした。
//     ・戻るは履歴で確実に効く(fig.html の「← 元の画面に戻る」)
//     ・島図とパネルは移動した時点で捨てられる＝メモリも解放される(落ちる理由が消える)
//     ・指で広げて好きなだけ拡大できる
//   戻ったときに開いていたパネルを開き直すため、どのパネルから来たかを
//   sessionStorage に置く(同じタブの中でだけ残る)。
const FIG_BACK="shimaheat-fig-back";
function openFigPage(src,title,from){
  if(!src) return;
  const file=String(src).split("?")[0].split("/").pop();
  try{ sessionStorage.setItem(FIG_BACK,from||""); }catch(e){}
  location.href=asrc("fig.html")+"?s="+encodeURIComponent(file)
    +"&t="+encodeURIComponent(title||"説明の図");
}
// 図のページから戻ってきたら、開いていたパネルを開き直す(2026-08-17)。
// **1回きり**にする(消してから押す)ので、あとで手で閉じても勝手には開かない。
(()=>{
  let from="";
  try{ from=sessionStorage.getItem(FIG_BACK)||""; sessionStorage.removeItem(FIG_BACK); }
  catch(e){}
  if(!from) return;
  const id=(from==="ai")?"aiBtn":(from==="nr")?"nrBtn":"";
  if(!id) return;
  // 画面の組み立てが済んでから押す(ボタンはshell.htmlに最初からあるが、
  // 中身を作る側の初期化が終わっていないと空のまま開くことがある)。
  setTimeout(()=>{ const b=document.getElementById(id); if(b) b.click(); },600);
})();
// cut=true は「背景を抜いてある筐体写真」。白い下地を敷かない
// (2026-08-16・谷川氏指示で筐体を輪郭に沿って抜いたため。下地を残すと
//  抜いた所がまた白く塗られ、上に大きな白い余白が出ているように見える)。
function openPhoto(src,cap,cut){
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
  ov.classList.remove("wide");
  ov.classList.toggle("cut",!!cut);
  // 縦長は幅いっぱいで縦へ流す(.tall)、横長は幅いっぱいで高さを成り行きにする(.wide)。
  // ★横長を入れたのは2026-08-17。説明図(1000x671)が「高さ76vh・幅auto」だと
  //   枠の中で letterbox になり、上下に白い帯が出て図が小さいままだった。
  const fit=()=>{ if(!im.naturalWidth) return;
                  const r=im.naturalHeight/im.naturalWidth;
                  if(r>1.6) ov.classList.add("tall");
                  else if(r<1) ov.classList.add("wide"); };
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
  // 段を選ぶ**前**に見出しを縮めておく(2026-08-11)。見出しが既定サイズのままだと
  // 折り返して1行ぶん高く測れ、収まる段でも「収まらない」と判定されて1段小さい
  // グラフが選ばれる。従来は選んだ後にだけ fitTitle を呼んでいたため、初めて開いた
  // ときだけ 9.5px 段・開き直すと 10px 段という食い違いが出ていた
  // (グラフ期間を2段にしてカード高さが上限ぎりぎりになり表面化した)。
  // fitTitle は #mtitle の幅(BFCなので表の文字サイズに左右されない)だけで決まるので、
  // ここで先に呼んでも段の選択と循環しない。
  fitTitle();
  // 午前中の表も、カード幅が決まったこの時点で測り直す(paintHiru の時点では
  // カードの幅がまだ前回の値のことがある)。高さにも効くので段を選ぶ前に呼ぶ。
  fitHiru();
  // ---- 2カラム(パソコン・2026-08-14) ----
  // 縦に積んでいないので「高さに収める段階縮小」は要らない(高さを決めるのは左右の
  // 高い方で、表が長ければどのみちスクロールになる)。そのかわり
  // **グラフの viewBox の幅を実際の枠の幅に合わせる**=拡大率1倍になり、
  // グラフの中の文字が表の文字と同じ大きさで出る(これが「バランスが悪い」の直し)。
  if(pcTwo()){
    const ce=document.getElementById("chart");
    const cw=Math.round((ce&&ce.clientWidth)||0)||CW0;
    // viewBox を実寸の 1/PC_GSCALE にすると、SVGは PC_GSCALE 倍で描かれる
    // =中の文字も同じだけ大きくなる(日付6.3→約11px・曜日9→約16px・値10→約18px)。
    chartCW=Math.max(300,Math.round(cw/PC_GSCALE));
    // 画面上の高さ(px)を決めてから viewBox の高さへ直す。
    const wantPx=Math.round(Math.min(460,Math.max(300,(mh-240)*0.62)));
    // 「グラフなし」の台はそのままにする(描き直すと0の直線で上書きされる)
    if(!curNoGraph)
      ce.innerHTML=drawChart(curDays,curLabels,Math.round(wantPx/PC_GSCALE),
                             curBase,curIntra);
    // 表もパソコン向けに一段大きく(2026-08-14・谷川氏指示「なるべく文字の大きさを合わせる」)
    card.style.setProperty("--tfs","15px");
    card.style.setProperty("--tpad","5px");
    fitTitle();
    return;
  }
  chartCW=CW0;                     // 1カラムは従来どおり(値も見え方も変わらない)
  for(const f of FITS){
    if(!curNoGraph)
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
  if(!curNoGraph)
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
// PC(広い窓)の判定と、そのときのシートの幅の上限(2026-08-14)。
// この作りはスマホの幅(約390px)を前提にしているので、広い窓では「引き伸ばす」のでは
// なく「上限で止めて中央へ置く」。数字を1か所に置いてCSSの @media と同じ境目にする。
const PC_WIDE=900, PC_SHEET_W=520;
// 2カラム(2026-08-14・谷川氏指示)。ここから先はカードの中身を左右に並べ、
// カード自体もぐっと広く取る(左にグラフ・右に日ごとの表)。
// 切り替えは**JSが body.pc2 を付け外しして持つ**。CSSの @media と二重に持つと、
// 境目の値がずれたときに「CSSは2カラムなのにJSは1カラムのつもり」という食い違いが起きる。
// 2026-08-14(谷川氏指示「開いたときの画面が小さい」「大きなサイズにする」
// 「解像度にもよると思いますが、横幅もっと広げられる」):
// カードの幅は**画面の96%まで、上限1600px**。1920pxの画面なら1600pxまで広がる。
// グラフの中の文字はviewBoxの単位なので、枠の実寸をそのまま viewBox にすると
// 6.3という指定が6.3pxにしかならず小さい。PC_GSCALE ぶん viewBox を小さく取り
// (＝拡大率を作り)、日付が約11px・曜日が約16px・値が約18pxで出るようにする。
const PC_TWO=1000, PC_TWO_W=1600, PC_GSCALE=1.75;
function pcTwo(){ return document.body.classList.contains("pc2"); }
function syncPcMode(){
  const on=(window.innerWidth>=PC_TWO);
  if(on===pcTwo()) return false;
  document.body.classList.toggle("pc2",on);
  return true;
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
    // ★PCの広い窓では画面幅いっぱいに広げない(2026-08-14・谷川氏報告
    //   「PCブラウザで台番を開いたときグラフの大きさとそのほかの文字との
    //     バランスが悪い」)。
    //   グラフは viewBox="0 0 356 …" のSVGを width:100% で描いているので、
    //   器が広いほど**中の文字ごと**引き伸ばされる。幅1900pxの窓では約5.3倍になり、
    //   拡大されないHTMLの表(12.5px固定)との差が開いて釣り合いを失っていた。
    //   スマホの幅(この作りが想定している幅)に近いところで頭打ちにし、中央へ置く。
    const full=vv.width*vv.scale;
    const w=pcTwo()?Math.min(full*0.96,PC_TWO_W)
           :((full>=PC_WIDE)?Math.min(full,PC_SHEET_W):full);
    card.style.left=(vv.offsetLeft+(full-w)/2)+"px";
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
    card.style.width=w+"px";
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
// パネルの幅は**パソコンでは広げる**(2026-08-14)。340pxはスマホの画面幅に合わせた値で、
// 広い窓ではその外側がまるごと余白になり、条件や順位を見るのに何度もスクロールが要る。
// 絞り込みは条件が多いので2カラム、AI予想はAT機とノーマル機を左右に並べる。
function fitFilterModal(){
  positionOverlayCard(document.getElementById("filterCard"),pcTwo()?720:340);
}
// 検索パネル(2026-08-01新設)も同じ扱い。候補の一覧が読みやすい程度に広げる。
function fitSearchModal(){
  positionOverlayCard(document.getElementById("searchCard"),pcTwo()?520:340);
}
// AI予想ランキング(2026-08-14新設)も同じ扱い。
// id を渡すと別のカードにも使える(2026-08-15夕。期待値表のパネル #nrCard を
// 同じ作りにしたので、位置合わせの規則も1本にまとめる)。
function fitAiModal(id){
  const c=document.getElementById(id||"aiCard");
  // 列が6つ(機種・高出率・出率中央・総差枚・平均差枚・母数)あり、さらにパソコンでは
  // AT機とノーマル機を左右に並べるので、台番カードと同じくらいの幅を取る(2026-08-14)。
  if(c) positionOverlayCard(c,pcTwo()?1500:340);
}
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
    if(document.getElementById("filterModal").style.display==="block"){
      fitFilterModal();
      // パネルが縮んだ後に、打ち込んでいる欄を見える位置へ戻す(2026-08-14)。
      // **fitFilterModal の後**でないと、縮む前の高さで計算してずれる。
      keepInputInView();
    }
    if(document.getElementById("searchModal").style.display==="block"){ fitSearchModal(); }
    const pmv=document.getElementById("pinModal");
    if(pmv&&pmv.style.display==="block"){ fitPinModal(); }
    // AI予想ランキング(2026-08-14新設)も同じ仕組みで追従させる。
    const ai=document.getElementById("aiModal");
    if(ai&&ai.style.display==="block"){ fitAiModal(); }
    // 期待値表のパネル(2026-08-15夕新設)も同じく追従させる
    const nr=document.getElementById("nrModal");
    if(nr&&nr.style.display==="block"){ fitAiModal("nrCard"); }
  },150);
}
// 打ち込んでいる入力欄を、パネルの中の見える位置へ戻す(2026-08-14・谷川氏報告
// 「累計G数の欄をタップすると下からキーボードが出てきて、入力する欄が隠れて見えなくなる。
//  スクロールしてまたその欄を見にいかないといけない」)。
// iOSはキーボードが出ると可視領域(visualViewport)が縮み、パネルもそれに合わせて縮む。
// このとき #fBody のスクロール位置は元のままなので、狙って押した欄が画面の外へ出てしまう。
// 対処は「縮んだ後の器の真ん中へその欄を持ってくる」。**キーボードの出る動きは非同期**
// なので、押した直後だけでなく少し後にも測り直す(1回だけだと縮む前の値で計算してしまう)。
function keepInputInView(){
  const el=document.activeElement;
  if(!el||el.tagName!=="INPUT") return;
  const s=document.getElementById("fBody");
  if(!s||!s.contains(el)) return;
  const sr=s.getBoundingClientRect(), er=el.getBoundingClientRect();
  // 欄の中心が器の中心に来る位置。上下いっぱいまでで頭打ちにする。
  const want=er.top-sr.top+s.scrollTop-(s.clientHeight/2-er.height/2);
  const max=Math.max(0,s.scrollHeight-s.clientHeight);
  s.scrollTop=Math.max(0,Math.min(max,want));
}
let fKbTimers=[];
(function(){
  const s=document.getElementById("fBody");
  if(!s) return;
  s.addEventListener("focusin",e=>{
    if(!e.target||e.target.tagName!=="INPUT") return;
    // キーボードがせり上がりきるまで待つ時間は端末で違うので、何度か測り直す。
    fKbTimers.forEach(clearTimeout);
    fKbTimers=[60,260,520,820].map(ms=>setTimeout(keepInputInView,ms));
  });
  // 打ち込んでいる間は「島図を見る」を引っ込める(2026-08-14)。キーボードが出ると
  // パネルの高さが半分以下になるので、常に出ているとその分だけ欄が見えなくなる。
  s.addEventListener("focusin",e=>{
    if(e.target&&e.target.tagName==="INPUT") document.body.classList.add("kb-on");
  });
  s.addEventListener("focusout",()=>{
    fKbTimers.forEach(clearTimeout);
    setTimeout(()=>{
      const a=document.activeElement;
      if(!a||a.tagName!=="INPUT") document.body.classList.remove("kb-on");
    },80);
  });
})();
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
    tb.style.width=""; tb.style.transform="";
    // ピン強調のボタンもCSSの既定へ戻す(2026-08-20)。inline を残すと
    // visualViewport が使えない端末で左下から動かなくなる。
    const p0=document.getElementById("pinHl");
    if(p0){ p0.style.left=""; p0.style.bottom=""; p0.style.transform=""; }
    const p1=document.getElementById("pinLs");
    if(p1){ p1.style.left=""; p1.style.bottom=""; p1.style.transform=""; }
    return;
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
  // 「絞り込み解除」も同じ扱い(2026-08-12)。絞り込んだまま拡大して見るのが普通なので、
  // 画面外へ出ると光を消す手段が手元から消えてしまう。
  for(const id of ["zoomOut","mvClose","ftClose","ftList"]){
    const el=document.getElementById(id);
    if(!el)continue;
    // 「全体に戻す」と同じ場所なので、重なる順に1段ずつ上へ積む
    // (下から 全体に戻す → 矢印を消す → 絞り込み解除)
    const mvOn=(document.getElementById("mvClose")||{classList:{contains:()=>false}})
                 .classList.contains("show");
    let up=0;
    if(id==="mvClose") up=(zoomF>1)?46:0;
    if(id==="ftClose") up=((zoomF>1)?46:0)+(mvOn?46:0);
    // 「絞り込み台一覧」は解除の1段上(2026-08-21)
    if(id==="ftList"){
      const ftOn=(document.getElementById("ftClose")||{classList:{contains:()=>false}})
                   .classList.contains("show");
      up=((zoomF>1)?46:0)+(mvOn?46:0)+(ftOn?46:0);
    }
    // ★高さも拡大率で割る(2026-08-21・谷川氏報告「ボタンが見切れてる」の続き)。
    //   下部バーには scale(1/vv.scale) が掛かっていて、**画面に出る高さは bh/vv.scale**。
    //   縮めずに積むと、指で広げたときバーのはるか上（可視領域の外）へ飛ぶ。
    //   実測: 3倍・最下部で ftList が可視領域の上へ2pxはみ出していた。
    el.style.bottom=(gap+(bh+12+up)*sc)+"px";
    // ★**出ていないボタンの左右は決めない**(2026-08-14夕・谷川氏報告
    //   「被ってる全体に戻すボタン」「ボタンは折り返して表示しないこと一行で表示」の真因)。
    //   display:none の間は offsetWidth が 0 なので、右端から幅を引く式が
    //   「画面の右端ぴったり」を返す。そのまま表示に切り替わると幅12pxの枠に押し込まれ、
    //   文字が縦に割れて(「全体／に戻／す」)画面の外へはみ出し、隣のボタンとも重なる。
    //   それまでは #zoomOut だけこの guard の外に居た(mvClose/ftClose は除外済みだった)。
    if(!el.classList.contains("show")){
      el.style.left=""; el.style.right="12px"; el.style.transform="";
      continue;
    }
    el.style.right="auto";
    // ★右端の合わせ方(2026-08-21・谷川氏報告「ボタンが見切れてる」の修正)。
    //   可視領域は [offsetLeft, offsetLeft+vv.width] （どちらもCSSピクセル）。
    //   ボタンには scale(1/vv.scale) が掛かっているので、**画面に出る幅は
    //   offsetWidth/vv.scale**。余白12pxも同じだけ縮む。したがって
    //     left = offsetLeft + vv.width − (幅 + 12) / vv.scale
    //   旧式は vv.width に vv.scale を**掛けて**いたため、指で少し広げただけで
    //   右へ大きくずれ、ボタンが画面の外へはみ出していた（等倍のときだけ正しかった）。
    el.style.left=(vv.offsetLeft+vv.width
                   -(el.offsetWidth+12)*sc)+"px";
    el.style.transformOrigin="bottom left";
    el.style.transform=(sc!==1)?("scale("+sc+")"):"";
  }
  // ピン強調のボタン(2026-08-20)は左下に常時出す。右下の3つと違って
  // 出たり消えたりしないので、幅を測る必要がなく left をそのまま置ける
  // (display:none のときに幅0で寄ってしまう問題は起きない)。
  const ph=document.getElementById("pinHl");
  if(ph){
    ph.style.bottom=(gap+(bh+12)*sc)+"px";     // 同上(2026-08-21)
    ph.style.left=(vv.offsetLeft+12*sc)+"px";   // 余白も一緒に縮める(2026-08-21)
    ph.style.transformOrigin="bottom left";
    ph.style.transform=(sc!==1)?("scale("+sc+")"):"";
  }
  // 「★一覧」はピン強調の1段上(2026-08-20夕)。同じく出たり消えたりしないので
  // 幅を測る必要がなく、left をそのまま置ける。
  const pl=document.getElementById("pinLs");
  if(pl){
    pl.style.bottom=(gap+(bh+12+52)*sc)+"px";  // 同上(2026-08-21)
    pl.style.left=(vv.offsetLeft+12*sc)+"px";   // 同上
    pl.style.transformOrigin="bottom left";
    pl.style.transform=(sc!==1)?("scale("+sc+")"):"";
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
// 特定日は別ファイル(2026-08-11)。762行・素173KBあり、毎日取り直す last7.data.js に
// 入れると no-cache のせいで毎日まるごと落ちる。中身は台帳由来でほとんど変わらないので、
// **内容ハッシュ付きの名前**にして1回だけ落とす(以後はブラウザに残る)。
// 古いデータ(同梱していた頃の版)も読めるように SHIMA.toku を先に見る。
let TOKU=(typeof SHIMA!=="undefined"&&SHIMA&&SHIMA.toku)||null, tokuReq=null;
function tokuLoad(){
  if(TOKU) return Promise.resolve(TOKU);
  if(!SHIMA||!SHIMA.tokuUrl) return Promise.resolve(null);
  if(tokuReq) return tokuReq;
  tokuReq=fetch(asrc(SHIMA.tokuUrl),{cache:"default"})
    .then(r=>r.ok?r.json():null)
    .then(j=>{ TOKU=j;
      // 資料を開いたまま届いたら作り直す(開いている節はそのまま残す)
      if(j&&curView==="docs"){ const op=[...document.querySelectorAll(
          '#docsPanel details[open]')].map(d=>d.dataset.k);
        docsBuilt=false; buildDocs();
        op.forEach(k=>{const d=document.querySelector(
          '#docsPanel details[data-k="'+k+'"]'); if(d) d.open=true;}); }
      return j; })
    .catch(()=>{ tokuReq=null; return null; });
  return tokuReq;
}
// 狙い方別の期待値表(2026-08-15・谷川氏指示「シマヒートの資料の中に
// この期待値表をいれて毎日更新するときに一緒に更新して」)。
// 中身は build_nerai_docs.py が毎晩作り直す nerai.<hash>.json(約12KB)。
// 歩進検証＝その日より前のn日だけで台を選び、翌日の実績を見たもの。
//
// ★2026-08-15夕に**資料の節から絞り込みパネルのボタンへ移した**(谷川氏指示
//   「資料にいれた期待値表はここのボタンのところに移動して期待値表としてボタンに」)。
//   置き場所が変わっただけで、作り方も書き出し(nrHtml)も同じ。
let NERAI=null, neraiReq=null;
function neraiLoad(){
  if(NERAI) return Promise.resolve(NERAI);
  if(!SHIMA||!SHIMA.neraiUrl) return Promise.resolve(null);
  if(neraiReq) return neraiReq;
  neraiReq=fetch(asrc(SHIMA.neraiUrl),{cache:"default"})
    .then(r=>r.ok?r.json():null)
    .then(j=>{ NERAI=j; return j; })
    .catch(()=>{ neraiReq=null; return null; });
  return neraiReq;
}
// 表の読み方(2026-08-15)。資料にあったときは節の前書き(sec の pre)に置いていたので、
// 移設に合わせてここへ持ってくる。**中身は変えない**(読み方が変わるわけではない)。
function nrIntro(D){
  if(!D) return "";
  // ★マスの読み方を1枚の図でも出す(2026-08-16・谷川氏指示「赤丸のマスの中の数字が
  //   何を表しているかを矢印で引っ張って分かるようにした画像を説明文に入れて」)。
  //   1つのマスに数字が4つ縦に積まれているうえ、行と列の見出しにも意味があるので、
  //   文字だけの説明では「どの数字の話か」が結びつかない。実物の形をした図に
  //   引き出し線を引いて、6か所をまとめて示す。
  //   ★画面幅だと図の細かい字が小さいので、**押すと大きく見られる**ようにしてある
  //   (下の nrBody のリスナーで openPhoto を呼ぶ)。
  // ★図を3枚に増やした(2026-08-17・谷川氏指示「文字がまだ多いので視覚的に見やすく」)。
  //   図と同じことを言っている文は消す(memory: figure-replaces-text-rule)。
  //     1枚目 マスの読み方        … 1マスの中の6か所
  //     2枚目 いつのデータで選び… … 前日まで/当日の切り分け(1つ目の箇条書きを置き換え)
  //     3枚目 マスの色と枠の意味  … 色の濃淡と紺の太枠(2つ目と4つ目を置き換え)
  //   残したのは「期待設定」(図に入っていない)と「対象期間・作成」(毎日変わる値)。
  const fig=(f,t)=>'<figure class="nr-fig">'
    +'<img src="'+esc(asrc(f))+'" alt="'+esc(t)+'" loading="lazy" decoding="async">'
    +'<figcaption>'+esc(t)+'（押すと別の画面で大きく見られます）</figcaption></figure>';
  return fig("nerai_yomikata.jpg","マスの読み方")
    +fig("nerai_erabu.jpg","いつのデータで選び、いつ打つか")
    +fig("nerai_iro.jpg","マスの色と枠の意味")
    +'<ul class="nr-intro">'
    +'<li>「期待設定」は、その台のBIG・REG・ブドウの出方から'
    +'「設定いくつだったと考えるのが自然か」を数字にしたもの'
    +'（台番カードの内容詳細に出るものと同じ計算）。'
    +'ボーナス回数の記録がある機種だけに出ます。</li>'
    +'<li>対象 '+esc(String(D.from))+'〜'+esc(String(D.to))+'（'+esc(String(D.ndays))
    +'日）／作成 '+esc(String(D.made))+'</li></ul>';
}
// 期待値表の1マスの色。全体平均を白の中心にして、良いほど緑・悪いほど赤。
// ★件数の少ないマスは色を薄める(色の濃さ＝主張の強さなので、母数の薄さを
//   そのまま色に出す)。PNG版(nerai_heat.py)と同じ規則。
const NR_SPAN=6.0, NR_CONF=60;
function nrColor(r,base,n){
  let d=Math.max(-1,Math.min(1,(r-base)/NR_SPAN));
  if(n) d*=Math.min(1,n/NR_CONF);
  const w=[255,255,255], g=[26,122,58], m=[176,40,40];
  const to=(d>=0)?g:m, t=Math.abs(d);
  const c=[0,1,2].map(i=>Math.round(w[i]+(to[i]-w[i])*t));
  const lum=0.299*c[0]+0.587*c[1]+0.114*c[2];
  return ["rgb("+c.join(",")+")", lum<150?"#fff":"#111"];
}
// 期待値表を描く。上に「どれを見るか」のボタン、下に表。
// ★表は横に長い(窓が7つ+平均)ので、**表だけを横スクロールの器に入れる**。
//   資料そのものは縦スクロールだけ、という約束を崩さないため。
let nrTab="nm";
function nrHtml(D){
  const tabs=D.tabs||[];
  if(!tabs.length) return "";
  if(!tabs.some(t=>t.k===nrTab)) nrTab=tabs[0].k;
  const cur=tabs.find(t=>t.k===nrTab)||tabs[0];
  const grp=tabs.filter(t=>t.kind==="grp"), ki=tabs.filter(t=>t.kind==="kishu");
  const btn=t=>'<button type="button" class="nr-tb'+(t.k===nrTab?" on":"")
    +'" data-nk="'+esc(t.k)+'">'+esc(t.n)
    +(t.dai?('<span class="nr-td">'+t.dai+'台</span>'):"")+'</button>';
  let h='<div class="nr-box"><div class="nr-tabs">'+grp.map(btn).join("")+'</div>';
  if(ki.length){
    h+='<div class="nr-lb">機種ごと（台数の多い順）</div>'
      +'<div class="nr-tabs nr-ki">'+ki.map(btn).join("")+'</div>';
  }
  const b=cur.base||{};
  h+='<div class="nr-base">'+esc(cur.n)+'　比べる相手（同じ日・同じ機種の全台）：'
    +'出率 <b>'+b.r.toFixed(2)+'%</b> ／ 平均差枚 <b>'+aiSv(b.v)+'</b>'
    +' ／ 勝率 <b>'+b.pl.toFixed(1)+'%</b> ／ '+b.n.toLocaleString()+'台日'
    +'（'+cur.days+'日）</div>';
  const cols=[];
  for(let n=1;n<=D.maxn;n++) cols.push("過去"+n+"日");
  cols.push("狙い方平均");
  // ★過去n日のマスは押せる(2026-08-15夕・谷川氏指示「各マスを押したら該当する
  //   台番の一覧がでてくる」)。狙い方と日数をマスに持たせて、押されたら
  //   nrPick() が**今日**その狙い方に当てはまる台を選び直す。
  //   右端の「狙い方平均」は窓がまとまった値なので、日数が決まらず押せない。
  // いま当てはまる台数(2026-08-15夕・谷川氏指示「マスごとに台数が見えるように」)。
  // ★過去の件数(◯件)と取り違えないよう、単位を「台」にして帯で囲む。
  const CNT = nrCounts(cur, D.maxn);
  const cellHtml=(c,rule,n)=>{
    if(!c) return '<td class="nr-na">−</td>';
    const [bg,fg]=nrColor(c[0],b.r,c[2]);
    const tap=n?(' nr-c1" data-nrr="'+esc(rule)+'" data-nrn="'+n+'"'):'"';
    const y=n?(((CNT[rule]||{})[n])||0):null;
    return '<td class="'+(c[0]>=D.be?"nr-be":"")+tap+' style="background:'+bg
      +';color:'+fg+'"><div class="nr-v">'+c[0].toFixed(1)+'%</div>'
      +'<div class="nr-s">'+aiSv(c[1])+'</div>'
      +'<div class="nr-c">'+c[2].toLocaleString()+'件</div>'
      +(n?('<div class="nr-y'+(y?"":" z")+'">'+y+'台</div>'):"")+'</td>';
  };
  let rows="", last="";
  (cur.rows||[]).forEach(r=>{
    if(r.g!==last){ last=r.g;
      rows+='<tr class="nr-g"><td colspan="'+(cols.length+1)+'">'+esc(r.g)+'</td></tr>'; }
    rows+='<tr><td class="nr-n">'+esc(r.r)+'</td>'
      +(r.c||[]).map((c,i)=>cellHtml(c,r.r,i+1)).join("")
      +cellHtml(r.a?[r.a[0],r.a[1],r.a[2]]:null,r.r,0)+'</tr>';
  });
  h+='<div class="nr-wrap"><table class="nr-t"><thead><tr><th class="nr-n">狙い方</th>'
    +cols.map(c=>'<th>'+esc(c)+'</th>').join("")+'</tr></thead><tbody>'
    +rows+'</tbody></table></div>';
  if(cur.t==="at"){
    h+='<div class="nr-note">AT機には回数（ボーナス回数・合算確率・期待設定）の'
      +'記録が無いため、その行は出ません。</div>';
  }
  return h+'</div>';
}
// 来店・取材・景品・おすすめ機種(2026-08-12)。特定日と同じく内容ハッシュ付きの
// 外部ファイルで、**別ファイルに分けてある**(特定日はめったに変わらず、こちらは
// 全台差枚ブック由来で日々変わるため。1つにすると両方落とし直しになる)。
let TORI=(typeof SHIMA!=="undefined"&&SHIMA&&SHIMA.tori)||null, toriReq=null;
function toriLoad(){
  if(TORI) return Promise.resolve(TORI);
  if(!SHIMA||!SHIMA.toriUrl) return Promise.resolve(null);
  if(toriReq) return toriReq;
  toriReq=fetch(asrc(SHIMA.toriUrl),{cache:"default"})
    .then(r=>r.ok?r.json():null)
    .then(j=>{ TORI=j;
      if(j&&curView==="docs"){ const op=[...document.querySelectorAll(
          '#docsPanel details[open]')].map(d=>d.dataset.k);
        docsBuilt=false; buildDocs();
        op.forEach(k=>{const d=document.querySelector(
          '#docsPanel details[data-k="'+k+'"]'); if(d) d.open=true;}); }
      return j; })
    .catch(()=>{ toriReq=null; return null; });
  return toriReq;
}
// 台番ごと・日ごとの G数/BB/RB(2026-08-13・谷川氏指示「午前中と同じようにそれぞれ
// 他5期間も見れるようにする。内容詳細ボタンを作る」)。島図のデータは1日ぶんが
// [差枚, G数] の2つしか持っておらず、回数を持っているのは昼スナップだけだったため、
// 設定の推定は午前中でしか出せなかった。回数は毎晩の蓄積Excelに貯まっているので、
// build_koyaku_series.py がそれを1つにまとめ、内容ハッシュ付きの外部ファイルにする。
// **開くまで落とさない**(素で約400KB。カードを開くたびに要るものではない)。
let KOYAKU=null, koyReq=null;
function koyLoad(){
  if(KOYAKU) return Promise.resolve(KOYAKU);
  if(!SHIMA||!SHIMA.koyakuUrl) return Promise.resolve(null);
  if(koyReq) return koyReq;
  koyReq=fetch(asrc(SHIMA.koyakuUrl),{cache:"default"})
    .then(r=>r.ok?r.json():null)
    .then(j=>{ KOYAKU=j; return j; })
    .catch(()=>{ koyReq=null; return null; });
  return koyReq;
}
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
  // 演者の「詳細」ボタン(2026-08-14)。中身は開かれた時に組む(30人ぶんを先に作ると重い)。
  // 一度だけ登録する=buildDocsは資料を開くたび呼ばれるため、二重登録を防ぐ。
  if(host&&!host.__engBound){
    host.__engBound=1;
    host.addEventListener("click",ev=>{
      const b=ev.target&&ev.target.closest?ev.target.closest(".tz-more"):null;
      if(!b) return;
      const i=b.dataset.i, row=document.getElementById("tzdet"+i);
      if(!row) return;
      const open=row.hidden;
      if(open&&!row.dataset.built){
        try{ row.cells[0].innerHTML=(window.__engDetail?window.__engDetail(Number(i)):""); }
        catch(e){ row.cells[0].innerHTML='<div class="tz-dnone">表示できませんでした</div>'; }
        row.dataset.built="1";
      }
      row.hidden=!open;
      b.textContent=open?"閉じる":"詳細";
      b.classList.toggle("on",open);
    });
  }
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
  // 色の意味(凡例)は**説明書の中**にまとめる(2026-08-22・谷川氏指示「凡例は特に出さなくて
  // よい。資料の中に説明書の内容にいれてまとめておけばよい。資料の中の凡例も説明書に統合」)。
  // 節が2つに割れていると「色の意味を知りたい」ときにどちらを開くか迷うので、
  // 読み方の説明は1か所に集める。
  // 「色に頼らない表示」の切替(2026-08-06)もこの中に置いたままにする。押したときの処理は
  // document への委譲なので、ここで作り直されても結び直しは要らない。
  const legInner=(D.legend&&D.legend.rows&&D.legend.rows.length)
    ? ('<div class="tz-dsub">'+esc(D.legend.t||"色の見方")+'</div>'
       +'<ul class="dleg">'+D.legend.rows.map(r=>'<li><i style="background:'
         +esc(r.bg||"#ccc")+'"></i><span>'+esc(r.t)+'</span></li>').join("")+'</ul>'
       +'<div id="legendSw"><span>色に頼らない表示</span>'
       +'<button class="sb" id="markBtn" type="button">記号を出す</button></div>')
    : "";
  if(D.manual&&D.manual.rows&&D.manual.rows.length){
    html+=sec("manual",D.manual.t||"説明書",
      legInner
      +(legInner?'<div class="tz-dsub">読み方</div>':"")
      +'<dl class="ddl">'+D.manual.rows.map(r=>'<dt>'+esc(r[0])+'</dt><dd>'
        +esc(r[1])+'</dd>').join("")+'</dl>');
  }else if(legInner){
    // 説明書が無い版でも色の意味だけは読めるようにしておく(保険)
    html+=sec("manual","説明書",legInner);
  }
  // 日別一覧(2026-08-18・谷川氏指示「シマヒートの資料に日別一覧を追加。
  // 日付からプラス率までの項目、表形式で記録し始めから最新日まで」)。
  // ★資料は原則「横スクロール無し」だが、ここは帳票PDFと同じ9列の表を
  //   そのまま読みたいという指示なので、**この表の枠の中だけ**横に送れる形にする
  //   (画面ごと横に動くわけではない)。日付の列は左に貼り付けて見失わないようにする。
  if(D.daily&&D.daily.rows&&D.daily.rows.length){
    const DD=D.daily, dc=DD.cols||[];
    html+=sec("daily",DD.t||"日別一覧",
      '<div class="dnote">'+esc(DD.dt||"")
      +(DD.note?'<br>'+esc(DD.note):"")+'</div>'
      +'<div class="dtwrap"><table class="dtbl"><thead><tr>'
      +dc.map((c,i)=>'<th'+(i?"":' class="dt-d"')+'>'+esc(c)+'</th>').join("")
      +'</tr></thead><tbody>'
      +DD.rows.map(r=>{
        const v=r.v||[], fc=r.fc||[];
        return '<tr'+(r.sum?' class="dt-sum"':"")+'>'
          +v.map((x,i)=>{
            const col=fc[i-1];      // 色は2列目以降(全台総差枚/1台平均/総収支/出率)
            return '<td'+(i?"":' class="dt-d"')+(i&&col?' style="color:'+esc(col)+'"':"")
              +'>'+esc(x)+'</td>';
          }).join("")+'</tr>';
      }).join("")
      +'</tbody></table></div>');
  }
  if(D.func&&D.func.rows&&D.func.rows.length){
    html+=sec("func",D.func.t||"機能",
      '<dl class="ddl">'+D.func.rows.map(r=>'<dt>'+esc(r[0])+'</dt><dd>'
        +esc(r[1])+'</dd>').join("")+'</dl>');
  }
  // 台入替(2026-08-15夕・谷川氏指示「台入替を資料の方に移設してください」)。
  // それまでは下部バーのボタンだったが、資料の1節に移した。開く物は同じ内訳
  // (新台・増台・減台・移動・撤去の5分類)で、入口だけが変わっている。
  // ★中身をここで組み立てないのは、内訳が iretae.json / notice.json の
  //   **読み込み待ち**だから。ボタンにしておけば、押した時点の最新で開ける。
  html+=sec("iretae","台入替",
    '<div class="dnote">島図の配置が変わった入替の内訳（新台・増台・減台・移動・撤去）を'
    +'開きます。押すと機種ごとの台番が一覧で出て、そこから島図の該当箇所を'
    +'光らせたり、移動の矢印を出したりできます。</div>'
    +'<button type="button" class="dbtn" id="docsIretae"'
    + (window.iretaeReady ? "" : " disabled") + '>台入替の内訳を見る</button>');
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
          // 機種ごとの実日数(2026-08-12・谷川氏指示「水曜日のみは機種毎に
          // 水曜日が何日分かを表記」)。8/3の入替で入った機種は水曜が1回しか
          // 無いのに、見出しの9日と同じ顔で並んでいた。**台数の隣**に置く
          // (「3台・2日分」=何台を何日ぶん均したのかが1目で分かる並び)。
          // 累計差枚(2026-08-12・谷川氏指示)。平均だけでは「何枚出ている機種か」が
          // 分からないため、その期間に実際に出た合計を末尾に添える。
          // 「◯日分」だけだと台数×日数で掛け戻せると誤解する(2026-08-12・谷川氏報告
          // 「日数の整合性があわない」)。平均G/台日と平均差枚/台日の分母は
          // **延べ台日**なので、そちらも併記する(防振り=64日間だが延べ92台日)。
          +'<span class="dr-s">'+esc(v[1])+(r.nd?'・'+r.nd+'日間':"")
          +(r.td?'（延べ'+r.td.toLocaleString()+'台日）':"")
          +'・'+esc(c[4]||"平均G")+' '+esc(v[4])
          +'・'+esc(c[5]||"平均差枚")+' '+esc(v[5])
          +(typeof r.sv==="number"
            ?('・累計差枚 <b class="'+(r.sv>0?"dr-p":(r.sv<0?"dr-m":""))+'">'
              +((r.sv>0?"+":"")+r.sv.toLocaleString())+"</b>"):"")+'</span>'
          +'<span class="dr-y" style="color:'+esc(fc[1]||"inherit")+'">'+esc(v[6])+'</span></li>';
      }).join("")+'</ol>',false,
      {head:rbase+"【"+pnm+"】",
       pre:[rday?"集計 : "+rday:"", rfml?rfml.replace(/=/," = "):""]});
  }
  // 特定日(2026-08-11・谷川氏指示「機種別出率の下に特定日(キャラ誕・記念日)のボタン配置。
  // 一覧で一年通してみれるように1/1から順番に表形式で」)。
  // 中身は SHIMA.toku(記念日の台帳 kinenbi.json ＋ 特定日の一次台帳 tokutei_calendar.json
  // ＋ 熱田設置機種のキャラ誕生日 kishu_manual.json の bd を、1/1から日付順にまとめた物)。
  // **横スクロールを作らない**のが資料タブの約束なので、列は3つ(日付/内容/対象)に絞り、
  // 由来は既定で隠して押したときだけ出す(全部出すと記念日1件で3行になり表が読めない)。
  const TK=TOKU||{};
  if(!TOKU&&SHIMA&&SHIMA.tokuUrl){
    // まだ届いていないときは節だけ出して読みに行く(届いたら資料を作り直す)。
    html+=sec("toku","特定日（キャラ誕・記念日）",
      '<div class="dempty">読み込み中…</div>',false);
    tokuLoad();
  }
  if(TK.days&&TK.days.length){
    const now=new Date(), tmd=(now.getMonth()+1)+"/"+now.getDate();
    const MON=["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
    // **列幅は colgroup で決める**(2026-08-11・谷川氏指示「日付と名前列の間を詰めて、
    // 名前ができるだけ折り返さないように」)。table-layout:fixed は**1行目のセル**から
    // 列幅を決めるが、この表の1行目は月の見出し(4列ぶち抜き)なので、td 側に width を
    // 書いても読まれず4等分(1列あたり約85px)になっていた。日付が3倍近く広く取られ、
    // そのぶん名前が折り返していたのはこれが原因。
    const COLS='<colgroup><col class="tkc-d"><col class="tkc-t">'
      +'<col class="tkc-g"><col class="tkc-i"></colgroup>';
    // 1行ぶん。由来(w)や出どころ(s)があれば、その下に隠した行を続けて置く
    // (押すと出る。既定で全部出すと記念日1件が3行になり一覧として読めない)。
    // 画像は右端の列(2026-08-11・谷川氏指示)。誕生日はキャラクターの顔写真、
    // 記念日は対象の機種の筐体写真。**顔は上寄せで切り、筐体は全体を入れる**
    // (立ち絵を中央で切ると胴体しか残らない・筐体を切ると機種が分からない)。
    // 画像は日付フォルダへ複製していないので asrc() で共有ぶんを指す。
    const row=(col1,name,target,why,src,bd,today,img,big)=>{
      const wh=[why||"", src?("出どころ : "+src):""].filter(Boolean);
      // 押すと大きく見られる(2026-08-11・谷川氏指示)。大きい版があればそちらを開く
      // (一覧用は高さ320pxしかなく、引き伸ばすと粗い)。説明は「名前 ／ 対象」。
      const im=img?'<img src="'+esc(asrc(img))+'" alt="" loading="lazy" '
        +'data-big="'+esc(asrc(big||img))+'" '
        +'data-cap="'+esc(name+(target?"　"+target:""))+'" '
        +'class="'+(img.indexOf("chara")===0?"tk-face":"tk-mac")+'">':"";
      // 長い名前・長い機種名だけ文字を小さくして1行に収める(2026-08-11・谷川氏指示
      // 「折り返しができる限りないように」)。列そのものを広げると相手の列が狭くなり、
      // どちらかが必ず折り返すため、はみ出す行だけを詰める。
      const L=String(name||"").length, G=String(target||"").length;
      const tc=L>=15?" s3":(L>=13?" s2":(L>=11?" s1":""));
      const gc=G>=11?" s1":"";
      return '<tr class="'+(bd?"tk-bd":"tk-kn")+(today?" is-today":"")
        +(wh.length?" tk-has":"")+'">'
        +'<td class="tk-d">'+esc(col1)+'</td>'
        +'<td class="tk-t'+tc+'">'+(bd?'<i class="tk-b">誕</i>':"")+esc(name)+'</td>'
        +'<td class="tk-g'+gc+'">'+esc(target||"")+'</td>'
        +'<td class="tk-im">'+im+'</td></tr>'
        +(wh.length?'<tr class="tk-w" hidden><td colspan="4">'
           +wh.map(x=>'<div>'+esc(x)+'</div>').join("")+'</td></tr>':"");
    };
    let rows="", mon=0;
    TK.days.forEach(e=>{
      const m=Math.floor(e.o/100);
      if(m!==mon){ mon=m;
        rows+='<tr class="tk-m"><th colspan="4">'+esc(MON[m-1]||(m+"月"))+'</th></tr>'; }
      rows+=row(e.md,e.t,e.g,e.w,e.s,e.k==="bd",e.md===tmd,e.i,e.il);
    });
    let cyc="";
    if(TK.cycle&&TK.cycle.length){
      // 毎月◯日・◯のつく日・曜日など、1/1からの並びに置けないもの。表の後ろへ回す。
      cyc='<div class="tk-ct">日付が決まっていない特定日 '+TK.cycle.length+'件</div>'
        +'<table class="dtoku tk-cyc">'+COLS+'<tbody>'
        +TK.cycle.map(c=>row(c.c,c.t,c.g,c.w,c.s,false,false,c.i,c.il)).join("")
        +'</tbody></table>';
    }
    // 東海のホールの年一・周年(2026-08-12・谷川氏指示「ZENTと熱田以外も年一と周年日を
    // 反映して」)。**上の表とは別の作りにする**=ホール名は長く、24店を並べた行もある。
    // 名前を1行に収める前提の .dtoku に混ぜると全部折り返すので、
    // 日付＋種別を左、ホール名と備考を右に置いて折り返してよい形にする。
    let hl="";
    if(TK.halls&&TK.halls.length){
      const KC={"年一":"k-nen","周年":"k-shu","特日":"k-toku"};
      const cn={};
      let hrows="",hm=0;
      TK.halls.forEach(e=>{
        cn[e.k]=(cn[e.k]||0)+1;
        const m=Math.floor(e.o/100);
        if(m!==hm){ hm=m;
          hrows+='<tr class="hl-m"><th colspan="2">'+esc(MON[m-1]||(m+"月"))+'</th></tr>'; }
        hrows+='<tr class="hl-r'+(e.md===tmd?" is-today":"")+'">'
          +'<td class="hl-d">'+esc(e.md)
          +'<i class="hl-k '+(KC[e.k]||"")+'">'+esc(e.k)+'</i></td>'
          +'<td class="hl-h">'+esc(e.h)
          +(e.p?'<span class="hl-p">'+esc(e.p)+'</span>':"")
          +(e.w?'<div class="hl-w">'+esc(e.w)+'</div>':"")+'</td></tr>';
      });
      hl='<div class="tk-ct">東海のホールの年一・周年 '+TK.halls.length+'件'
        +'（年一'+(cn["年一"]||0)+' ／ 周年'+(cn["周年"]||0)
        +' ／ 特日'+(cn["特日"]||0)+'）</div>'
        +(TK.hallsrc?'<div class="hl-src">出どころ : '+esc(TK.hallsrc)+'</div>':"")
        +'<table class="dhall"><colgroup><col class="hlc-d"><col></colgroup>'
        +'<tbody>'+hrows+'</tbody></table>';
    }
    const nk=TK.days.filter(x=>x.k==="kine").length;
    // 特定日の検索窓(2026-08-22・谷川氏指示「検索窓作って」)。768行あって、
    // 目当てのキャラや作品を探すのに1/1から延々スクロールする必要があった。
    // ★表は作り直さない。当てはまらない行にクラスを付けて隠すだけ
    //   (作り直すと打っている途中で指が離れ、日本語の変換も切れる。
    //    一覧の検索窓 #flQ と同じ考え方)。
    const tkSrch='<div class="tk-srch"><span class="tk-si" aria-hidden="true">'
      +'<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.4" '
      +'stroke="currentColor" stroke-width="2"/><path d="M15.8 15.8 20 20" '
      +'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>'
      +'<input id="tkQ" type="search" inputmode="search" enterkeyhint="done" '
      +'placeholder="キャラ名・作品名・日付で絞る" autocomplete="off" '
      +'autocorrect="off" spellcheck="false" value="'+esc(tokuQuery)+'">'
      +'<span id="tkQn"></span>'
      +'<button type="button" id="tkQx" aria-label="特定日の検索を消す" hidden>✕</button>'
      +'</div>'
      +'<div id="tkQnone" hidden>その言葉に当てはまる特定日はありません</div>';
    html+=sec("toku","特定日（キャラ誕・記念日）",
      tkSrch+'<table class="dtoku">'+COLS+'<tbody>'+rows+'</tbody></table>'+cyc+hl,false,
      {pre:["1/1から日付順。記念日 "+nk+"件 ／ キャラクターの誕生日 "
            +(TK.days.length-nk)+"件",
            "由来が分かっている行は押すと出どころつきで出る（今日の日付は色を付けてある）",
            "いちばん下に東海のホールの年一・周年（他店ぶん）を置いてある"]});
  }
  // 来店・取材・景品・おすすめ機種(2026-08-12・谷川氏指示「特定日の下に新しく来店ボタンと
  // 取材ボタン、景品ボタン、おすすめ機種ボタンを追加。把握しているデータをそれぞれ
  // 表形式で視覚的に見やすくいれてください」「取材や来店によって何が示唆されているかも
  // データとして載せる」「来店だと推し機種、取材だと公約などをまとめているデータ」)。
  // 中身は build_torizai_docs.py が4つの出どころから束ねた tori.<hash>.json。
  const TR=TORI||{};
  if(!TORI&&SHIMA&&SHIMA.toriUrl){
    html+=sec("raiten","来店",'<div class="dempty">読み込み中…</div>',false);
    toriLoad();
  }
  if(TR.raiten||TR.torizai||TR.keihin||TR.osusume){
    const num=v=>{const n=Number(String(v).replace(/[^\-0-9.]/g,""));
                  return isFinite(n)?n:null;};
    const sgn=n=>(n==null?"":(n>0?"fl-p":(n<0?"fl-m":"")));
    // 日付を左に立てて、右に中身。ホールの年一と同じ作り(長い文でも折り返してよい)。
    const drow=(d,head,body,cls)=>'<tr class="tz-r'+(cls||"")+'">'
      +'<td class="tz-d">'+esc(d||"")+'</td><td class="tz-b">'+head+(body||"")+'</td></tr>';
    const wrap=(rows,note)=>(note?'<div class="hl-src">'+esc(note)+'</div>':"")
      +'<table class="dtori"><colgroup><col class="tzc-d"><col></colgroup>'
      +'<tbody>'+rows+'</tbody></table>';

    // ---- 来店 ----
    if(TR.raiten&&TR.raiten.length){
      let r="";
      TR.raiten.forEach(e=>{
        const who=(e.who&&e.who.length)?e.who.join("・"):"";
        const push=(e.push&&e.push.length)?e.push.join("・"):"";
        const kishu=(e.kishu&&e.kishu.length)?e.kishu.join("・"):"";
        // 本文に出てきた機種名(2026-08-22)。★「推し機種」とは名乗らせない。
        //   公表された推し機種は台帳にほとんど無く(57日中1日)、本文の機種名は
        //   新台や景品の話であることもあるため、見た目も名前も別物として出す。
        const men=(e.men&&e.men.length)?e.men.join("・"):"";
        let head='<b>'+esc(who||"来店")+'</b>';
        if(push) head+='<span class="tz-tag">推し '+esc(push)+'</span>';
        if(kishu) head+='<span class="tz-tag tz-k">推し機種 '+esc(kishu)+'</span>';
        if(!kishu&&men) head+='<span class="tz-tag tz-men">本文の機種 '+esc(men)+'</span>';
        // 示唆の裏付け=推し系がその日どれだけ動いたか(店全体との差)
        let perf="";
        (e.perf||[]).forEach(p=>{
          const df=num(p.df);
          perf+='<div class="tz-p">'+esc(p.m||"")+' 当日'+esc(fmt(p.day))
            +' ／ 店'+esc(fmt(p.floor))+' ／ 差<b class="'+sgn(df)+'">'
            +esc(fmt(p.df))+'</b>'+(p.rate!=null?(' ／ プラス率'
            +Math.round(p.rate*100)+'%'):"")+'</div>';
        });
        // 告知の本文は長い(調べた経緯まで書いてある)。1件で画面が埋まるので
        // 3行で畳んでおき、読みたい人だけ開く(2026-08-22・谷川氏スクショで発覚)。
        const lng=String(e.n||"").length>110;
        const nt=e.n?('<div class="tz-n tz-memo'+(lng?" tz-clamp":"")+'">'
                      +esc(e.n)+'</div>'
                      +(lng?'<button type="button" class="tz-mmore">続きを読む</button>'
                           :"")):"";
        r+=drow(e.d,head,perf+nt);
      });
      html+=sec("raiten","来店",wrap(r),false,
        // 説明は実態に合わせる(2026-08-22)。推し機種は台帳に57日中1日しか無く、
        // 「演者名の右に推し機種が出る」と読める文言のままだと、出ていないのが
        // 不具合に見える(谷川氏報告「来店の推し機種がかかれてない」)。
        {pre:["新しい順。演者名の右は、分かっている日だけ推しメーカー系と推し機種",
              "「本文の機種」は告知の文に出てきた機種名。推し機種として"
              +"公表されたものではない（新台や景品の話のこともある）",
              "実績のある日は「当日／店／差」を並べてある（差＝推し系がその日の店平均を"
              +"どれだけ上回ったか）"]});
    }
    // ---- 演者・企画別のまとめ(来店の下) ----
    if(TR.engsha&&TR.engsha.length){
      // 2026-08-14・谷川氏指示「名前は折り返し入らないようにして、推し系が途切れてる」。
      // 6列を幅340pxのパネルに詰めると名前が2行に割れ、推し系が「パイオ…」と切れていた。
      // 回数・的中率は一目で要る情報ではないので詳細カードへ移し、表は4列に絞る。
      // 推し系は見出しが「推し系」なので値の末尾の「系」を落として字数を稼ぐ。
      const makerShort=s=>{
        const a=String(s||"").split(/[・,／\/]/).map(x=>x.trim().replace(/系$/,"")).filter(Boolean);
        if(!a.length) return "";
        return a.length>1?(a[0]+"＋"+(a.length-1)):a[0];
      };
      const rows=TR.engsha.map((e,i)=>{
        const dl=num(e.delta);
        // 当日全体(2026-08-14・谷川氏指示)。来店日の店全体の平均差枚。
        // フロア比だけだと「良い日に上回ったのか、沈んだ日にマシだっただけか」が
        // 読めないので、その日の地合いを並べて示す。
        const fl=(typeof e.floor==="number")?e.floor:null;
        const flTxt=(fl==null)?"−":((fl>0?"+":"")+fl.toLocaleString()+"枚");
        // 推し機種は台帳に入っている人だけ名前の下に小さく添える(空の人は出さない)。
        const kishu=e.kishu?'<span class="tz-ek">'+esc(e.kishu)+'</span>':"";
        const sub=esc(e.cat||"")+(e.n?("・"+esc(e.n)+"回"):"");
        return '<tr><td class="tz-en"><span class="tz-nm">'+esc(e.name)+'</span>'
          +'<span>'+sub+'</span>'+kishu+'</td>'
          +'<td class="tz-c tz-mk" title="'+esc(e.maker||"")+'">'+esc(makerShort(e.maker))+'</td>'
          +'<td class="tz-c '+sgn(dl)+'">'+esc(e.delta||"")+'</td>'
          +'<td class="tz-c '+(fl==null?"":sgn(fl))+'">'+esc(flTxt)+'</td>'
          +'<td class="tz-c"><button class="tz-more" data-i="'+i+'">詳細</button></td></tr>'
          +'<tr class="tz-det" id="tzdet'+i+'" hidden><td colspan="5"></td></tr>';
      }).join("");
      html+=sec("engsha","演者・企画ごとの実績",
        '<table class="dengsha">'
        +'<colgroup><col class="c-nm"><col class="c-mk"><col class="c-v1">'
        +'<col class="c-v2"><col class="c-bt"></colgroup>'
        +'<thead><tr><th>名前</th><th>推し系</th>'
        +'<th>フロア比</th><th>当日全体</th><th></th></tr></thead><tbody>'+rows
        +'</tbody></table>',
        false,{pre:["フロア比＝その演者の推しメーカー系が来店日に店平均をどれだけ"
                    +"上回ったかの平均",
                    "当日全体＝その来店日の店全体の平均差枚。フロア比がプラスでも"
                    +"当日全体がマイナスなら、店が沈んだ日に相対的にマシだっただけ",
                    "名前の下に種別・回数・推し機種（推し機種は台帳に入っている人のみ）",
                    "「詳細」で来店日ごとの内訳とグラフが開く",
                    "回数の少ない人は目安（サンプル不足）"]});
      // 詳細カード(2026-08-14・谷川氏指示「詳細ボタンを設置して、そのカードの中に
      // 総差枚数とかプラス率、該当する日付など、さまざまな情報を表形式でいれて
      // 視覚的に見やすく、グラフも入れて欲しい」)。
      // 中身は来店の節と同じ TR.raiten から組む(数字の出どころを二重に持たない)。
      window.__engDetail=(i)=>{
        const e=(TR.engsha||[])[i]; if(!e) return "";
        const nm=String(e.name||"").trim();
        // 来店・取材・企画のどれでも開けるようにする(2026-08-14・谷川氏指示
        // 「来店時、取材時、企画時の日のその時のおすすめ機種も強いかどうか」)。
        // 来店は who(演者名)で、取材/企画は本文に名前が出るかで拾う。
        // ★2026-08-14修正(谷川氏指摘「ほしまみ2回では？」)。当初は本文に名前が出る日も
        // 拾ったが、本文には「ほしまみさん来店取材/来店(遡及)」のような遡及メモや
        // 「推し機種=…」の参考メモが並ぶため、実際には来ていない日まで数えて8回になった。
        // 演者は who(演者欄)だけで判定する。本文照合は who に名前が入らない取材企画に限る。
        const isEvent=/取材|企画/.test(String(e.cat||""));
        const hitTxt=x=>isEvent&&String((x&&(x.n||""))+" "+(x&&(x.t||""))).indexOf(nm)>=0;
        const seen={}, days=[];
        const push=(x,kind)=>{
          const d=String(x.d||""); if(!d||seen[d]) return;
          seen[d]=1; days.push({d:d,kind:kind,floor:x.floor,perf:x.perf,n:x.n});
        };
        (TR.raiten||[]).forEach(x=>{ if((x.who||[]).some(w=>String(w).trim()===nm)||hitTxt(x)) push(x,"来店"); });
        (TR.torizai||[]).forEach(x=>{ if(hitTxt(x)) push(x,"取材"); });
        (TR.keihin||[]).forEach(x=>{ if(hitTxt(x)) push(x,"景品"); });
        if(!days.length) return '<div class="tz-dnone">該当する日の記録がありません</div>';
        // 日付を島図データの列に対応づける。ラベルは "7/24(金)"、日付は "7/24"。
        const L=(typeof DATA!=="undefined"&&DATA.labels)||[];
        const MD=s=>{const m=/^(\d+)\/(\d+)/.exec(String(s||"").trim());
          return m?(Number(m[1])*100+Number(m[2])):null;};
        const idxOf=md=>L.findIndex(s=>MD(s)===MD(md));
        days.sort((a,b)=>(MD(a.d)||0)-(MD(b.d)||0));   // 古い順(グラフを時系列で読む)
        // ★島図データに無い日は落とす(2026-08-14)。取得は6/9以降なので、4/5や11/7のような
        // 範囲外の日を残すと、数字が全部「−」の行とグラフの空きだけが並んで読めなくなる。
        {
          const keep=days.filter(d=>idxOf(d.d)>=0);
          if(keep.length) days.length=0, Array.prototype.push.apply(days,keep);
        }
        // その日の店全体の平均差枚(台帳に無い日は島図から数え直す)
        const dayAll={};
        const allIdx=days.map(d=>idxOf(d.d));
        if(typeof DATA!=="undefined"&&DATA.machines){
          allIdx.forEach(k=>{ if(k<0) return;
            let s=0,n=0,p=0,g=0,gn=0;
            Object.keys(DATA.machines).forEach(dai=>{
              const x=(DATA.machines[dai].d||[])[k];
              if(!x||x[0]==null) return;
              s+=x[0]; n++; if(x[0]>0)p++;
              if(x[1]!=null&&x[1]>0){ g+=x[1]; gn++; }
            });
            dayAll[k]={avg:n?Math.round(s/n):null,sum:s,n:n,p:p,g:gn?Math.round(g/gn):null};
          });
        }
        // 機種ごとに、該当日ぶんを合算する
        const byModel={};
        let allSum=0,allN=0,allPlus=0,allG=0,allGn=0;
        if(typeof DATA!=="undefined"&&DATA.machines){
          Object.keys(DATA.machines).forEach(dai=>{
            const m=DATA.machines[dai]; if(!m||!m.d) return;
            const key=m.n||"（機種名なし）";
            allIdx.forEach(k=>{ if(k<0) return;
              const x=m.d[k]; if(!x||x[0]==null) return;
              const g=byModel[key]||(byModel[key]={s:0,n:0,p:0});
              g.s+=x[0]; g.n++; if(x[0]>0) g.p++;
              allSum+=x[0]; allN++; if(x[0]>0) allPlus++;
              if(x[1]!=null&&x[1]>0){ allG+=x[1]; allGn++; }
            });
          });
        }
        const ranked=Object.keys(byModel).map(k=>({k:k,a:Math.round(byModel[k].s/byModel[k].n),
          n:byModel[k].n,s:byModel[k].s,pr:Math.round(byModel[k].p/byModel[k].n*100)}))
          .filter(x=>x.n>=3).sort((a,b)=>b.a-a.a);
        const top3=ranked.slice(0,3), bot3=ranked.slice(-3).reverse();
        // その日の「店のおすすめ機種」が実際に強かったか(2026-08-14・谷川氏指示)。
        // TR.osusume の period は "8/2〜8/8" や "7/19" の形。該当日を含むものを拾い、
        // その機種のその日の平均差枚を島図から数えて、店全体と比べる。
        const inPeriod=(period,md)=>{
          const s=String(period||"").replace(/\s/g,"");
          const parts=s.split(/[〜~-]/).filter(Boolean);
          const v=MD(md); if(v==null||!parts.length) return false;
          const a=MD(parts[0]); const b=parts[1]?MD(parts[1]):a;
          return a!=null&&b!=null&&v>=a&&v<=b;
        };
        let orow="";
        days.forEach((d,di)=>{
          const k=allIdx[di]; if(k<0) return;
          const hits=(TR.osusume||[]).filter(o=>inPeriod(o.period,d.d));
          const names=[];
          hits.forEach(o=>{ String(o.kishu||"").split(/[／\/・]/).forEach(x=>{
            x=x.trim(); if(x&&names.indexOf(x)<0) names.push(x); }); });
          if(!names.length){
            orow+='<tr><td>'+esc(d.d)+'</td><td class="tz-mn">（おすすめの記録なし）</td>'
              +'<td>−</td><td>−</td><td>−</td></tr>';
            return;
          }
          names.forEach(kn=>{
            let s=0,n=0,p=0;
            Object.keys(DATA.machines||{}).forEach(dai=>{
              const m=DATA.machines[dai];
              if(!m||String(m.n||"")!==kn) return;
              const x=(m.d||[])[k]; if(!x||x[0]==null) return;
              s+=x[0]; n++; if(x[0]>0)p++;
            });
            const av=n?Math.round(s/n):null;
            const fa=(dayAll[k]&&dayAll[k].avg!=null)?dayAll[k].avg:null;
            const df=(av!=null&&fa!=null)?(av-fa):null;
            const jd=(df==null)?"−":(df>0?"◎ 強い":(df<-200?"× 弱い":"△ 並"));
            orow+='<tr><td>'+esc(d.d)+'</td><td class="tz-mn">'+esc(kn)+'</td>'
              +'<td class="'+(av==null?"":sgn(av))+'">'+(av==null?"−":((av>0?"+":"")+av.toLocaleString()))+'</td>'
              +'<td>'+(n?n+"台":"−")+'</td>'
              +'<td class="'+(df==null?"":sgn(df))+'">'+jd+'</td></tr>';
          });
        });
        let sum=0,cnt=0,plus=0,fsum=0,fcnt=0;
        const pts=[];
        let tr="";
        days.forEach((d,di)=>{
          const k=allIdx[di];
          let f=(typeof d.floor==="number")?d.floor:null;
          if(f==null&&k>=0&&dayAll[k]) f=dayAll[k].avg;
          const ps=(d.perf||[]).filter(p=>typeof p.day==="number");
          const dv=ps.length?Math.round(ps.reduce((a,p)=>a+p.day,0)/ps.length):null;
          const df=(dv!=null&&f!=null)?(dv-f):null;
          const rt=(d.perf||[]).filter(p=>typeof p.rate==="number");
          const rv=rt.length?(rt.reduce((a,p)=>a+p.rate,0)/rt.length):null;
          if(dv!=null){ sum+=dv; cnt++; if(dv>0) plus++; }
          if(f!=null){ fsum+=f; fcnt++; }
          pts.push({d:String(d.d||""),v:dv,f:f});
          tr+='<tr><td>'+esc(d.d||"")+'<span class="tz-kd">'+esc(d.kind||"")+'</span></td>'
            +'<td class="'+(dv==null?"":sgn(dv))+'">'+(dv==null?"−":((dv>0?"+":"")+dv.toLocaleString()))+'</td>'
            +'<td class="'+(f==null?"":sgn(f))+'">'+(f==null?"−":((f>0?"+":"")+f.toLocaleString()))+'</td>'
            +'<td class="'+(df==null?"":sgn(df))+'">'+(df==null?"−":((df>0?"+":"")+df.toLocaleString()))+'</td>'
            +'<td>'+(rv==null?"−":(Math.round(rv*100)+"%"))+'</td></tr>';
        });
        // 日ごとの店全体(2026-08-14・谷川氏指摘「日付ごとの総差枚数がない」
        // 「店のプラス率というよりプラスだった台が何台あったか」)。
        // 上の表は「推し系」と「店全体の"平均"」を比べるものなので、その日に店が
        // 実際どれだけ出したか(総差枚)と、何台がプラスだったかが読めなかった。
        // 平均Gは上の要点(店の平均G)に出ているので列に入れない(4列に収めて横スクロールを
        // 出さないため)。プラス率も台数から読めるので数字は台数の方を正とする。
        let ar="";
        days.forEach((d,di)=>{
          const k=allIdx[di], a=(k>=0?dayAll[k]:null);
          const sm=(a&&a.n)?a.sum:null;
          ar+='<tr><td>'+esc(d.d||"")+'</td>'
            +'<td class="'+(sm==null?"":sgn(sm))+'">'
            +(sm==null?"−":((sm>0?"+":"")+sm.toLocaleString()))+'</td>'
            +'<td class="'+((a&&a.p)?"fl-p":"")+'">'
            +((a&&a.n)?(a.p.toLocaleString()+"台"):"−")+'</td>'
            +'<td>'+((a&&a.n)?(a.n.toLocaleString()+"台"):"−")+'</td></tr>';
        });
        const avg=cnt?Math.round(sum/cnt):null;
        const favg=fcnt?Math.round(fsum/fcnt):null;
        const prate=cnt?Math.round(plus/cnt*100):null;
        const sgnum=v=>(v==null?"−":((v>0?"+":"")+v.toLocaleString()+"枚"));
        // グラフ(2026-08-14に作り直し・谷川氏指示「グラフがわかりづらい」)。
        // 旧版は推し系の棒に店全体を細い横線で重ねていて、どちらがどれか読めなかった。
        // 日ごとに2本並べる形にし、色分け+凡例+日付+数値を付ける。
        const W=320,H=132,padL=6,padR=6,padT=16,padB=22;
        const gw=(W-padL-padR)/Math.max(1,pts.length);
        const bw=Math.min(22,Math.max(6,gw/2-5));
        const vals=[];
        pts.forEach(p=>{ if(p.v!=null)vals.push(p.v); if(p.f!=null)vals.push(p.f); });
        const mx=Math.max(1,...vals.map(Math.abs));
        const y0=padT+(H-padT-padB)/2, half=(H-padT-padB)/2-2;
        let g='<svg class="tz-g" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet"'
          +' role="img" aria-label="日ごとの差枚">'
          +'<line x1="0" y1="'+y0+'" x2="'+W+'" y2="'+y0+'" class="tz-g0"/>';
        pts.forEach((p,k)=>{
          const cx=padL+(k+0.5)*gw;
          const draw=(v,dx,cls)=>{
            if(v==null) return "";
            const h=Math.max(1,Math.abs(v)/mx*half);
            const y=v>=0?(y0-h):y0;
            const ly=v>=0?(y-3):(y+h+9);
            return '<rect x="'+(cx+dx-bw/2)+'" y="'+y+'" width="'+bw+'" height="'+h
              +'" rx="2" class="'+cls+'"/>'
              +'<text x="'+(cx+dx)+'" y="'+ly+'" class="tz-gv">'+((v>0?"+":"")+v)+'</text>';
          };
          g+=draw(p.v,-bw/2-1,"tz-gp")+draw(p.f,bw/2+1,"tz-gf");
          g+='<text x="'+cx+'" y="'+(H-6)+'" class="tz-gx">'+esc(p.d)+'</text>';
        });
        g+='</svg>';
        const kv=(k,v)=>'<div class="tz-kv"><span>'+k+'</span><b>'+v+'</b></div>';
        const mrow=(x,rank)=>'<tr><td class="tz-mn">'+rank+' '+esc(x.k)+'</td>'
          +'<td class="'+sgn(x.a)+'">'+((x.a>0?"+":"")+x.a.toLocaleString())+'</td>'
          +'<td>'+x.n+'</td><td>'+x.pr+'%</td></tr>';
        const mtbl=(ttl,arr,marks)=>arr.length?('<div class="tz-dsub">'+ttl+'</div>'
          +'<table class="tz-dt tz-mt"><thead><tr><th>機種</th><th>平均</th>'
          +'<th>台日</th><th>プラス率</th></tr></thead><tbody>'
          +arr.map((x,j)=>mrow(x,marks[j]||"")).join("")+'</tbody></table>'):"";
        const kinds=[];
        days.forEach(d=>{ if(kinds.indexOf(d.kind)<0) kinds.push(d.kind); });
        // 「この日」がどの日を指すのかを見出しに書く(2026-08-14・谷川氏指摘
        // 「この日強かった弱かったがどの日を指しているのかわからない」)。
        // TOP3/ワースト3は**該当日を全部まとめた**集計なので、「この日」と書くと
        // 1日ぶんの話に読めてしまう。日付を並べて、何日ぶんを合わせたのかを明示する。
        const dl=days.map(d=>String(d.d||"")).filter(Boolean);
        const dtxt=(dl.length<=4)?dl.join("・")
                  :(dl[0]+"〜"+dl[dl.length-1]+" の"+dl.length+"日");
        const dhd=(dl.length===1)?(dtxt+" に"):("該当日"+dl.length+"回（"+dtxt+"）を合わせて");
        return '<div class="tz-dwrap">'
          +'<div class="tz-dhead">'+esc(nm)+' の該当日'+days.length+'回'
          +'（'+esc(kinds.join("・"))+'）</div>'
          +'<div class="tz-kvs">'
            +kv("推し系の平均",sgnum(avg))
            +kv("店全体の平均",sgnum(favg))
            +kv("店の総差枚",allN?((allSum>0?"+":"")+allSum.toLocaleString()+"枚"):"−")
            // 率ではなく**プラスだった台が何台か**を先に出す(2026-08-14・谷川氏指摘)。
            // 該当日が複数あるときは日をまたいだ延べ台数になるので「延べ」と断る。
            +kv("プラスだった台",allN
                ?((dl.length>1?"延べ":"")+allPlus.toLocaleString()+"台 / "
                  +allN.toLocaleString()+(dl.length>1?"台日":"台")
                  +"（"+Math.round(allPlus/allN*100)+"%）")
                :"−")
            +kv("推し系がプラス",prate==null?"−":(plus+"/"+cnt+"日 "+prate+"%"))
            +kv("店の平均G",allGn?Math.round(allG/allGn).toLocaleString()+"G":"−")
            +kv("推し系",esc(e.maker||"−"))
            +kv("的中率",esc(e.hit||"−"))
            +(e.kishu?kv("推し機種",esc(e.kishu)):"")
          +'</div>'
          +'<div class="tz-dsub">日ごとの差枚</div>'
          +'<div class="tz-glg"><i class="tz-lp"></i>推し系　<i class="tz-lf"></i>店全体</div>'
          +g
          // 「プラス率」は店ではなく**推し系メーカーの機種**のプラス率(day_rate)なので、
          // 見出しにそう書く(2026-08-14。店全体の列の隣にあるため店の率だと読めていた)。
          +'<table class="tz-dt"><thead><tr><th>日付</th><th>推し系</th><th>店全体</th>'
          +'<th>差</th><th>推し系<br>プラス率</th></tr></thead><tbody>'+tr+'</tbody></table>'
          +'<div class="tz-gl">推し系・店全体は1台あたりの平均差枚</div>'
          +'<div class="tz-dsub">日ごとの店全体</div>'
          +'<table class="tz-dt"><thead><tr><th>日付</th><th>総差枚</th>'
          +'<th>プラス台</th><th>稼働台</th></tr></thead><tbody>'+ar+'</tbody></table>'
          +(orow?('<div class="tz-dsub">その日の店のおすすめ機種は強かったか</div>'
            +'<table class="tz-dt tz-ot"><thead><tr><th>日付</th><th>おすすめ機種</th>'
            +'<th>当日平均</th><th>台数</th><th>判定</th></tr></thead><tbody>'
            +orow+'</tbody></table>'
            +'<div class="tz-gl">判定は店全体との差。◎=店平均超え ／ △=並 ／ ×=200枚以上下</div>'):"")
          +mtbl(dhd+"強かった機種 TOP3",top3,["🥇","🥈","🥉"])
          +mtbl(dhd+"弱かった機種 ワースト3",bot3,["🔻","🔻","🔻"])
          +(ranked.length?'<div class="tz-gl">機種は3台日以上のものだけ順位付け（'
            +ranked.length+'機種が対象）</div>':"")
          +'</div>';
      };
    }
    // ---- 取材 ----
    if(TR.torizai&&TR.torizai.length){
      let r="";
      TR.torizai.forEach(e=>{
        r+=drow(e.d,'<div class="tz-n">'+esc(e.n||e.t||"")+'</div>');
      });
      let dic="";
      if(TR.torizai_dict&&TR.torizai_dict.length){
        let md="",dr="";
        TR.torizai_dict.forEach(x=>{
          if(x.media!==md){ md=x.media;
            dr+='<tr class="tz-m"><th colspan="2">'+esc(md)+'</th></tr>'; }
          dr+='<tr><td class="tz-kn">'+esc(x.name)+'</td>'
            +'<td class="tz-kv">'+esc(x.kouyaku)+'</td></tr>';
        });
        dic='<div class="tk-ct">取材ごとの公約 '+TR.torizai_dict.length+'件</div>'
          +'<table class="dtori dkou"><colgroup><col class="tzc-n"><col></colgroup>'
          +'<tbody>'+dr+'</tbody></table>';
      }
      html+=sec("torizai","取材",wrap(r)+dic,false,
        {pre:["新しい順。下に取材ごとの公約をまとめてある",
              "公約広告は禁止されているので、いまはどれも「店次第」。過去の実績で"
              +"その店の履行傾向を見る"]});
    }
    // ---- 景品 ----
    if(TR.keihin&&TR.keihin.length){
      let r="";
      TR.keihin.forEach(e=>{ r+=drow(e.d,'<div class="tz-n">'+esc(e.item)+'</div>'); });
      html+=sec("keihin","景品",wrap(r),false,
        {pre:["賞品入荷の記録（新しい順）",
              "賞品系は集客が目的で、設定に直結しないことが多い"]});
    }
    // ---- おすすめ機種 ----
    if(TR.osusume&&TR.osusume.length){
      const rows=TR.osusume.map(e=>{
        const av=num(e.avg);
        return '<tr><td class="tz-d">'+esc(e.period)+'<span>'+esc(e.days||"")+'日</span></td>'
          +'<td class="tz-b"><b>'+esc(e.kishu)+'</b>'
          +(e.judge?'<span class="tz-tag'+(/強/.test(e.judge)?" tz-hot":"")+'">'
            +esc(e.judge)+'</span>':"")
          +'<div class="tz-p">平均差枚/台日 <b class="'+sgn(av)+'">'+esc(e.avg)+'</b></div>'
          +(e.result?'<div class="tz-n">'+esc(e.result)+'</div>':"")
          +(e.pachi?'<div class="tz-n tz-sub">パチ側 '+esc(e.pachi)+'</div>':"")
          +'</td></tr>';
      }).join("");
      html+=sec("osusume","おすすめ機種",
        // ★日付の欄は来店・取材より広くする(2026-08-22・谷川氏報告「日付が被ってる」)。
        //   ここだけ「8/11〜8/17」と**期間**が入るので、単日用の4.6emでは入りきらず、
        //   nowrapのまま隣の機種名の上へはみ出していた。
        '<table class="dtori"><colgroup><col class="tzc-dw"><col></colgroup>'
        +'<tbody>'+rows+'</tbody></table>',false,
        {pre:["P-WORLD店舗ページの「おすすめ」を毎晩控えて、その期間の実績を突き合わせたもの",
              "★強い＝プラス率・フロア比・自分の平均比のどれもが上回った期間"]});
    }
  }
  // ★狙い方別の期待値表はここにあったが、2026-08-15夕に**絞り込みパネルの
  //   「期待値表」ボタンへ移した**(谷川氏指示)。資料には置かない。
  //   書き出しは nrHtml() のまま、開く場所だけが変わっている。
  if(LOG.length){
    html+=sec("log","更新履歴",
      '<ol class="dlog">'+LOG.map(e=>'<li><div class="dlh"><span class="dld">'
        +esc(e.d)+'</span><span class="dlt">'+esc(e.t)+'</span>'
        +(e.tag?'<span class="dlg">'+esc(e.tag)+'</span>':"")+'</div>'
        +'<ul>'+(e.it||[]).map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></li>')
        .join("")+'</ol>');
  }
  host.innerHTML=html||'<div class="dempty">資料がありません</div>';
  docsRegroup(host);
  tkQApply();          // 作り直しても打った言葉は残す
  syncDocsFold();
  // 節の末尾の「↑ 閉じる」(2026-08-06・谷川氏指示)。節ごとにボタンを結ばず、
  // 資料の入れ物に1つだけ置いて拾う(資料は作り直されるが入れ物は同じなので、
  // ここで1回付ければ足りる)。閉じたあとは見出しが画面に入る位置まで戻す。
  // 台入替の内訳を開く(2026-08-15夕・下部バーから移設)。資料は作り直されるが
  // 入れ物は同じなので、ここで1回だけ結ぶ。
  if(!host.dataset.irTap){ host.dataset.irTap="1";
    host.addEventListener("click",e=>{
      if(!e.target.closest("#docsIretae")) return;
      if(typeof window.openIretae==="function") window.openIretae();
    });
  }
  if(!host.dataset.upTap){ host.dataset.upTap="1";
    host.addEventListener("click",e=>{
      const b=e.target.closest(".dupbk");
      if(!b) return;
      const d=b.closest("details");
      if(!d) return;
      d.open=false;
      d.scrollIntoView({block:"nearest"});
    });
    // 特定日の検索窓(2026-08-22)。表は作り直されるが入れ物は同じなので、
    // ここで1回だけ結ぶ(1つずつ結び直さない)。
    host.addEventListener("input",e=>{
      const q=e.target.closest("#tkQ");
      if(!q) return;
      tokuQuery=q.value||"";
      tkQApply();
    });
    // 来店の長い本文の開け閉め(2026-08-22)
    host.addEventListener("click",e=>{
      // ★クラス名は .tz-more ではなく .tz-mmore(2026-08-22)。.tz-more は
      //   演者一覧の「詳細」ボタンで先に使われており、同じ名前にすると
      //   どちらを押しても両方の処理が動いてしまう。
      const b=e.target.closest(".tz-mmore");
      if(!b) return;
      const d=b.previousElementSibling;
      if(!d) return;
      const on=d.classList.toggle("tz-clamp");
      b.textContent=on?"続きを読む":"閉じる";
    });
    host.addEventListener("click",e=>{
      if(!e.target.closest("#tkQx")) return;
      tokuQuery="";
      const q=document.getElementById("tkQ"); if(q) q.value="";
      tkQApply();
      if(q) q.focus();
    });
    // 節の開け閉めのたびに、固定の「閉じる」を出すか決め直す
    host.addEventListener("toggle",()=>{ syncDocsFold(); },true);
    // 特定日の行を押すと、その下の由来の行を出し入れする(2026-08-11)。
    // 由来の行は表の中に隠して置いてあるので、開いても列の幅は動かない。
    // **画像を押したときは拡大が優先**(由来は開かない)。
    host.addEventListener("click",e=>{
      const im=e.target.closest(".tk-im img");
      if(im){ e.stopPropagation();
              openPhoto(im.dataset.big||im.src, im.dataset.cap||""); return; }
      const tr=e.target.closest("tr.tk-has");
      if(!tr) return;
      const w=tr.nextElementSibling;
      if(w&&w.classList.contains("tk-w")){
        w.hidden=!w.hidden; tr.classList.toggle("is-open",!w.hidden);
      }
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
  // 資料を見ている間だけ body にも印を付ける(2026-08-22)。島図に浮かせている
  // 「★一覧」「★ピン」と上端のステータスは島図のための物なので、資料の本文に
  // 重ならないよう引っ込める。#board の中のクラスでは外側の固定要素へ届かない。
  document.body.classList.toggle("v-docs",v==="docs");
  if(typeof syncDocsFold==="function") syncDocsFold();
  const barH=fitBar()||104;
  // 上端の常時ステータス(2026-08-22新設)のぶんも引く。引き忘れると、フィット表示
  // なのに文書がその高さだけ縦に動く余地を持ってしまう(verify_shimaheat_pan の
  // [4]「フィットでは縦に動く余地がない」が実際に落ちた)。
  const tsEl=document.getElementById("topStat");
  const tsH=(tsEl&&!tsEl.hidden)?Math.round(tsEl.getBoundingClientRect().height):0;
  const availH=Math.max(200,window.innerHeight-barH-tsH-4), availW=window.innerWidth-4;
  let w,h,sc,ty;
  if(v==="island"){
    w=IW; h=IH; ty=0;
    // ★パソコン(広い窓)では**島図の全体が見えること**を優先する(2026-08-14・谷川氏指示
    //   「最大縮小したときに島図全体が見えるようにしてほしい」)。それまでは幅に合わせて
    //   いたので、横は収まるのに縦がバーの下へはみ出して下の島が切れていた。
    //   縦横の小さいほうに合わせれば必ず全部入る(広い窓なら台番も読める大きさが残る)。
    //   スマホは従来どおり(全体を入れると台番が読めない大きさになるので高さ合わせ)。
    sc=(window.innerWidth>=PC_WIDE)
       ? Math.min(availW/w, availH/h)
       : Math.max(availW/w, Math.min(availH/h, 0.6));   // 高さフィット(幅フィットを下回らない)
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
  // 横も同じ扱い(2026-08-14)。広い窓で全体を入れると盤面のほうが細くなることがあり、
  // 左に貼り付いて右が大きく空く。余っているぶんは左右に等分する
  // (余りがあるときだけなので、横スクロールが要る状態には影響しない)。
  const gapX=(v==="island")?Math.max(0,(availW-w*curSc)/2):0;
  stage.style.marginLeft=gapX?gapX+"px":"";
  document.getElementById("docsBtn").classList.toggle("is-on",v==="docs");
  document.getElementById("zoomOut").classList.toggle("show",zoomF>1);
  // 出し入れした直後に位置を引き直す(2026-08-14夕)。fitTabbar は**出ているボタンだけ**
  // 左右を決める作りにしたので、show を付けた回で呼ばないと右端に寄ったままになる。
  if(typeof fitTabbar==="function") fitTabbar();
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
// 2カラムの入切(2026-08-14)。窓の幅が境目をまたいだときだけ作り直す
// (またいでいなければ何もしないので、ドラッグでの連続リサイズでも重くならない)。
window.addEventListener("resize",()=>{
  if(!syncPcMode()) return;
  setView(curView,true);
  if(document.getElementById("modal").style.display==="block"){ fitModal(); fitCard(); }
  // 開いているパネルも作り直す(幅が変わるので、そのままだと前の幅で貼り付いたままになる)
  if(document.getElementById("filterModal").style.display==="block") fitFilterModal();
  if(document.getElementById("searchModal").style.display==="block") fitSearchModal();
  const pmr=document.getElementById("pinModal");
  if(pmr&&pmr.style.display==="block") fitPinModal();
  const am=document.getElementById("aiModal");
  if(am&&am.style.display==="block"){ fitAiModal(); if(typeof aiPaint==="function") aiPaint(); }
});
syncPcMode();          // 最初の描画の前に決める(カードの幅と島図の倍率がこれで変わる)
setView("island");
// パソコンでは**最初から少し寄せて**開く(2026-08-14・谷川氏指示「開いたときの画面が
// 小さい、ある程度拡大した状態で最初から表示」)。広い窓では「全体が入る倍率」まで
// 引くと台番セルが約18×10pxになり、番号が読めない。台番セルの生寸法93pxが
// 画面上40pxくらいになる倍率まで寄せる(＝読める大きさ)。
// **最大縮小(zoomF=1)で全体が見えること自体は変えていない**ので、引けば全体に戻る。
// URLで倍率が指定されているときは触らない(restoreFromUrl が後から上書きする)。
(()=>{
  if(window.innerWidth<PC_WIDE) return;
  // URLで台や資料が指定されているときは触らない(restoreFromUrl が後から場所を決めるので、
  // 先に倍率を動かすと復元先とけんかする)。
  if(/[?&](d|v)=/.test(location.search)) return;
  const want=Math.max(1,Math.min(3,0.43/(baseSc||0.2)));
  if(want>1.05){ zoomF=want; setView("island",true); }
})();
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
  // 2026-08-14夕・谷川氏指示「元に戻すというより元画面に戻るボタンにしてください」:
  // 台入替の内訳から光らせた/矢印を出したときは、光を消したうえで**その一覧を開き直す**。
  // clearMove() が戻り先を捨てるので、先に控えてから消す。
  if(b) b.addEventListener("click",e=>{
    e.stopPropagation();
    const back=mvBack;
    clearMove();
    if(back) back();
  });
})();
// ---- マウスのホイールで拡大・縮小(2026-08-14・谷川氏指示「PC版 マウスホイール
//      アップ回転操作で拡大、マウスホイールダウン回転操作で縮小」) ----
// 指のピンチと**同じ setZoom** を呼ぶので、倍率の上限下限(1〜6倍)も
// 「全体に戻す」ボタンの出方も揃う。カーソルの位置を軸にするので、
// 見たい台に当てたまま寄れる(ダブルタップ拡大と同じ考え方)。
// ブラウザ既定のページズーム/スクロールは preventDefault で止める
// (止めないと、拡大しながらページも動いて狙いが定まらない)。
(()=>{
  const wrap=document.getElementById("wrap");
  if(!wrap)return;
  let q=null,raf=0;
  const queue=(zf,cx,cy)=>{
    q={zf:zf,cx:cx,cy:cy};
    if(raf)return;
    raf=requestAnimationFrame(()=>{ raf=0; const p=q; q=null; if(p)setZoom(p.zf,p.cx,p.cy); });
  };
  wrap.addEventListener("wheel",e=>{
    // Ctrl+ホイールはブラウザのページ拡大。OSの機能なので横取りしない。
    if(e.ctrlKey)return;
    // deltaY の単位は端末で違う(0=px / 1=行 / 2=画面)。行・画面のときは
    // px 相当へ直してから使う=どの環境でも1目盛りの効き目をそろえる。
    let d=e.deltaY;
    if(e.deltaMode===1) d*=16;
    else if(e.deltaMode===2) d*=(window.innerHeight||800);
    if(!d)return;
    e.preventDefault();
    // 上回転(d<0)で寄る・下回転(d>0)で引く。1目盛り(約100px)で約1.25倍。
    // 指数にしているのは、倍率が上がっても下がっても同じ手応えにするため
    // (足し算だと高倍率で効きが鈍り、低倍率で飛びすぎる)。
    const f=Math.max(0.5,Math.min(2,Math.exp(-d*0.0022)));
    queue(zoomF*f,e.clientX,e.clientY);
  },{passive:false});
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
  // ---- マウスで掴んで動かす(2026-08-14・谷川氏指示「PCブラウザでクリックしながら
  //      ドラッグしたとき上下ななめ自在に動かせるようにして」) ----
  // それまでは touch にしか配線しておらず、PCではスクロールバーかホイールでしか
  // 動かせなかった。動かす先は指のパンと**同じ経路**にする
  // (横=#wrapのscrollLeft / 縦=文書スクロール)。ここを別経路にすると、
  // 指とマウスで挙動が食い違い、片方だけ直す作業が生まれる。
  // 指と違い、担当の振り分け(縦をブラウザに任せる)は要らない。ブラウザは
  // マウスのドラッグで勝手にスクロールしないので、両軸とも素直に自前で動かせる。
  // 慣性は付けない(マウスは指のように払う操作をしないので、滑ると狙いがずれる)。
  let mdn=false,mx=0,my=0,mdist=0;
  wrap.addEventListener("mousedown",e=>{
    if(e.button!==0)return;                       // 左ボタンだけ
    // 入力欄やボタンの上では掴まない(選択・押下を邪魔しない)
    if(e.target&&e.target.closest&&e.target.closest("input,textarea,select,a"))return;
    stopGlide();
    mdn=true; mx=e.clientX; my=e.clientY; mdist=0;
    wrap.classList.add("mgrab");
    e.preventDefault();                           // 文字の選択が始まらないようにする
  });
  window.addEventListener("mousemove",e=>{
    if(!mdn)return;
    const dx=e.clientX-mx, dy=e.clientY-my;
    mx=e.clientX; my=e.clientY; mdist+=Math.abs(dx)+Math.abs(dy);
    wrap.scrollLeft-=dx;
    window.scrollBy(0,-dy);
  });
  const mup=()=>{
    if(!mdn)return;
    mdn=false;
    wrap.classList.remove("mgrab");
    // 動かした後のクリックは捨てる(掴んで動かしただけで台番カードが開かないように)。
    // 指のパンと同じ panAt を使うので、抑制の仕組みは1つのまま。
    if(mdist>6) panAt=Date.now();
  };
  window.addEventListener("mouseup",mup);
  window.addEventListener("mouseleave",mup);
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
  paintTopStat();
}
// 上端の常時ステータス(2026-08-22新設・デザイン刷新)。
// 「いま何を見ているか」を画面から消さないための1行。中身は新しく作らず、
// **すでに画面にあるもの**(島図の中の対象期間の見出し・光っている期間チップ)を
// 読んで組み直すだけにしている(二重管理にしないため)。
// 島図の中の同じ見出しは visibility:hidden で隠す(要素は残す=盤面の大きさを変えない。
// 消してしまうと拡大率の計算とiOSのピンチの当たり方が変わる)。
// 長い節を開いているときだけ出す、固定の「閉じる」(2026-08-22・谷川氏指示)。
// 節の末尾の「↑ 閉じる」だけだと、特定日(768行)や日別一覧では下まで指で送らないと
// 閉じられない。画面より十分長い節を開いていて、かつその見出しが画面の上へ
// 流れているときだけ出す(短い節で出すと、ただ画面を塞ぐだけになる)。
function syncDocsFold(){
  const b=document.getElementById("docsFold"); if(!b) return;
  const host=document.getElementById("docsPanel");
  if(!host||host.hidden){ b.hidden=true; return; }
  const H=window.innerHeight||800;
  let target=null;
  host.querySelectorAll("details.dsec[open]").forEach(d=>{
    const r=d.getBoundingClientRect();
    if(r.height>H*1.2&&r.top<0&&r.bottom>H*0.4) target=d;
  });
  if(!target){ b.hidden=true; b.dataset.k=""; return; }
  const sm=target.querySelector("summary");
  const nm=String(sm?sm.textContent:"").trim().replace(/[（(].*$/,"").trim();
  b.dataset.k=target.dataset.k||"";
  b.textContent="✕ "+(nm||"この項目")+"を閉じる";
  b.hidden=false;
}
(function(){
  const b=document.getElementById("docsFold");
  if(b){
    b.addEventListener("click",()=>{
      const k=b.dataset.k||"";
      const d=k?document.querySelector('#docsPanel .dsec[data-k="'+k+'"]'):null;
      if(d){ d.open=false; d.scrollIntoView({block:"start"}); }
      b.hidden=true;
    });
  }
  // スクロールのたびに測り直す。連続で呼ばれるので次の描画に1回だけまとめる。
  let t=0;
  const go=()=>{ t=0; syncDocsFold(); };
  ["scroll","resize"].forEach(ev=>{
    window.addEventListener(ev,()=>{ if(!t) t=requestAnimationFrame(go); },
                            {passive:true});
  });
})();

// 特定日の検索(2026-08-22・谷川氏指示)。打った言葉は覚えておき、期間を切り替えて
// 資料を作り直しても残す(#flQ と同じ作法)。
let tokuQuery="";
function tkQApply(){
  const host=document.getElementById("docsPanel"); if(!host) return;
  const inp=document.getElementById("tkQ"); if(!inp) return;
  const q=String(tokuQuery||"").trim().toLowerCase();
  const x=document.getElementById("tkQx"); if(x) x.hidden=!q;
  let hit=0;
  // 特定日の表(1/1からの並び＋日付が決まっていない分)
  host.querySelectorAll(".dtoku tbody").forEach(tb=>{
    let head=null, headN=0;
    [...tb.rows].forEach(tr=>{
      if(tr.classList.contains("tk-m")){
        if(head) head.classList.toggle("tk-hide",headN===0);
        head=tr; headN=0; return;
      }
      if(tr.classList.contains("tk-w")) return;   // 由来の行は親に合わせて後で
      const t=(tr.textContent||"").toLowerCase();
      const on=!q||t.indexOf(q)>=0;
      tr.classList.toggle("tk-hide",!on);
      const w=tr.nextElementSibling;
      if(w&&w.classList.contains("tk-w")) w.classList.toggle("tk-hide",!on);
      if(on){ hit++; headN++; }
    });
    if(head) head.classList.toggle("tk-hide",headN===0);
  });
  // 東海のホールの年一・周年(同じ窓で一緒に絞る)
  host.querySelectorAll(".dhall tbody").forEach(tb=>{
    let head=null, headN=0;
    [...tb.rows].forEach(tr=>{
      if(tr.classList.contains("hl-m")){
        if(head) head.classList.toggle("tk-hide",headN===0);
        head=tr; headN=0; return;
      }
      const t=(tr.textContent||"").toLowerCase();
      const on=!q||t.indexOf(q)>=0;
      tr.classList.toggle("tk-hide",!on);
      if(on){ hit++; headN++; }
    });
    if(head) head.classList.toggle("tk-hide",headN===0);
  });
  const cn=document.getElementById("tkQn");
  if(cn) cn.textContent=q?(hit+"件"):"";
  const none=document.getElementById("tkQnone");
  if(none) none.hidden=!(q&&!hit);
}

// 資料の節を「近い分類」でまとめ直す(2026-08-22・谷川氏指示「資料内のセクションを
// 近い分類で並べていく」)。節は組み立ての都合で生まれた順に並んでいて、
//   説明書 → 日別一覧 → 機能 → 台入替 → 機種別出率 → 特定日 → …
// のように、読み方の話と店の数字の話とイベントの話が交互に出ていた。
// ★並べ替えは**作ったあとのDOMを動かすだけ**にする。組み立て側(600行ある条件分岐)を
//   触ると、どれか1つの節が出ない日に並びが崩れる。ここなら「在る節だけ」を並べ直せる。
// ★先頭の分類だけ見出しを出さない(2026-08-22・谷川氏指示「説明書は一番上」)。
//   見出しを置くと、いちばん上に来るのが「この画面の読み方」の文字になり、
//   説明書がひとつ下がって見える。
const DOCS_GROUPS=[
  {t:"この画面の読み方", k:["manual","func"], noHead:true},
  {t:"店の数字",         k:["rates","daily","osusume"]},
  {t:"店の予定とイベント", k:["iretae","toku","raiten","torizai","engsha","keihin"]},
  {t:"そのほか",         k:["log"]}
];
function docsRegroup(host){
  if(!host||!host.querySelector("details.dsec")) return;
  const secs={};
  host.querySelectorAll("details.dsec").forEach(d=>{ if(d.dataset.k) secs[d.dataset.k]=d; });
  const used=new Set(), frag=document.createDocumentFragment();
  DOCS_GROUPS.forEach(g=>{
    const list=g.k.filter(k=>secs[k]);
    if(!list.length) return;
    if(!g.noHead){
      const h=document.createElement("div");
      h.className="dgrp"; h.textContent=g.t;
      frag.appendChild(h);
    }
    list.forEach(k=>{ frag.appendChild(secs[k]); used.add(k); });
  });
  // 分類に入れ忘れた節があっても落とさない(節を新しく足したときの保険)
  host.querySelectorAll("details.dsec").forEach(d=>{
    if(!used.has(d.dataset.k)) frag.appendChild(d);
  });
  host.appendChild(frag);
}
function paintTopStat(){
  const el=document.getElementById("topStat"); if(!el) return;
  let range="";
  document.querySelectorAll('#board [data-k]').forEach(e=>{
    const t=(e.textContent||"").trim();
    // 「今日の午前中」を出しているときの見出しは「8/22(土)午前中 12:30時点 …」に
    // 差し替わる(対象期間で始まらない)。ここを見落とすと上端が空欄になる(2026-08-22)。
    const isTtl=/^(対象期間|対象日)/.test(t)||/^\d+\/\d+\(.\)午前中/.test(t);
    if(!range&&isTtl) range=t.replace(/\s+/g," ");
    if((isTtl||/^熱田.*島図/.test(t))
       &&!e.classList.contains("tc")){
      // ★ここで inline の style を触ってはいけない(2026-08-22)。期間を切り替えて
      //   戻したときに verify_shimaheat_url の「戻したセルの中身が初期状態と一致」が
      //   style.cssText を1文字ずつ比べており、visibility を書き込むと必ず落ちる。
      //   クラスだけを足せば cssText も innerHTML も元のまま保てる。
      e.classList.add("ts-dup");
    }
  });
  const on=document.querySelector(".pchip.is-on,.tbper .tbsbtn.is-on");
  // 「✕」は消すための印なので、上端の丸い札には出さない(2026-08-22)
  const nm=on?(on.textContent||"").trim().replace(/\s*✕\s*$/,""):"";
  // 左側は「日付だけ」に削る(2026-08-22・谷川氏報告「上部の対象期間の日付がみきれてる」)。
  // 期間の名前は右の丸い札に出ているので、左で繰り返すと肝心の日付が押し出されて切れる。
  //   対象期間：直近7日 8/15(土)〜8/21(金) → 8/15(土)〜8/21(金)
  //   対象日：単日 8/21(金)               → 8/21(金)
  //   8/22(土)午前中 12:30時点 ノーマル機230台 → 12:30時点 ノーマル機230台
  let d=range.replace(/^対象(期間|日)\s*[:：]\s*/,"");
  if(nm&&d.indexOf(nm)===0) d=d.slice(nm.length).trim();
  // 「水曜のみ」は日付が中黒で延々と並ぶ(6/10・6/17・…)。端から端と日数にまとめる。
  if(d.indexOf("・")>=0){
    const ps=d.split("・").map(x=>x.trim()).filter(Boolean);
    if(ps.length>=3){
      const last=ps[ps.length-1];
      // 元の見出しが末尾に「(11日)」を持っていることがある。あるなら日数は足さない
      d=ps[0]+"〜"+last+(/[（(]\s*\d+\s*日/.test(last)?"":" 全"+ps.length+"日");
    }
  }
  el.innerHTML='<span class="ts-n">熱田 島図</span>'
    +'<span class="ts-d">'+esc(d)+'</span>'
    +(nm?'<span class="ts-p">'+esc(nm)+'</span>':"");
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
// 特定日も同じところで先読みする(内容ハッシュ付きなので2回目以降は通信が起きない)。
(()=>{ const go=()=>{ tokuLoad(); return loadPeriods().catch(()=>{}); };
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
  if(curDays && !curNoGraph && document.getElementById("modal").style.display==="block"){
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
  // 出率の「午前中」が使える日かどうかを、開いたときに確かめる(2026-08-11)
  syncFRperHiru();
  ensureHiruData().then(syncFRperHiru);
});
document.getElementById("filterClose").addEventListener("click",()=>{ filterModal.style.display="none"; });
filterModal.addEventListener("click",e=>{ if(e.target.id==="filterModal") filterModal.style.display="none"; });
// 台ごとの集計値(直近7日合計・全期間トータル・3週間出率)を都度計算する。
// 全期間トータル=base(データ取得開始日〜3週間窓の前日までの累計)+3週間分の合計
// (2026-07-30の実装<3週間累積グラフのbase>と同じ考え方を流用)。
// 期間は2026-08-12からパネル全体で1つ(第2引数)。差枚・出率・稼働の4条件を同じ期間で出す。
// 2026-08-14: 曜日・特定日で日を狭めているときは m〜 の方を使う(狭めていなければ
// 中で従来の関数へ渡すので値は変わらない)。
function filterStats(dai,per){
  const m=DATA.machines[dai]; if(!m)return null;
  const w=mWork(dai,per);
  return {name:m.n, sum:mSum(dai,per), rate:mRate(dai,per),
          days:w.days, g:w.g, avg:w.avg, plus:w.plus};
}
// 稼働まわりの4つ(2026-08-12・谷川氏指示「総稼働日数・累計G数・1日平均G数・
// プラス率を足す」)。差枚と出率だけでは「よく回っている台か」「1日だけ跳ねた台か」が
// 分からなかった。
//   days(総稼働日数) … その期間で**その台の記録がある日**の数(差枚がnullでない日)
//   g(累計G数)       … その期間のG数の合計
//   avg(1日平均G数)  … g ÷ **G数が記録されている日数**。古い日はG数が無いので、
//                      そこを分母に混ぜると平均が実際より低く出る(母数を分けている)
//   plus(プラス率%)  … 差枚がプラスだった日 ÷ days(谷川氏の定義)
// 全期間(all)のときも**配列に入っている日ぶん**で数える(base=取得開始日〜配列の前日の
// 累計には日毎の内訳もG数も無いため。出率の全期間と同じ物差し)。
// 2026-08-12に pd(プラスだった日数)と gd(G数のある日数)も返すようにした。
// 機種全台をまとめるときに、%からは足し算ができないため(母数ごと合算する必要がある)。
function workStats(dai,per){
  const none={days:null,g:null,avg:null,plus:null,pd:null,gd:null};
  if(per==="hiru"){
    const D=window.HIRU&&window.HIRU.data;
    if(!D||!D.v) return none;
    const v=D.v[String(dai)], k=(D.k||{})[String(dai)];
    if(typeof v!=="number") return none;
    const g=(k&&k.g>0)?k.g:null;
    return {days:1, g:g, avg:g, plus:(v>0?100:0), pd:(v>0?1:0), gd:(g?1:0)};
  }
  const m=DATA.machines[dai]; if(!m) return none;
  const L=DATA.labels||[];
  let days=0,plus=0,g=0,gn=0;
  const add=x=>{
    if(!x) return;
    if(x[0]!=null){ days++; if(x[0]>0) plus++; }
    if(x[1]!=null&&x[1]>0){ g+=x[1]; gn++; }
  };
  if(per==="days") daysIdx().forEach(i=>add(m.d[i]));
  else if(per==="single") add(m.d[m.d.length-1]);
  else if(per==="wed") m.d.forEach((x,i)=>{ if(/\(水\)/.test(L[i]||"")) add(x); });
  else if(per==="fdow") m.d.forEach((x,i)=>{ if(inFdow(L[i])) add(x); });
  else if(per==="last7") m.d.slice(-WEEK).forEach(add);
  else if(per==="all") m.d.forEach(add);
  else m.d.slice(-NDAYS).forEach(add);      // nd21=3週間
  if(!days) return none;
  return {days:days, g:gn?g:null, avg:gn?Math.round(g/gn):null,
          plus:Math.round(plus*1000/days)/10, pd:plus, gd:gn};
}
// その機種の**全台をまとめた**値(2026-08-12・カードの詳細で「台 / 機種全台」を
// 並べるため)。%は足せないので、母数(日数・G数)ごと合算してから割り直す。
function machineAgg(nm,per){
  const o={n:0, v:null, g:0, days:0, pd:0, gd:0};
  let v=0, has=false;
  Object.keys(DATA.machines||{}).forEach(d=>{
    const m=DATA.machines[d];
    if(!m||m.n!==nm) return;
    o.n++;
    const s=sumForDai(d,per), w=workStats(d,per);
    if(typeof s==="number"){ v+=s; has=true; }
    if(w.g) o.g+=w.g;
    if(w.days){ o.days+=w.days; o.pd+=(w.pd||0); o.gd+=(w.gd||0); }
  });
  o.v=has?v:null;
  o.avg=o.gd?Math.round(o.g/o.gd):null;
  o.plus=o.days?(Math.round(o.pd*1000/o.days)/10):null;
  o.rate=(o.g>0&&typeof o.v==="number")?rate(o.v,o.g):null;
  return o;
}
// 期間 → DATA.labels の何番目を見るか(workStats の日の選び方とそろえる)。
// 内容詳細が回数を足す日を決めるのに使う。ここがずれると差枚(島図)と回数(蓄積)で
// 数える日が食い違い、ブドウの逆算だけが実際と違う値になる。
function perIdxList(per){
  const L=DATA.labels||[], n=L.length, out=[];
  if(per==="days") return daysIdx().slice();
  if(per==="single") return n?[n-1]:[];
  if(per==="wed"){ L.forEach((s,i)=>{ if(/\(水\)/.test(s||"")) out.push(i); }); return out; }
  if(per==="fdow"){ L.forEach((s,i)=>{ if(inFdow(s)) out.push(i); }); return out; }
  let from=0;
  if(per==="last7") from=Math.max(0,n-WEEK);
  else if(per!=="all") from=Math.max(0,n-NDAYS);      // nd21=3週間
  for(let i=from;i<n;i++) out.push(i);
  return out;
}
// 台1つぶんの回数をその期間で足す(2026-08-13)。**島図に記録のある日だけ**数える。
// 入替で中身が変わった台は前の機種ぶんを空にしてあるので、そこを足すと別機種の
// 回数が混ざる。差枚と同じ日を数えることで、ブドウの逆算も食い違わない。
function koySum(dai,per){
  if(!KOYAKU||!KOYAKU.d) return null;
  const rec=KOYAKU.d[String(dai)]; if(!rec) return null;
  const m=DATA.machines[dai]; if(!m) return null;
  const L=DATA.labels||[];
  let g=0,bb=0,rb=0,days=0;
  perIdxList(per).forEach(i=>{
    const x=m.d[i]; if(!x||x[0]==null) return;         // 島図に記録が無い日は飛ばす
    const k=rec[String(L[i]||"").split("(")[0]]; if(!k) return;
    if(k[0]!=null) g+=k[0];
    if(k[1]!=null) bb+=k[1];
    if(k[2]!=null) rb+=k[2];
    days++;
  });
  return days?{g:g,bb:bb,rb:rb,days:days}:null;
}
// 同じ機種の全台ぶん(内容詳細の右の列)。%は足せないので回数のまま足してから割る。
function koyMachineSum(nm,per){
  if(!KOYAKU||!KOYAKU.d||!nm) return null;
  let g=0,bb=0,rb=0,n=0,v=0,hasV=false,days=0;
  Object.keys(DATA.machines||{}).forEach(d=>{
    const m=DATA.machines[d]; if(!m||m.n!==nm) return;
    const s=koySum(d,per); if(!s) return;
    g+=s.g; bb+=s.bb; rb+=s.rb; n++; days+=s.days;
    const sv=sumForDai(d,per);
    if(typeof sv==="number"){ v+=sv; hasV=true; }
  });
  return n?{g:g,bb:bb,rb:rb,n:n,days:days,v:hasV?v:null}:null;
}
// 内容詳細の中身(2026-08-13)。午前中の表と**同じ並び・同じ丸め**で作る。
// 設定別の台帳が無い機種(BT機・技術介入機)は推定設定の欄を空にして、
// 回数と確率だけを出す(回数はあるので確率までは出せる)。
function koyHtml(dai,per){
  const m=DATA.machines[dai], nm=m?m.n:null;
  const A0=koySum(dai,per), B0=koyMachineSum(nm,per);
  if(!A0&&!B0) return null;
  const st=((KOYAKU&&KOYAKU.st)||{})[nm]||null;
  const ky=st&&st.koyaku;
  const MARU="①②③④⑤⑥⑦⑧⑨";
  const sBB=st?hDen(st.bb):null, sRB=st?hDen(st.rb):null;
  const sGT=(sBB&&sRB)?sBB.map((b,i)=>{ const r=sRB[i];
    return (b>0&&r>0)?(1/(1/b+1/r)):null; }):null;
  const sKO=ky?hDen(ky.settei):null;
  const A=A0?hCalcRow(A0,sumForDai(dai,per),ky):null;
  const B=B0?hCalcRow(B0,B0.v,ky):null;
  if(A){ A.kitai=hKitai(A,st,sBB,sRB,sKO); A.days=A0.days; A.n=1; }
  if(B){ B.kitai=hKitai(B,st,sBB,sRB,sKO); B.days=B0.days; B.n=B0.n; }
  const num=v=>(typeof v==="number")?v.toLocaleString():"−";
  const sgn=v=>(typeof v!=="number")?"−":((v>0?"+":"")+v.toLocaleString());
  const c3=(n,body,se)=>"<td>"+n+'</td><td class="hc">'+body+'</td><td class="hs">'
    +(se==null?"":'<span class="hb">'+se.toFixed(1)+"</span>")+"</td>";
  const cell=(o,kind)=>{
    if(!o) return c3("−","","");
    if(kind==="g") return c3(num(o.g),"",null);
    if(kind==="v"){
      const rr=rate(o.v,o.g);
      return '<td class="'+(o.v>0?"plus":(o.v<0?"minus":""))+'">'+sgn(o.v)
        +'</td><td class="hc">'+(rr!=null?(rr.toFixed(1)+"%"):"")+'</td><td class="hs"></td>';
    }
    if(kind==="bb") return c3(num(o.bb),o.bbD?("1/"+Math.round(o.bbD)):"−",
      hNearF(o.bbD,sBB));
    if(kind==="rb") return c3(num(o.rb),o.rbD?("1/"+Math.round(o.rbD)):"−",
      hNearF(o.rbD,sRB));
    if(kind==="gt") return c3((o.bb!=null&&o.rb!=null)?num((o.bb||0)+(o.rb||0)):"−",
      o.gtD?("1/"+Math.round(o.gtD)):"−",hNearF(o.gtD,sGT));
    if(kind==="kitai") return '<td></td><td class="hc"></td><td class="hs">'
      +(o.kitai?('<span class="hb">'+o.kitai.toFixed(1)+"</span>"):"")+"</td>";
    // 対象日数(2026-08-13)。台は「◯日」、全台は「◯台日」(延べ)。
    // ここが上の集計詳細と違っていたら、蓄積の取れなかった日がある印。
    // **内容の欄には何も入れない**=何台ぶんかは見出しの「全台（45台）」で分かるし、
    // 1行増えたぶん幅320pxで7pxはみ出したため(2026-08-13実測)。
    if(kind==="days") return c3(o.days==null?"−":(num(o.days)+(o.n>1?"台日":"日")),
      "",null);
    if(kind&&kind.indexOf("ko:")===0){
      const lv=kind.slice(3), d=(o.ko||{})[lv], c=(o.koN||{})[lv];
      return c3(c?Math.round(c).toLocaleString():"−",
                d?("1/"+d.toFixed(2)):"−",hNearF(d,sKO));
    }
    return c3("−","",null);
  };
  const c2=(B0&&B0.n)?("全台（"+B0.n+"台）"):"全台";
  // 対象日数を見出しに出す(2026-08-13・谷川氏指摘「集計と内容のG数が異なる」)。
  // 集計詳細(島図)と内容詳細(蓄積)は**数えている日が違うことがある**ので、
  // 何日ぶんを足した数字なのかを書いておかないと、上の表と突き合わせたときに
  // 理由の分からない差になる。実測の食い違いは次の2つ:
  //   ・蓄積の取れなかった日(6/22はノーマル機がほぼ全滅・7/24はアイム32台)
  //   ・島図にG数が無い日(6/9〜6/12。差枚はあるがG数を取り始める前)
  let h='<div class="hh">'+esc(perName(per))+"の内容（回数は毎晩の蓄積より"
    +(A0?("／この台は"+A0.days+"日ぶん"):"")+"）</div>"
    +'<div class="htbl"><table>'
    +'<tr class="h1"><th></th><th colspan="3">台'+dai+'</th>'
    +'<th colspan="3">'+c2+"</th></tr>"
    +'<tr class="h2"><th></th><th>回数</th><th>内容</th><th>推定設定</th>'
    +"<th>回数</th><th>内容</th><th>推定設定</th></tr>";
  const rows=[["期待設定","kitai"],["対象日数","days"],["G数","g"],["差枚","v"],
              ["BB","bb"],["RB","rb"],["合成","gt"]];
  if(ky) (ky.show||[]).forEach(lv=>rows.push([ky.kind+"<br><span class='hp'>"
    +lv+"</span>","ko:"+lv]));
  rows.forEach(r=>{ h+="<tr><th>"+r[0]+"</th>"+cell(A,r[1])+cell(B,r[1])+"</tr>"; });
  h+="</table></div>";
  if(A&&A.pct&&st&&st.labels){
    const pr=(o,lb)=>{
      if(!o||!o.pct) return "";
      return "<tr><th>"+lb+"</th>"+o.pct.map(x=>"<td>"+x.toFixed(1)+"%</td>").join("")
        +"<td>"+(o.kitai?o.kitai.toFixed(1):"−")+"</td></tr>";
    };
    const th=st.labels.map(x=>"<th>"+(/^[1-9]$/.test(String(x))
      ?MARU[parseInt(x,10)-1]:x)+"</th>").join("");
    h+='<details class="hdet"><summary>設定ごとの期待度</summary><div class="hset">'
      +"<table><tr><th></th>"+th+"<th>期待</th></tr>"
      +pr(A,"台"+dai)+pr(B,"機種計")+"</table>"
      +'<div class="est">各設定の起こりやすさ（BB・RB・'+(ky?ky.kind:"小役")
      +"を二項分布で見た確からしさの積）</div></div></details>";
  }
  const nonNum=(st&&st.labels)
    ? st.labels.map((lb,i)=>/^[1-9]$/.test(String(lb))?null:((i+1)+"＝"+lb)).filter(Boolean)
    : [];
  h+='<div class="est">'
    +(st?"推定設定＝いちばん近い設定（目安。段の間はその割合で小数）"
        +(nonNum.length?"。"+nonNum.join("・"):"")
      :"この機種は設定別の台帳が無いので、回数と確率だけを出しています")
    +(ky?"／"+ky.kind+"は逆算の推定。前任者の目押しで変わるので幅で出しています":"")
    +"。日をまたいで足した回数なので、途中で設定が変わっていれば混ざります"
    +"。上の集計詳細と日数やG数が違うことがあります（回数は毎晩の蓄積、集計は島図の"
    +"取得と出どころが別で、取れなかった日がそれぞれにあるため）"
    +"</div>";
  if(st&&st.labels&&st.bb){
    const th=st.labels.map(x=>"<th>"+(/^[1-9]$/.test(String(x))
      ?MARU[parseInt(x,10)-1]:x)+"</th>").join("");
    const row=(name,list,fx)=>{
      if(!list||!list.length) return "";
      return "<tr><th>"+name+"</th>"+st.labels.map((_,i)=>"<td>"
        +(list[i]>0?("1/"+list[i].toFixed(fx)):"−")+"</td>").join("")+"</tr>";
    };
    h+='<details class="hdet"><summary>設定別の一覧</summary>'
      +'<div class="hset"><table><tr><th>設定</th>'+th+"</tr>"
      +row("BB",sBB,1)+row("RB",sRB,1)+row("合成",sGT,1)
      +(ky?row(ky.kind,sKO,2):"")+"</table>"
      +(st.note?'<div class="est">'+st.note+"</div>":"")+"</div></details>";
  }
  return h;
}
// 台番カードの「詳細」(2026-08-12・谷川氏指示「午前中以外の5期間でも午前中の時と
// 同じように詳細なデータが、総G数の下に平均G数を追加した形で見られるように。
// 台番を開いた時は折り畳まれていて、詳細ボタンを押したら見られる形に」)。
// ここは差枚・G数・稼働の**集計**を、午前中と同じ「台 / 機種全台」の並びで見せる。
// 畳んだ状態で描くので、開くまで縦に伸びない。
// 2026-08-13に名前を「詳細」→「集計詳細」に変え、その下に「内容詳細」を足した
// (谷川氏指示「午前中と同じようにそれぞれ他5期間も見れるようにする。内容詳細ボタンを
//  作る。既にある詳細は集計詳細に名称変更」)。内容詳細は BB・RB の回数が要るが、
// 島図のデータは1日ぶんが[差枚, G数]の2つしか持っていない。回数は毎晩の蓄積Excelに
// あるので、それを koyaku.<hash>.json 経由で受け取って足す(koySum / koyHtml)。
// **回数があるのは15機種だけ**(ジャグハナ7・BT機5・技術介入機3)。AT機は元データに
// 回数が無いので、内容詳細そのものを出さない。
// 「詳細」を開いたままにしておくかどうか(2026-08-12・谷川氏指示「詳細開いた状態で
// 期間切り替えたときに詳細開きっぱなしで詳細も切り替わるように」)。
// 表は期間ごとに作り直すので、覚えておかないと切り替えるたびに畳まれてしまう。
// **台が変わったら畳む**(別の台を開いた時は畳まれている、が元の約束)。
let detOpen=false, detDai=null, koyOpen=false;
function paintDetail(dai){
  const el=document.getElementById("mhiru"); if(!el) return;
  if(String(dai)!==String(detDai)){ detOpen=false; koyOpen=false; detDai=String(dai); }
  const m=DATA.machines[dai];
  const per=winPer(typeof curWin!=="undefined"?curWin:NDAYS);
  if(!m||!per){ el.hidden=true; el.innerHTML=""; return; }
  const A=workStats(dai,per), sv=sumForDai(dai,per), sr=rateForDai(dai,per);
  if(A.days==null){ el.hidden=true; el.innerHTML=""; return; }
  const B=machineAgg(m.n,per);
  const num=v=>(typeof v==="number")?v.toLocaleString():"−";
  const sgn=v=>(typeof v!=="number")?"−":((v>0?"+":"")+v.toLocaleString());
  const pct=v=>(typeof v==="number")?(v.toFixed(1)+"%"):"−";
  const vc=v=>(typeof v!=="number")?"":(v>0?" class=\"plus\"":(v<0?" class=\"minus\"":""));
  const rows=[
    ["G数", num(A.g), num(B.g)],
    // 総G数の下に1日平均G数(谷川氏指示)。**G数のある日で割る**(古い日はG数が無く、
    // そこを分母に混ぜると平均が実際より低く出る)
    ["1日平均G数", num(A.avg), num(B.avg)],
    ["差枚", "<span"+vc(sv)+">"+sgn(sv)+"</span>", "<span"+vc(B.v)+">"+sgn(B.v)+"</span>"],
    ["出率", pct(sr), pct(B.rate)],
    ["総稼働日数", (A.days!=null?A.days+"日":"−"), (B.days?B.days+"日":"−")],
    ["プラス率", pct(A.plus), pct(B.plus)],
  ];
  let h='<details class="hdet mdet"><summary>集計詳細（'+esc(perName(per))+"）</summary>"
    +'<div class="hh">'+esc(perName(per))+"の集計（この台と機種全台）</div>"
    +'<div class="htbl"><table>'
    +'<tr class="h1"><th></th><th>台'+esc(dai)+"</th><th>"
    +(B.n?("全台（"+B.n+"台）"):"全台")+"</th></tr>"
    +rows.map(r=>"<tr><th>"+r[0]+"</th><td>"+r[1]+"</td><td>"+r[2]+"</td></tr>").join("")
    +"</table></div>"
    +'<div class="est">プラス率＝差枚がプラスだった日 ÷ 総稼働日数。'
    +"1日平均G数はG数の記録がある日で割っています。"
    +"</div></details>";
  // 内容詳細(2026-08-13)。回数の入った外部ファイルは**開くまで落とさない**ので、
  // まだ手元に無いときは畳んだ枠だけ出しておき、開かれた時に取りに行って描き直す。
  // 取れた結果その台の回数が無ければ(AT機など)、枠ごと消す。
  const kh=KOYAKU?koyHtml(dai,per):null;
  const koyMaybe=!KOYAKU&&SHIMA&&SHIMA.koyakuUrl;
  if(kh||koyMaybe){
    h+='<details class="hdet kdet"><summary>内容詳細（'+esc(perName(per))+"）</summary>"
      +(kh||'<div class="est">読み込み中…</div>')+"</details>";
  }
  el.innerHTML=h;
  el.hidden=false;
  // 開いたままにしておく(期間を切り替えても畳まれない)。開閉のたびに覚え直す。
  const d=el.querySelector("details.mdet");
  if(d){
    d.open=detOpen;
    d.addEventListener("toggle",()=>{ detOpen=d.open; if(d.open) fitHiru(); });
  }
  fitHiru();          // 表を横スクロールさせずに収める(集計詳細・内容詳細の両方)
  const kd=el.querySelector("details.kdet");
  if(kd){
    kd.open=koyOpen;
    kd.addEventListener("toggle",()=>{
      koyOpen=kd.open;
      // 畳んでいる間は幅が0で測れないので、開かれた時にもう一度収める
      if(kd.open) fitHiru();
      // 初めて開いた時だけ取りに行く(koyLoad が二重取得を防ぐ)。
      // 届いたら同じ台・同じ期間のままなら描き直す。
      if(kd.open&&!KOYAKU) koyLoad().then(()=>{
        if(String(dai)===String(detDai)) paintDetail(dai);
      });
    });
    if(kd.open&&!KOYAKU) koyLoad().then(()=>{
      if(String(dai)===String(detDai)) paintDetail(dai);
    });
  }
}
// カードのグラフ期間(.mchip の data-w) → 集計の期間キー。perWin の逆。
function winPer(w){
  // 曜日(2026-08-14)。これを返さないと集計詳細・内容詳細が出ない
  // (谷川氏指示「曜日絞り込みしたときも集計詳細と内容詳細がみられるように」)。
  if(w===-2) return FDOW.length?"fdow":null;
  if(w===-1) return "wed";
  if(w===0) return "all";
  if(w===1) return "single";
  if(w===WEEK) return "last7";
  if(w===NDAYS) return "nd21";
  return null;
}
function perName(p){
  // 曜日(2026-08-14)は選んだ曜日で名前が変わるので先に返す(例「火木のみ」)。
  if(p==="fdow") return FDOW.length?(FDOW.join("")+"のみ"):"";
  return {hiru:"今日の午前中", single:singleLabel(), wed:"水曜のみ",
          last7:"直近7日", nd21:"3週間", all:"全期間",
          days:"選んだ日"}[p]||"";
}
// 差枚をどの期間で見るか(2026-08-11・谷川氏指示「差枚1つにまとめて、出率と同じ
// 6期間から選ぶ形にする」)。それまでは「直近7日 差枚合計」と「全期間 トータル差枚」の
// 2つに固定されていた。**全期間だけは base(取得開始日〜配列の前日までの累計)を足す**
// =それまでの「全期間 トータル差枚」と同じ値になる。
// 日付を選ぶ(2026-08-12・谷川氏指示「年月日付指定(複数日選択可)」)。
// 選んだ日の**並び順の位置**(DATA.labels の添字)を持つ。日付そのものではなく位置で
// 持つのは、集計がどれも m.d の添字を辿る作りだから。
const fDays=new Set();
// その期間で見る日の添字。**"days" のときだけ**選んだ日を返す(他は従来どおり
// それぞれの関数が自分で切り出す)。
function daysIdx(){
  const N=(DATA.labels||[]).length;
  return [...fDays].filter(i=>i>=0&&i<N).sort((a,b)=>a-b);
}
function sumForDai(dai,per){
  if(per==="days"){
    const m=DATA.machines[dai]; if(!m) return null;
    let s=0,n=0;
    daysIdx().forEach(i=>{ const x=m.d[i]; if(x&&x[0]!=null){ s+=x[0]; n++; } });
    return n?s:null;
  }
  if(per==="hiru"){
    const D=window.HIRU&&window.HIRU.data;
    if(!D||!D.v) return null;
    const v=D.v[String(dai)];
    return (typeof v==="number")?v:null;
  }
  const m=DATA.machines[dai]; if(!m) return null;
  const L=DATA.labels||[];
  let s=0,n=0;
  const add=x=>{ if(x&&x[0]!=null){ s+=x[0]; n++; } };
  if(per==="all"){ m.d.forEach(add); return (m.b||0)+s; }
  if(per==="single") add(m.d[m.d.length-1]);
  else if(per==="wed") m.d.forEach((x,i)=>{ if(/\(水\)/.test(L[i]||"")) add(x); });
  else if(per==="fdow") m.d.forEach((x,i)=>{ if(inFdow(L[i])) add(x); });
  else if(per==="nd21") m.d.slice(-NDAYS).forEach(add);
  else m.d.slice(-WEEK).forEach(add);        // last7=直近7日(既定)
  return n?s:null;
}
// いま選んでいる期間(2026-08-12からパネル全体で1つ)。何も選ばれていなければ
// 直近7日(いちばんよく使う)。それまでは差枚=vperNow / 出率=rperNow と別々だった。
// 2026-08-14: 未選択のときは空文字を返す(それまでは直近7日を返していた)。
// 呼ぶ側は #fApply の頭で弾いているので、空のまま集計へ流れることはない。
function perNow(){
  const b=document.querySelector("#fPer .ch.on");
  return b?b.dataset.v:"";
}
// いま選んでいる期間の**ボタンの文字そのまま**(言い換えを増やさない)。
// 日付を選んでいるときだけは、何日選んだのかが分からないと結果を読み違えるので添える。
function perLabel(){
  const b=document.querySelector("#fPer .ch.on");
  const t=b?(b.textContent||"").trim():"直近7日間";
  return (b&&b.dataset.v==="days")?(t+"（"+fDays.size+"日）"):t;
}
// カレンダー(2026-08-12・谷川氏指示「カレンダー形式でデータがある日付だけ明るく
// 表示して選択可能に」)。月ごとに日〜土の7列で組み、**データのある日だけ押せる**。
// 年月日は生成側が入れた SHIMA.ymd(「2026-08-11」の並び)を使う
// (画面のラベル「8/11(火)」には年が入っていないため)。
function buildCal(){
  const box=document.getElementById("fCal"); if(!box) return;
  const ymd=(typeof SHIMA!=="undefined"&&SHIMA.ymd)||[];
  const L=DATA.labels||[];
  if(!ymd.length){ box.innerHTML='<div class="fc-none">日付のデータがありません</div>'; return; }
  // 「2026-08」→ その月にある {日: 添字}
  const months={};
  ymd.forEach((s,i)=>{
    if(!s) return;
    const p=s.split("-");
    const key=p[0]+"-"+p[1];
    (months[key]=months[key]||{})[parseInt(p[2],10)]=i;
  });
  const WD=["日","月","火","水","木","金","土"];
  let h='<div class="fc-h"><span id="fCalN">選んだ日: '+fDays.size+"日</span>"
    +'<span class="fc-b"><button type="button" id="fCalAll">全部選ぶ</button>'
    +'<button type="button" id="fCalNone">全部外す</button></span></div>';
  Object.keys(months).sort().forEach(key=>{
    const p=key.split("-"), y=+p[0], mo=+p[1];
    const first=new Date(y,mo-1,1), last=new Date(y,mo,0).getDate();
    h+='<div class="fc-m"><div class="fc-mn">'+y+"年"+mo+"月</div><div class=\"fc-g\">"
      +WD.map((w,i)=>'<div class="fc-w'+(i===0?" fc-sun":(i===6?" fc-sat":""))+'">'
                     +w+"</div>").join("");
    for(let i=0;i<first.getDay();i++) h+='<div class="fc-e"></div>';
    for(let d=1;d<=last;d++){
      const idx=months[key][d];
      if(idx==null){ h+='<div class="fc-d fc-off">'+d+"</div>"; continue; }
      h+='<button type="button" class="fc-d fc-on'+(fDays.has(idx)?" is-on":"")
        +'" data-i="'+idx+'" aria-label="'+esc(L[idx]||"")+'"'
        +(fDays.has(idx)?' aria-pressed="true"':"")+">"+d+"</button>";
    }
    h+="</div></div>";
  });
  box.innerHTML=h;
}
// カレンダーの出し入れ。「日付を選ぶ」を選んでいる間だけ見せる。
function syncCal(){
  const box=document.getElementById("fCal"); if(!box) return;
  const on=(perNow()==="days");
  if(on&&!box.innerHTML) buildCal();
  box.hidden=!on;
}
(function(){
  const box=document.getElementById("fCal");
  if(!box) return;
  box.addEventListener("click",e=>{
    const t=e.target;
    if(t&&t.id==="fCalAll"){
      ((typeof SHIMA!=="undefined"&&SHIMA.ymd)||[]).forEach((s,i)=>{ if(s) fDays.add(i); });
      buildCal(); return;
    }
    if(t&&t.id==="fCalNone"){ fDays.clear(); buildCal(); return; }
    const b=t&&t.closest?t.closest(".fc-d.fc-on"):null;
    if(!b) return;
    const i=parseInt(b.dataset.i,10);
    if(fDays.has(i)) fDays.delete(i); else fDays.add(i);
    b.classList.toggle("is-on",fDays.has(i));
    b.setAttribute("aria-pressed",fDays.has(i)?"true":"false");
    const n=document.getElementById("fCalN");
    if(n) n.textContent="選んだ日: "+fDays.size+"日";
  });
})();
// 出率をどの期間で見るか(2026-08-11・谷川氏指示「午前中、単日(前日)、水曜のみ、
// 直近7日間、3週間、全期間のボタンを作る」)。それまでは3週間に固定だった。
// 「午前中」だけは島図のデータではなく hiru.json(その日の12:30時点)から出す。
// 全期間は**配列に入っている日ぶん**で計算する(baseの差枚にはG数が無いため。
// 差枚のトータルとは母数が違うので、そこだけ物差しが異なる)。
function rateForDai(dai,per){
  if(per==="days"){
    const m=DATA.machines[dai]; if(!m) return null;
    let s=0,g=0;
    daysIdx().forEach(i=>{ const x=m.d[i];
      if(x){ if(x[0]!=null)s+=x[0]; if(x[1]!=null)g+=x[1]; } });
    return g>0?rate(s,g):null;
  }
  if(per==="hiru"){
    const D=window.HIRU&&window.HIRU.data;
    if(!D||!D.k) return null;
    const k=D.k[String(dai)], v=(D.v||{})[String(dai)];
    if(!k||!(k.g>0)||typeof v!=="number") return null;
    return rate(v,k.g);
  }
  const m=DATA.machines[dai]; if(!m) return null;
  const L=DATA.labels||[];
  let s=0,g=0;
  const add=x=>{ if(x){ if(x[0]!=null)s+=x[0]; if(x[1]!=null)g+=x[1]; } };
  if(per==="single") add(m.d[m.d.length-1]);
  else if(per==="wed") m.d.forEach((x,i)=>{ if(/\(水\)/.test(L[i]||"")) add(x); });
  else if(per==="fdow") m.d.forEach((x,i)=>{ if(inFdow(L[i])) add(x); });
  else if(per==="last7") m.d.slice(-WEEK).forEach(add);
  else if(per==="all") m.d.forEach(add);
  else m.d.slice(-NDAYS).forEach(add);      // nd21=3週間(既定)
  return g>0?rate(s,g):null;
}
// 数値の入力欄はまとめて持つ(2026-08-12に6欄→14欄へ増えたため。クリアと
// よく使う条件の両方が同じ並びを使う=片方に足し忘れて値が残る事故を防ぐ)。
// 2026-08-14: 「選んだ日の差枚合計」(fDmin/fDmax)は廃止。上の「差枚」と重複するため
// (谷川氏指示)。曜日・特定日はその差枚の"数える日"を狭める指定へ格上げした。
const FNUM=["fVmin","fVmax","fRmin","fRmax","fNmin","fNmax","fGmin","fGmax",
            "fAmin","fAmax","fPmin","fPmax",
            // 設定の推定(2026-08-13)。BB・RB・ブドウそれぞれの推定設定の範囲
            // (BBは2026-08-21に追加。fBmin/fBmax は**RB**の欄=名前は当時のまま)
            "fBBmin","fBBmax","fBmin","fBmax","fKmin","fKmax"];
// その台に回数(BB・RB)の記録があるか=「ノーマル機種限定」の判定。
function hasKoyaku(dai){
  return !!(KOYAKU&&KOYAKU.d&&KOYAKU.d[String(dai)]);
}
// 絞り込み用に、その台のその期間の推定設定を出す(2026-08-13・谷川氏指示
// 「推定設定①〜⑥／RB 1.0〜6.0／ブドウ・ベル 1.0〜6.0」)。
// 台番カードの内容詳細と**同じ計算**を使う(hCalcRow / hKitai / hNearF)ので、
// 絞り込んだ台を開けば同じ数字が出る。ここで別式を書くと必ず食い違う。
//   kitai … BB・RB・ブドウをまとめた期待設定
//   rb    … RB確率だけで見た推定設定
//   ko    … ブドウ／ベルの逆算で見た推定設定(チェリー狙い。hKitai と同じ物差し)
// 午前中だけは蓄積ではなく昼スナップの回数を使う(その日ぶんはまだ蓄積に入らない)。
function setteiOf(dai,per){
  const m=DATA.machines[dai]; if(!m) return null;
  const nm=m.n;
  let k=null, v=null, st=null;
  if(per==="hiru"){
    const D=window.HIRU&&window.HIRU.data;
    if(!D||!D.k) return null;
    k=D.k[String(dai)]; v=(D.v||{})[String(dai)];
    st=(D.st||{})[nm]||null;
  }else{
    if(!KOYAKU) return null;
    k=koySum(dai,per); v=sumForDai(dai,per);
    st=((KOYAKU.st)||{})[nm]||null;
  }
  if(!k||!(k.g>0)||!st) return null;
  const ky=st.koyaku;
  const sBB=hDen(st.bb), sRB=hDen(st.rb), sKO=ky?hDen(ky.settei):null;
  const o=hCalcRow(k,v,ky);
  if(!o) return null;
  const kitai=hKitai(o,st,sBB,sRB,sKO);
  // ブドウ／ベルは目押しの前提で値が変わるので、選ばれている方を使う
  // (2026-08-13・谷川氏指示「適当とチェリー狙いを選べるボタンをつけて」)。
  // 既定はチェリー狙い＝hKitai(期待設定)が使っているのと同じ物差し。
  // その機種にその前提が無いときは、持っている方の先頭で代用する。
  const lv=koLevel();
  const kod=o.ko?((o.ko[lv]!=null)?o.ko[lv]:o.ko[Object.keys(o.ko)[0]]):null;
  // bb は2026-08-21に追加(rb とまったく同じ作り。見る確率が違うだけ)
  return {kitai:kitai, bb:hNearF(o.bbD,sBB), rb:hNearF(o.rbD,sRB),
          ko:hNearF(kod,sKO), lv:lv};
}
// いま選ばれている目押しの前提。どちらか一方が必ず選ばれている作りだが、
// 万一どちらも外れていたら既定へ倒す(0台になって理由が分からないのを避ける)。
function koLevel(){
  const b=document.querySelector("#fKlv .ch.on");
  return (b&&b.dataset.v)||"チェリー狙い";
}
function parseNum(id){ const el=document.getElementById(id);
  const v=el?el.value:""; return v===""?null:parseFloat(v); }
// 押して選ぶ条件(2026-08-04・谷川氏指示「絞り込みに末尾、位置区分、曜日、ゾロ目の日も」)。
// もう一度押すと外れる。何も選ばなければ条件にならない(空欄と同じ扱い)。
// 押して選ぶ条件は**まとまりごとに委譲**で受ける(2026-08-11)。位置区分と特定日は
// データから作る=あとから足されるので、1つずつ addEventListener すると付け漏れる。
// fSet(推定設定①〜⑥)もここに入れる=**複数選べる**(2026-08-13・谷川氏指示)。
// もう一度押すと外れ、選んだ段のどれかに当たれば残る(OR)。
["fSue","fPos","fDow","fToku","fSet","fNer"].forEach(id=>{
  const box=document.getElementById(id);
  if(!box) return;
  box.addEventListener("click",e=>{
    const b=e.target&&e.target.closest?e.target.closest(".ch"):null;
    if(b&&box.contains(b)&&!b.disabled) b.classList.toggle("on");
  });
});
// 目押しの前提だけは**どちらか一方**(2026-08-13)。上の群と違って外せない=
// 両方外れると「ブドウ・ベルの条件が何を指すか」が決まらなくなるため。
(()=>{
  const box=document.getElementById("fKlv");
  if(!box) return;
  box.addEventListener("click",e=>{
    const b=e.target&&e.target.closest?e.target.closest(".ch"):null;
    if(!b||!box.contains(b)||b.disabled) return;
    box.querySelectorAll(".ch").forEach(x=>x.classList.toggle("on",x===b));
  });
})();
// 位置区分のボタンは島図のデータから作る(2026-08-11・谷川氏指示「全部の位置区分
// ボタンだす」)。それまでは外角/外側/中央/内側/内角の5つにまとめており、
// 「外角3だけ見たい」ができなかった。入替で区分が増減しても追従する。
// 並びは島の外から内へ(外角→外角2..→中央外→中央→中央内→内角2..→内角)。
(()=>{
  const box=document.getElementById("fPos");
  if(!box||typeof DATA==="undefined") return;
  const set=new Set();
  Object.keys(DATA.machines||{}).forEach(d=>{
    const p=(DATA.machines[d]||{}).p; if(p) set.add(p);
  });
  const ord=p=>{
    const m=/^(外角|中央外|中央内|内角|中央)(\d*)$/.exec(p)||[];
    const g={"外角":0,"中央外":1,"中央":2,"中央内":3,"内角":4}[m[1]];
    return [(g==null?9:g), m[2]?parseInt(m[2],10):1];
  };
  const list=[...set].sort((a,b)=>{
    const A=ord(a), B=ord(b);
    return A[0]-B[0]||A[1]-B[1]||(a<b?-1:1);
  });
  // 角台だけは一目で分かるように添える(いちばんよく使う区分のため)
  const lbl=p=>(p==="外角"||p==="内角")?(p+"(角)"):p;
  box.innerHTML=list.map(p=>'<button class="ch" data-v="'+p+'">'+lbl(p)+"</button>").join("");
})();
// 特定日のボタン(2026-08-11・谷川氏指示「特定日という項目追加。ゾロ目をここに移動、
// 店毎の特定日を入れる」)。中身は資料と同じ台帳(tokutei_calendar.json)から、
// **この店が対象のものだけ**を生成側が抜き出して SHIMA.ftoku へ入れている
// (SHIMA.toku は資料の特定日762件のほうなので混ぜない)。
(()=>{
  const box=document.getElementById("fToku");
  if(!box) return;
  const list=[{k:"zoro",n:"ゾロ目の日"}].concat(
    ((typeof SHIMA!=="undefined"&&SHIMA.ftoku)||[]).map(t=>({k:t.k,n:t.n})));
  box.innerHTML=list.map(t=>'<button class="ch" data-v="'+t.k+'">'+t.n+"</button>").join("");
})();
// 期間は**1つだけ**選ぶ(2026-08-11)。末尾・位置区分・曜日・特定日は
// 複数選べるトグルだが、こちらは「どの期間で見るか」なので同時に2つは成り立たない。
// 2026-08-12からパネル全体で1つ(#fPer)になった。
["fPer"].forEach(id=>{
  const box=document.getElementById(id);
  if(!box) return;
  box.addEventListener("click",e=>{
    const b=e.target&&e.target.closest?e.target.closest(".ch"):null;
    if(!b||!box.contains(b)||b.disabled) return;
    box.querySelectorAll(".ch").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    syncCal();     // 「日付を選ぶ」のときだけカレンダーを見せる(2026-08-12)
  });
});
// 期間の既定は**未選択**(2026-08-14・谷川氏指示「更新後や絞り込みクリアした時は
// 未選択の状態で開くようにして」)。それまでは直近7日を先に選んでいたが、
// 前に見ていた期間なのか既定なのかが分からず、意図しない期間のまま数字を入れる形だった。
// 未選択のまま数字を入れたときは絞り込まず「まず期間を選んで」と伝える
// (期間が変わると数値の意味そのものが変わるため)。
const PER_DEF={fPer:""};
function setPer(id,v){
  const box=document.getElementById(id);
  if(!box) return;
  const list=[...box.querySelectorAll(".ch")];
  if(!list.length) return;
  let t=list.find(x=>x.dataset.v===v&&!x.disabled);
  if(!t) t=list.find(x=>x.dataset.v===PER_DEF[id]);
  list.forEach(x=>x.classList.remove("on"));
  if(t) t.classList.add("on");
  syncCal();
}
function setFPer(v){ setPer("fPer",v); }
// 「午前中」はその日の昼の数字が要る。無い日は暗くして押せなくする
// (カードの午前中ボタンと同じ考え方)。選ばれていた場合は既定へ戻す。
function syncFRperHiru(){
  ["fPer"].forEach(id=>{
    const b=document.querySelector("#"+id+' .ch[data-v="hiru"]');
    if(!b) return;
    const D=window.HIRU&&window.HIRU.data;
    b.disabled=!(D&&D.k&&D.v);
    if(b.disabled&&b.classList.contains("on")) setPer(id,PER_DEF[id]);
  });
}
// 絞り込みで「午前中」を使えるように、昼のデータだけ先に読んでおく(2026-08-11)。
// 島図の色は変えない(on は触らない=押していないのに昼の顔にはしない)。
// 日付が今日でなければ持たない(古い日の数字を今日として使わない)。
let fHiruReq=null;
function ensureHiruData(){
  if(window.HIRU&&window.HIRU.data) return Promise.resolve(window.HIRU.data);
  if(fHiruReq) return fHiruReq;
  fHiruReq=fetch("hiru.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(j=>{
    const d=new Date(), ymd=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")
      +"-"+String(d.getDate()).padStart(2,"0");
    // ★取れなかったときは覚えない(2026-08-18)。覚えてしまうと、12:30より前に
    //   一度読んだ端末は、昼の分が届いたあとも開き直すまで「まだありません」の
    //   ままになる。次に呼ばれたらもう一度取りに行く。
    if(!j||!j.v||j.date!==ymd){ fHiruReq=null; return null; }
    if(!window.HIRU||!window.HIRU.data) window.HIRU={on:false,data:j};
    // 鮮度の行に午前中の時刻を反映する(2026-08-18)。読めた時点で1回だけ。
    try{ if(window.markHiruStamp) window.markHiruStamp(j); }catch(e){}
    return j;
  }).catch(()=>null);
  return fHiruReq;
}
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
// その日付が特定日に当てはまるか(2026-08-11)。日付ラベルは「M/D(曜)」形式。
// ゾロ目(1/1・2/2…11/11)と、店の特定日(毎月8・18・28日のような日の指定、
// または 10/10 のような月日の指定)を同じ入口で判定する。
function isToku(lab,key){
  const m=/^(\d+)\/(\d+)/.exec(lab||"");
  if(!m) return false;
  const mo=parseInt(m[1],10), da=parseInt(m[2],10);
  if(key==="zoro") return mo===da;
  const t=((typeof SHIMA!=="undefined"&&SHIMA.ftoku)||[]).find(x=>x.k===key);
  if(!t) return false;
  if(t.days&&t.days.length) return t.days.indexOf(da)>=0;
  if(t.date){ const p=String(t.date).split("/"); return mo===+p[0]&&da===+p[1]; }
  return false;
}
// 選んだ曜日・特定日だけの差枚合計。どちらも選んでいなければ null。
// **両方選んだときは「その両方に当てはまる日」**(例: 水曜 かつ 8のつく日)。
// 絞り込みの他の条件がすべて AND なので、そこに合わせている。
// ---- 曜日・特定日で「集計する日」を狭める(2026-08-14) ----
// 谷川氏指示「選んだ日の差枚合計は既に差枚項目が上部にあって重複するため不要」。
// 欄(#fDmin/#fDmax)を廃止したので、曜日・特定日は**上の数値条件すべてに効く
// 日の指定**へ格上げした(それまでは廃止した欄でしか効かず、曜日を選んだだけでは
// 1台も絞られなかった)。例: 期間=全期間 ＋ 曜日=水 → 水曜だけの差枚・出率で絞る。
// 何も選んでいなければ null=狭めない(＝従来と1つも値が変わらない)。
let FMASK=null;
function syncFMask(){
  const dow=chipsOn("fDow"), toku=chipsOn("fToku");
  if(!dow.length&&!toku.length){ FMASK=null; return; }
  const L=DATA.labels||[], ok=new Set();
  L.forEach((lab,i)=>{
    const wd=(/\(([^)]+)\)/.exec(lab||"")||[])[1]||"";
    let hit=true;
    if(dow.length) hit=dow.indexOf(wd)>=0;
    if(hit&&toku.length) hit=toku.some(k=>isToku(lab,k));
    if(hit) ok.add(i);
  });
  FMASK=ok;
}
// 期間 ＋ 狭めた日 の添字。狭めていなければ期間そのまま。
function mIdx(per){
  const l=perIdxList(per);
  return FMASK?l.filter(i=>FMASK.has(i)):l;
}
// 絞り込み専用の集計3つ。**狭めていないときは既存の関数へそのまま渡す**ので、
// 従来の値(全期間のbase込み・午前中など)は1つも変わらない。
function mSum(dai,per){
  if(!FMASK||per==="hiru") return sumForDai(dai,per);
  const m=DATA.machines[dai]; if(!m) return null;
  let s=0,n=0;
  mIdx(per).forEach(i=>{ const x=m.d[i]; if(x&&x[0]!=null){ s+=x[0]; n++; } });
  return n?s:null;      // 日を狭めたときは base(窓より前の累計)を足さない
}
function mRate(dai,per){
  if(!FMASK||per==="hiru") return rateForDai(dai,per);
  const m=DATA.machines[dai]; if(!m) return null;
  let s=0,g=0;
  mIdx(per).forEach(i=>{ const x=m.d[i];
    if(x){ if(x[0]!=null)s+=x[0]; if(x[1]!=null)g+=x[1]; } });
  return g>0?rate(s,g):null;
}
function mWork(dai,per){
  if(!FMASK||per==="hiru") return workStats(dai,per);
  const m=DATA.machines[dai];
  const none={days:null,g:null,avg:null,plus:null,pd:null,gd:null};
  if(!m) return none;
  let days=0,plus=0,g=0,gn=0;
  mIdx(per).forEach(i=>{
    const x=m.d[i]; if(!x) return;
    if(x[0]!=null){ days++; if(x[0]>0) plus++; }
    if(x[1]!=null&&x[1]>0){ g+=x[1]; gn++; }
  });
  if(!days) return none;
  return {days:days, g:gn?g:null, avg:gn?Math.round(g/gn):null,
          plus:Math.round(plus*1000/days)/10, pd:plus, gd:gn};
}
// 狭めているときだけ「（水のみ）」のように添える(件数の横に出す)。
function maskLabel(){
  const dow=chipsOn("fDow"), toku=chipsOn("fToku");
  const a=[];
  if(dow.length) a.push(dow.join("")+"曜");
  if(toku.length) a.push(toku.length+"件の特定日");
  return a.length?("／"+a.join("＋")+"だけ"):"";
}
function daySum(dai,dow,toku){
  const m=DATA.machines[dai];
  if(!m||(!dow.length&&!toku.length)) return null;
  const L=DATA.labels||[]; let sum=0, n=0;
  m.d.forEach((x,i)=>{
    const lab=L[i]||"";
    const wd=(/\(([^)]+)\)/.exec(lab)||[])[1]||"";
    let hit=true;
    if(dow.length) hit=dow.indexOf(wd)>=0;
    if(hit&&toku.length) hit=toku.some(k=>isToku(lab,k));
    if(hit&&x&&x[0]!=null){ sum+=x[0]; n++; }
  });
  return n?sum:null;
}
// ---- 狙い方(2026-08-20夕・谷川氏指示) ----
// 「上部のボタンを消して、新たに狙い方という項目にして、水曜日プラスかつ他の曜日凹み台を
//   とりあえずひとつボタンつくっておいて」。
// ここにあった「よく使う条件」5つ(直近7日プラス／+5000以上／3週間105%以上／全期間プラス／
// 前日プラス)は廃止した。あれは下の数値の欄に値を入れる近道でしかなく、同じことは欄でできる。
// 狙い方は**欄では書けない条件**(日を水曜と他の曜日に分けて、両方を同時に見る)を置く場所。
//
// 中身: 選んだ期間の中で「水曜の差枚の合計がプラス」かつ「水曜以外の差枚の合計がマイナス」。
// 根拠は2026-08-20の検証(memory: wed-dip-signal-verified-2026-08-20)。
//   ・水曜は投入日(ノーマル機の高設定率 水12.4% 対 日5.1%)
//   ・効くのは「凹んだ台を狙う」(AT機で+892。無作為の99%点+519を超える)
// この2つを1つの条件にしたもの＝「水曜には応えるのに、いまは凹んでいる台」。
// ★曜日・特定日の絞り(FMASK)はここへ掛けない。狙い方そのものが日の分け方を決めているので、
//   二重に狭めると意味が変わる。
function neraiWedDip(dai,per){
  const m=DATA.machines[dai];
  if(!m||!m.d) return null;
  const L=DATA.labels||[];
  let w=0,wn=0,o=0,on=0;
  perIdxList(per).forEach(i=>{
    const x=m.d[i];
    if(!x||x[0]==null) return;
    const wd=(/\(([^)]+)\)/.exec(L[i]||"")||[])[1]||"";
    if(wd==="水"){ w+=x[0]; wn++; }
    else{ o+=x[0]; on++; }
  });
  if(!wn||!on) return null;   // 片方の曜日が1日も無ければ比べられない=当てはめない
  return {wed:w, oth:o, wn:wn, on:on, hit:(w>0&&o<0)};
}
// 狙い方その2「直近7日で凹んだAT機」(2026-08-20夜)。63通りの総当たりで最良だったもの
// (memory: wed-best-nerai-rec-at-2026-08-20)。
//   AT機だけを、直近7日の平均差枚が低い順に並べて上位80台。
//   1日あたり +10,417円 / 95%の幅 +2,052〜+17,931円 / 無作為の中で平均 上位12.2%
//   ★曜日の対照実験で**水曜だけ**突出する(月32% 火51% 水12% 木53% 金32% 土25% 日33%)。
//     だから「凹み台は翌日出やすい」という一般則ではなく、水曜の投入の話として使う。
// ★期間の指定とは関係なく、いつも「その台の直近7日(記録のある日)」で計算する。
//   選んだ期間で計算し直すと、上の検証と別物になってしまうため。
const NERAI_REC_N = 80;      // 何台まで狙い表に入れるか(検証で使った数)
const NERAI_REC_MIN = 4;     // 直近7日のうち、記録がこれ未満の台は判定しない
// 一覧に数字を出すために、点数そのものも取り出せる形にしておく(2026-08-21)。
function neraiRecList(){
  const L=DATA.labels||[];
  const kt=(typeof SHIMA!=="undefined"&&SHIMA&&SHIMA.ktype)||{};
  const a=[];
  Object.keys(DATA.machines||{}).forEach(d=>{
    const m=DATA.machines[d]||{};
    if(((kt[m.n||""]||{}).t||"")!=="at") return;      // AT機だけ
    const v=[];
    for(let i=L.length-1;i>=0&&v.length<7;i--){
      const x=(m.d||[])[i];
      if(x&&x[0]!=null) v.push(x[0]);
    }
    if(v.length<NERAI_REC_MIN) return;
    a.push({d:String(d), m:v.reduce((s,x)=>s+x,0)/v.length});
  });
  a.sort((x,y)=>x.m-y.m);                              // 低い順=凹んでいる順
  return a;
}
function neraiRecTop(n){
  return new Set(neraiRecList().slice(0,n||NERAI_REC_N).map(x=>x.d));
}
function neraiLabel(){
  const on=chipsOn("fNer");
  if(!on.length) return "";
  const t=[];
  // ★名前は実態に合わせる(2026-08-21・谷川氏指摘「水曜の差枚の合計がプラスではなく
  //   水曜のプラスの日が高確率という認識だった」)。見ているのは**合計**であって
  //   プラスで終わった日の割合ではない。割合版は検証でマイナスだった。
  if(on.indexOf("weddip")>=0) t.push("水曜の合計プラス＋他曜日は合計マイナス");
  if(on.indexOf("recat")>=0) t.push("直近7日で凹んだAT機");
  return "／狙い方: "+t.join("＋");
}
// 狙い方を選んだのに期間が未選択だと「まず期間を選んでください」で止まる。
// 水曜と他の曜日の両方が要る条件なので、そのときだけ全期間を当てておく
// (あとから3週間などへ変えられる)。★この受け口は上のまとまり(#fNerを含む)の
//   あとに登録されるので、押した結果(.on の付け外し)を見てから動く。
(()=>{
  const box=document.getElementById("fNer");
  if(!box) return;
  box.addEventListener("click",e=>{
    const b=e.target&&e.target.closest?e.target.closest(".ch"):null;
    if(!b||!box.contains(b)) return;
    // 期間が未選択のままだと「まず期間を選んでください」で止まる。狙い方ごとに
    // 相性の良い期間を当てておく(あとから変えられる)。
    //   水曜プラス＋他曜凹み … 水曜と他の曜日の両方が要るので全期間
    //   直近7日で凹んだAT機   … 判定は期間と無関係だが、見るなら直近7日が自然
    if(b.classList.contains("on")&&!perNow()){
      setPer("fPer", b.dataset.v==="recat" ? "last7" : "all");
    }
  });
})();
document.getElementById("fApply").addEventListener("click",()=>{
  // 機種名の入力欄は谷川氏指示で削除(2026-07-31)。数値3条件(直近7日差枚/全期間トータル/
  // 3週間出率)だけで絞り込む。機種名は該当台のラベルが光ることで結果側から分かる。
  const fVmin=parseNum("fVmin"), fVmax=parseNum("fVmax");
  const fRmin=parseNum("fRmin"), fRmax=parseNum("fRmax");
  // 曜日・特定日で「数える日」を狭める(2026-08-14)。**台を走査する前に1回だけ**作る
  // (839台ぶん作り直すと重い)。「選んだ日の差枚合計」の欄はこれに置き換えて廃止した。
  syncFMask();
  // 稼働まわりの4条件(2026-08-12)。総稼働日数/累計G数/1日平均G数/プラス率。
  const fNmin=parseNum("fNmin"), fNmax=parseNum("fNmax");
  const fGmin=parseNum("fGmin"), fGmax=parseNum("fGmax");
  const fAmin=parseNum("fAmin"), fAmax=parseNum("fAmax");
  const fPmin=parseNum("fPmin"), fPmax=parseNum("fPmax");
  const sue=chipsOn("fSue"), pos=chipsOn("fPos"), dow=chipsOn("fDow"), toku=chipsOn("fToku");
  const ner=chipsOn("fNer");   // 狙い方(2026-08-20夕)
  // 狙い方その2は「上位80台」という数の指定なので、台を1つずつ見る前に
  // 1回だけ表を作る(839台ぶん作り直すと重い)。
  const recSet=(ner.indexOf("recat")>=0)?neraiRecTop(NERAI_REC_N):null;
  // 選んだ曜日をカード側へ渡す(2026-08-14)。ここで覚えておくと、絞り込んだ台を開いた
  // ときにその曜日だけのグラフ・表で開ける。曜日を外せば空になり、ボタンも消える。
  FDOW=dow.slice(); syncMdow();
  // 設定の推定まわり(2026-08-13)。回数の外部ファイルが要るので、まだ手元に無ければ
  // 落としてから押し直す(ここで待たないと、全台が「回数なし」で外れて0台になる)。
  // 「ノーマル機種だけ」のボタンは谷川氏指示で廃止(2026-08-13)。この3つのどれかを
  // 使えば自動でノーマル機種だけになる=画面には赤字の注記(#fSetNote)で伝える。
  const setc=chipsOn("fSet");
  const fBBmin=parseNum("fBBmin"), fBBmax=parseNum("fBBmax");   // BB(2026-08-21)
  const fBmin=parseNum("fBmin"), fBmax=parseNum("fBmax");       // RB(名前は当時のまま)
  const fKmin=parseNum("fKmin"), fKmax=parseNum("fKmax");
  const useSet=setc.length>0||fBBmin!=null||fBBmax!=null
               ||fBmin!=null||fBmax!=null||fKmin!=null||fKmax!=null;
  const needKoy=useSet;
  if(needKoy&&!KOYAKU&&SHIMA&&SHIMA.koyakuUrl){
    const c0=document.getElementById("fCount");
    if(c0) c0.textContent="回数のデータを読み込んでいます…";
    koyLoad().then(()=>{ document.getElementById("fApply").click(); });
    return;
  }
  const active = FNUM.map(parseNum).some(v=>v!=null)
    || sue.length>0 || pos.length>0 || dow.length>0 || toku.length>0
    || ner.length>0 || needKoy;
  // 期間が未選択のうちは判定しない(2026-08-14・谷川氏指示で既定を未選択にしたため)。
  // 同じ「差枚3000以上」でも期間が違えば意味がまるで変わるので、期間が決まる前に
  // 絞ると結果を読み違える。何が足りないのかを言葉で伝えて止める。
  if(!perNow()){
    clearHits();
    const lb0=document.getElementById("fList");
    if(lb0){ lb0.disabled=true; lb0.textContent="絞り込み台一覧"; }
    const rb0=document.getElementById("fRep");
    if(rb0){ rb0.disabled=true; rb0.textContent="傾向分析レポート"; }
    const lx0=document.getElementById("fListBox");
    if(lx0){ lx0.hidden=true; lx0.innerHTML=""; }
    const rx0=document.getElementById("fRepBox");
    if(rx0){ rx0.hidden=true; rx0.innerHTML=""; rx0._sg=null; }
    syncFPeek(false,0);
    document.getElementById("fCount").textContent = active
      ? "※ まず「期間」を選んでください（期間によって数値の意味が変わります）"
      : "「期間」を選んで条件を入れると、自動で絞り込みます";
    return;
  }
  let hitN=0;
  // 検索で付いた「今飛んだ1台」の強調は、条件で絞り直すと意味が変わるので落とす(2026-08-01)。
  document.querySelectorAll(".hitfocus").forEach(x=>x.classList.remove("hitfocus"));
  // 該当台が指す機種名ラベルの座標キー(2026-07-31新設・「機種名も一緒にハイライト」)。
  const hitLbl=new Set();
  const per=perNow();
  document.querySelectorAll(".tap").forEach(el=>{
    const dai=el.dataset.dai, st=filterStats(dai,per);
    let ok=!!st;
    if(ok && fVmin!=null && (st.sum==null||st.sum<fVmin)) ok=false;
    if(ok && fVmax!=null && (st.sum==null||st.sum>fVmax)) ok=false;
    if(ok && fRmin!=null && (st.rate==null||st.rate<fRmin)) ok=false;
    if(ok && fRmax!=null && (st.rate==null||st.rate>fRmax)) ok=false;
    // 稼働まわりの4条件(2026-08-12)。数字が無い台(その期間に記録が無い)は
    // 条件を入れた時点で外す=差枚・出率と同じ扱い。
    if(ok && fNmin!=null && (st.days==null||st.days<fNmin)) ok=false;
    if(ok && fNmax!=null && (st.days==null||st.days>fNmax)) ok=false;
    if(ok && fGmin!=null && (st.g==null||st.g<fGmin)) ok=false;
    if(ok && fGmax!=null && (st.g==null||st.g>fGmax)) ok=false;
    if(ok && fAmin!=null && (st.avg==null||st.avg<fAmin)) ok=false;
    if(ok && fAmax!=null && (st.avg==null||st.avg>fAmax)) ok=false;
    if(ok && fPmin!=null && (st.plus==null||st.plus<fPmin)) ok=false;
    if(ok && fPmax!=null && (st.plus==null||st.plus>fPmax)) ok=false;
    // 設定の推定まわり(2026-08-13)。回数の無い台(AT機など)は、この欄を使った
    // 時点で外す=差枚・出率と同じ扱い。数字は台番カードの内容詳細と同じ計算。
    if(ok && needKoy && !hasKoyaku(dai)) ok=false;
    if(ok && useSet){
      const se=setteiOf(dai,per);
      if(!se) ok=false;
      else{
        if(ok&&setc.length){
          const step=(se.kitai!=null)?String(Math.round(se.kitai)):null;
          if(step==null||setc.indexOf(step)<0) ok=false;
        }
        if(ok&&fBBmin!=null&&(se.bb==null||se.bb<fBBmin)) ok=false;
        if(ok&&fBBmax!=null&&(se.bb==null||se.bb>fBBmax)) ok=false;
        if(ok&&fBmin!=null&&(se.rb==null||se.rb<fBmin)) ok=false;
        if(ok&&fBmax!=null&&(se.rb==null||se.rb>fBmax)) ok=false;
        if(ok&&fKmin!=null&&(se.ko==null||se.ko<fKmin)) ok=false;
        if(ok&&fKmax!=null&&(se.ko==null||se.ko>fKmax)) ok=false;
      }
    }
    if(ok && sue.length && sue.indexOf(String(dai).slice(-1))<0) ok=false;
    // 位置区分はマスターの区分そのままで突き合わせる(2026-08-11。まとめるのをやめた)
    if(ok && pos.length && pos.indexOf((DATA.machines[dai]||{}).p||"")<0) ok=false;
    // 狙い方(2026-08-20夕)。水曜と他の曜日を分けて、両方を同時に満たす台だけ残す。
    if(ok && ner.indexOf("weddip")>=0){
      const nv=neraiWedDip(dai,per);
      if(!nv||!nv.hit) ok=false;
    }
    // 狙い方その2(2026-08-20夜)。直近7日で凹んだAT機の上位80台に入っているか。
    if(ok && recSet && !recSet.has(String(dai))) ok=false;
    // 曜日・特定日で狭めたのにその台の記録が1日も無ければ外す(2026-08-14。
    // 数値の欄を1つも使っていなくても、曜日を選んだ時点で「その曜日に動いていた台」
    // に絞られるのが自然なため)。
    if(ok && FMASK && (st.days==null||st.days<=0)) ok=false;
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
  // どの期間で見た結果なのかを件数の横に出す(2026-08-12・期間が1つになったので、
  // ここに書けばパネル全体の前提が1行で分かる)。
  // 「日付を選ぶ」で1日も選んでいないと、どの条件も当たらず0台になる。
  // 理由が分からないと詰まるので、そのときだけ言葉で示す(2026-08-12)。
  const noDay=(perNow()==="days"&&!fDays.size);
  document.getElementById("fCount").textContent = noDay
    ? "※「日付を選ぶ」の日付が1つも選ばれていません（カレンダーで日を押してください）"
    : (active ? ("該当: "+hitN+"台 / 839台（期間: "+perLabel()+maskLabel()
                  +neraiLabel()+"）")
              : "条件を選ぶと自動で絞り込みます");
  // 一覧ボタンは当たった台があるときだけ押せる(2026-08-12)
  const lb=document.getElementById("fList");
  if(lb){ lb.disabled=!(active&&hitN); }
  const lx=document.getElementById("fListBox");
  if(lx&&!lx.hidden) paintFilterList();     // 開いたままなら中身も貼り替える
  // 傾向分析レポートも一覧と同じ扱い(2026-08-14)。当たった台があるときだけ押せて、
  // 開いたままなら条件を変えるたびに中身を作り直す。
  const rb=document.getElementById("fRep");
  if(rb){ rb.disabled=!(active&&hitN); }
  const rx=document.getElementById("fRepBox");
  if(rx&&!rx.hidden) paintFilterReport();
  // 島図の「絞り込み解除」を出す(2026-08-12)。**光を付け終わってから**呼ぶ
  syncFtClose(active&&hitN?"filter":"");
  // パネル内の「島図を見る」も同じ条件で出す(2026-08-14)
  syncFPeek(active,hitN);
});
// ボタン選択・数字入力のたびに自動で絞り込み、該当台数をその場で更新する
// (2026-08-14・谷川氏指示)。それまでは条件を1つ変えるたびに「絞り込む」を押し直す
// 必要があり、いま何台残るのかが分からなかった。
// 判定は #fApply のハンドラをそのまま再利用する(条件のとり方を二度書かない)。
// 839台の走査が連続入力で詰まらないよう、少し待ってからまとめて1回だけ当てる。
// 「島図を見る」ボタンの出し入れ(2026-08-14・谷川氏指示)。条件が入っていて、かつ
// 該当台があるときだけ出す。押すとパネルを閉じるだけ=光った島図がそのまま見える。
// 閉じても条件は消えないので、絞り込みボタンをもう一度押せば同じ状態で戻れる。
function syncFPeek(active,hitN){
  const b=document.getElementById("fPeek"); if(!b) return;
  const show=!!(active&&hitN);
  b.hidden=!show;
  b.classList.toggle("show",show);
  const n=document.getElementById("fPeekN");
  if(n) n.textContent=show?("（該当 "+hitN+"台）"):"";
}
(function(){
  const b=document.getElementById("fPeek");
  if(!b) return;
  b.addEventListener("click",()=>{
    const m=document.getElementById("filterModal");
    if(m) m.style.display="none";
    // 資料を見ている最中に押したときは**島図へ戻す**(2026-08-14・谷川氏報告
    // 「資料ボタン押されてる時に島図を見るボタン押しても資料の画面になるだけだった」)。
    // パネルを閉じるだけだと後ろに資料が出たままで、光った台を確かめられない。
    if(typeof curView!=="undefined"&&curView!=="island"){ zoomF=1; setView("island"); }
  });
})();
let fAutoT=null;
function fAutoApply(){
  clearTimeout(fAutoT);
  fAutoT=setTimeout(()=>{
    const b=document.getElementById("fApply");
    if(b) b.click();
  },220);
}
FNUM.forEach(id=>{
  const el=document.getElementById(id);
  if(el) el.addEventListener("input",fAutoApply);
});
// チップ(期間・狙い方・末尾・位置区分・曜日・特定日・設定)とカレンダーの日付。
// 各ボックスの既存ハンドラが状態を切り替えた**あと**に動くよう、親側のバブリングで受ける。
// (「よく使う条件」のプリセットは2026-08-20夕に廃止。いまは全部この委譲で拾う)
(function(){
  const card=document.getElementById("filterCard");
  if(!card) return;
  card.addEventListener("click",e=>{
    const t=e.target&&e.target.closest
      ? e.target.closest(".ch,.fc-d,#fCalAll,#fCalNone")
      : null;
    if(t) fAutoApply();
  });
})();
// 絞り込んだ台の一覧(2026-08-12・谷川氏指示「機種ごとに表にして視覚的に見やすいように」)。
// 島図の光だけだと「どの機種に何台当たったか」を数えるのに島全体を目で追う必要があった。
// **いま光っている台(.filt-hit)をそのまま読む**=絞り込みの判定を二度書かない
// (条件のとり方が増えても一覧側を直さなくてよい)。
// 一覧の中で打った言葉(2026-08-21)。表を作り直しても残すのでここに置く。
let flQuery="";
function paintFilterList(){
  const box=document.getElementById("fListBox"); if(!box) return;
  const per=perNow();
  // 狙い方「直近7日で凹んだAT機」を選んでいるときだけ、その数字の列を足す
  // (2026-08-21・谷川氏「この80台のうちどの順番で期待値が高いのかがわからない」)。
  // ★順位を作って見せるのではない。実測では**順位に成績の差が無い**
  //   (順位と収支の相関 -0.006／偶然でこうなる確率 0.88)。出すのは
  //   「どのくらい凹んでいる台か」という材料そのもの。
  const recOn=chipsOn("fNer").indexOf("recat")>=0;
  let recM=null;
  if(recOn){
    recM={};
    neraiRecList().forEach((x,i)=>{ recM[x.d]={v:x.m, i:i+1}; });
  }
  const g={};
  document.querySelectorAll(".tap.filt-hit").forEach(el=>{
    const dai=el.dataset.dai, m=DATA.machines[dai]||{};
    const nm=m.n||"（機種名なし）";
    const w=mWork(dai,per);        // 曜日・特定日で狭めていればその日だけ(2026-08-14)
    (g[nm]=g[nm]||[]).push({dai:dai, p:m.p||"",
                            v:mSum(dai,per), r:mRate(dai,per),
                            a:w.avg, pl:w.plus,
                            rc:(recM&&recM[String(dai)])||null});
  });
  const names=Object.keys(g);
  if(!names.length){ box.innerHTML='<div class="fl-none">該当した台がありません</div>'; return; }
  // 台数の多い機種を先に。同数なら機種名順(見るときに探しやすい並び)
  names.sort((a,b)=>(g[b].length-g[a].length)||a.localeCompare(b,"ja"));
  const num=v=>(typeof v==="number")?((v>0?"+":"")+v.toLocaleString()):"−";
  const rate=v=>(typeof v==="number")?(v.toFixed(1)+"%"):"−";
  const gnum=v=>(typeof v==="number")?v.toLocaleString():"−";
  const cls=v=>(typeof v!=="number")?"":(v>0?" fl-p":(v<0?" fl-m":""));
  // 期間は**表の見出しではなく一覧の頭に1回だけ**出す(2026-08-12。期間がパネル全体で
  // 1つになり、列も6つに増えたため。列名に期間を足すと折り返して読みにくい)。
  // チェックした台は**いちばん上**に置く(2026-08-12・選び終わってから見比べるものなので、
  // 機種ごとの内訳を延々スクロールして探し直さなくて済むように)。
  // 一覧の中の検索(2026-08-21・谷川氏指示)。機種名でも台番でも同じ窓で絞る。
  let h='<div id="fCkBox"></div>'
        +'<div class="fl-srch"><span class="fl-si" aria-hidden="true">'
        +'<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.4" '
        +'stroke="currentColor" stroke-width="2"/><path d="M15.8 15.8 20 20" '
        +'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>'
        +'<input id="flQ" type="search" inputmode="search" enterkeyhint="done" '
        +'placeholder="機種名 または 台番で絞る" autocomplete="off" autocorrect="off" '
        +'spellcheck="false" value="'+esc(flQuery)+'">'
        +'<span id="flQn"></span>'
        +'<button type="button" id="flQx" aria-label="一覧の検索を消す" hidden>✕</button>'
        +'</div>'
        +'<div id="flQnone" hidden>その言葉に当てはまる機種・台番は、いまの絞り込みの中にありません</div>'
        +'<div class="fl-h">機種ごとの内訳（'+names.length+'機種 / '
        +document.querySelectorAll(".tap.filt-hit").length+'台）'
        +'<span class="fl-hp">期間: '+esc(perLabel())+'</span></div>'
        // ★文と画面を食い違わせない(2026-08-21・谷川氏指摘「機種毎に並べてるから
        //   順番関係ないけど実際の画面とは説明が異なるよね」)。一覧は**機種ごとの
        //   まとまり**が先で、凹みの深い順はそのまとまりの中の並び。
        //   「◯番目」は狙い表80台を通した順番なので、そこも言葉で分ける。
        +(recOn?('<div class="fl-note">「直近7日」はその台の直近7日の平均差枚。'
                 +'一覧は機種ごとにまとめ、その中を凹みの深い順に並べています'
                 +'（数字の下の「◯番目」は狙い表80台を通した順番）。<br>'
                 +'★この順番に成績の差はありません（水曜9日で実測。順位と収支の'
                 +'関係はほぼゼロ）。上位を取りにいかず、空いている台で構いません。'
                 +'</div>'):"");
  names.forEach(nm=>{
    // 狙い方を使っているときは狙い表の順(凹みの深い順)、それ以外は従来どおり差枚順
    const rows=g[nm].sort(recOn
      ? ((a,b)=>((a.rc?a.rc.i:9e9)-(b.rc?b.rc.i:9e9)))
      : ((a,b)=>(b.v||-1e9)-(a.v||-1e9)));
    // 機種の見出しに**当たった台の平均差枚**も出す(2026-08-12)。43機種を
    // 順に見ていくとき、台数だけでは機種どうしを見比べられないため。
    const vs=rows.map(x=>x.v).filter(x=>typeof x==="number");
    const av=vs.length?Math.round(vs.reduce((a,b)=>a+b,0)/vs.length):null;
    h+='<div class="fl-g" data-nm="'+esc(nm)+'"><div class="fl-gn">'+esc(nm)
      +'<span>'+rows.length+'台'
      +(av!=null?(' ／ 平均<b class="'+(av>0?"fl-p":(av<0?"fl-m":""))+'">'
                  +((av>0?"+":"")+av.toLocaleString())+'</b>'):"")+'</span></div>'
      // 平均G数とプラス率も列に出す(2026-08-12・この2つで絞り込めるようにしたので、
      // 一覧でも実際の値を見られないと確かめようがない)
      // いちばん左はチェック(2026-08-12・谷川氏指示)。押した台は上の「チェックした台」へ集まる
      // ★列は7つのまま(2026-08-21)。8つにすると端末幅390pxで右へ35pxはみ出した。
      //   狙い方を使っているときは「位置」を「直近7日」に**入れ替える**
      //   (位置は台番カードと島図で分かる。いま見たいのはどのくらい凹んでいるか)。
      +'<table class="fl-t"><thead><tr><th></th><th>台番</th>'
      +(recOn?'<th>直近7日</th>':'<th>位置</th>')
      +'<th>差枚</th><th>出率</th><th>平均G</th><th>ﾌﾟﾗｽ率</th></tr></thead><tbody>'
      +rows.map(x=>'<tr>'+ckCell(x.dai)+'<td class="fl-d">'+daiBtn(x.dai)
        +'</td>'
        +(recOn?('<td class="fl-rc'+(x.rc?cls(x.rc.v):"")+'">'
                 +(x.rc?(num(Math.round(x.rc.v))+'<br><span class="fl-ri">'
                         +x.rc.i+'番目</span>'):"−")+'</td>')
               :('<td class="fl-q">'+esc(x.p)+'</td>'))
        +'<td class="fl-v'+cls(x.v)+'">'+num(x.v)
        +'</td><td class="fl-r'+cls((x.r==null)?null:(x.r-100))+'">'+rate(x.r)
        +'</td><td class="fl-a">'+gnum(x.a)
        +'</td><td class="fl-pl">'+rate(x.pl)
        +'</td></tr>').join("")+'</tbody></table></div>';
  });
  box.innerHTML=h;
  paintCheckedList();
  // 打った言葉は覚えているので、条件を変えて一覧を作り直しても残る(2026-08-21)
  const qi=document.getElementById("flQ");
  if(qi){
    qi.addEventListener("input",()=>{ flQuery=qi.value||""; flQApply(); });
    qi.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); qi.blur(); } });
  }
  const qx=document.getElementById("flQx");
  if(qx) qx.addEventListener("click",()=>{
    flQuery="";
    if(qi){ qi.value=""; qi.focus(); }
    flQApply();
  });
  flQApply();
}
// 一覧の中の検索(2026-08-21)。★表は作り直さない=行の見せ隠しだけで絞る。
// 作り直すと打っている途中に入力欄から指が離れ、日本語の変換も切れてしまう。
//   機種名が当たった … その機種の台を全部残す（島ごと見たいとき）
//   台番が当たった   … その行だけ残す（1台を探しているとき）
function flQApply(){
  const box=document.getElementById("fListBox");
  if(!box||box.hidden) return;
  const q=String(flQuery||"").trim().toLowerCase();
  const x=document.getElementById("flQx");
  if(x) x.hidden=!q;
  let gN=0, dN=0;
  box.querySelectorAll(".fl-g").forEach(g=>{
    const nm=String(g.dataset.nm||"").toLowerCase();
    const byNm=!!q&&nm.indexOf(q)>=0;
    let n=0;
    g.querySelectorAll("tbody tr").forEach(tr=>{
      const b=tr.querySelector(".fl-go");
      const dai=b?String(b.dataset.dai||""):"";
      const on=!q||byNm||dai.indexOf(q)>=0;
      tr.classList.toggle("fl-hide",!on);
      if(on) n++;
    });
    g.classList.toggle("fl-hide",!n);
    if(n){ gN++; dN+=n; }
  });
  const cn=document.getElementById("flQn");
  if(cn) cn.textContent=q?(gN+"機種 / "+dN+"台"):"";
  const none=document.getElementById("flQnone");
  if(none) none.hidden=!(q&&!dN);
}
// チェックした台(2026-08-12・谷川氏指示「絞り込みした台番の左側に小さいチェックボタンを
// 作り、チェック台をまとめて一覧でみれるように」)。気になった台を**機種をまたいで**
// 溜めて見比べるためのもの。条件を変えて絞り込み直しても消えないので、
// 「直近7日で良かった台」と「水曜だけ良かった台」を順に足していける。
// ★のピン留めとは別物で、**読み込み直すと消える**(その場の選び分け用。
// 長く残したいものはピン留めを使う)。
const fCk=new Set();
// 一覧の台番は**押せるボタン**(2026-08-12・谷川氏指示「各台番をボタンにして開いたら
// 絞り込んだ条件の差枚グラフ画面がみれるように」)。それまでは数字が並ぶだけで、
// 気になった台を見るには一覧を閉じて島図から探し直す必要があった。
function daiBtn(dai){
  return '<button type="button" class="fl-go" data-dai="'+esc(dai)
    +'" aria-label="台'+esc(dai)+'のグラフを開く">'+esc(dai)+"</button>";
}
// 絞り込みの期間 → 台番カードのグラフ期間(.mchip の data-w)。
// 「絞り込んだ条件のグラフ」で開くための対応表。午前中は日毎のグラフを持たないので
// 単日で開き、そのうえでカードの「今日の午前中」が押せるなら押す(同じ数字で見える)。
function perWin(){
  const p=perNow();
  // 日付を選んでいるときは、その日だけのグラフを持っていないので3週間で開く
  // (カードのグラフ期間は .mchip の6つに決まっているため)
  if(p==="days") return NDAYS;
  if(p==="wed") return -1;
  if(p==="last7") return WEEK;
  if(p==="all") return 0;
  if(p==="single"||p==="hiru") return 1;
  return NDAYS;      // nd21=3週間
}
function openDaiFromList(dai){
  if(!DATA.machines[dai]) return;
  const md=document.getElementById("filterModal");
  if(md) md.style.display="none";          // カードが隠れないようパネルは閉じる
  if(typeof curView!=="undefined"&&curView==="island") focusDai(dai);
  renderCard(dai,perWin());
  // 一覧から開いたときだけ「← 絞り込み」を出す(2026-08-12・谷川氏指示)。
  // renderCard は毎回いったん隠すので、**開いた後に**出す。
  const bf=document.getElementById("backFilter");
  if(bf) bf.hidden=false;
  // 「← 絞り込み」は押すとカードを閉じてパネルへ戻す(一覧は開いたまま残っている)
  if(bf&&!bf.dataset.wired){
    bf.dataset.wired="1";
    bf.addEventListener("click",e=>{
      e.stopPropagation();
      closeCard(false);
      const p=document.getElementById("filterModal");
      if(p){ p.style.display="block"; fitFilterModal();
             requestAnimationFrame(()=>{ if(p.style.display==="block") fitFilterModal(); }); }
    });
  }
  // 午前中で絞り込んでいたときは、カードも午前中の顔にそろえる
  if(perNow()==="hiru"){
    setTimeout(()=>{
      const b=document.getElementById("mhiruBtn");
      if(b&&!b.disabled&&!b.classList.contains("is-on")) b.click();
    },260);
  }
}
function ckCell(dai){
  return '<td class="fl-ck"><input type="checkbox" class="fl-cb" data-dai="'+esc(dai)
    +'" aria-label="台'+esc(dai)+'をチェック"'+(fCk.has(String(dai))?" checked":"")+"></td>";
}
// チェックした台だけの一覧。機種をまたぐので**機種名の列**を持ち、位置区分は省く
// (幅に収めるため。位置区分は下の機種ごとの内訳で見られる)。並びは差枚の大きい順。
function paintCheckedList(){
  const box=document.getElementById("fCkBox"); if(!box) return;
  const per=perNow();
  const list=[...fCk].filter(d=>DATA.machines[d]);
  if(!list.length){ box.innerHTML=""; return; }
  const num=v=>(typeof v==="number")?((v>0?"+":"")+v.toLocaleString()):"−";
  const rate=v=>(typeof v==="number")?(v.toFixed(1)+"%"):"−";
  const gnum=v=>(typeof v==="number")?v.toLocaleString():"−";
  const cls=v=>(typeof v!=="number")?"":(v>0?" fl-p":(v<0?" fl-m":""));
  const rows=list.map(d=>{
    const m=DATA.machines[d]||{}, w=workStats(d,per);
    return {dai:d, n:m.n||"（機種名なし）", v:sumForDai(d,per), r:rateForDai(d,per),
            a:w.avg, pl:w.plus};
  }).sort((a,b)=>(b.v||-1e9)-(a.v||-1e9));
  const vs=rows.map(x=>x.v).filter(x=>typeof x==="number");
  const av=vs.length?Math.round(vs.reduce((a,b)=>a+b,0)/vs.length):null;
  // 見出しは**折り返さない**(2026-08-12。差枚が5桁になると2行に割れて不格好だった)。
  // 入り切らないときは字の方を詰める(ボタンは押せる幅を保つ)。
  box.innerHTML='<div class="fl-ckh"><span class="fl-ckt">チェックした台（'+rows.length+'台'
    +(av!=null?(' ／ 平均<b class="'+(av>0?"fl-p":(av<0?"fl-m":""))+'">'
                +((av>0?"+":"")+av.toLocaleString())+"</b>"):"")+'）</span>'
    +'<button type="button" id="fCkClear">すべて外す</button></div>'
    +'<table class="fl-t fl-tc"><thead><tr><th></th><th>台番</th><th>機種</th>'
    +'<th>差枚</th><th>出率</th><th>平均G</th><th>ﾌﾟﾗｽ率</th></tr></thead><tbody>'
    +rows.map(x=>'<tr>'+ckCell(x.dai)+'<td class="fl-d">'+daiBtn(x.dai)
      +'</td><td class="fl-n">'+esc(x.n)
      +'</td><td class="fl-v'+cls(x.v)+'">'+num(x.v)
      +'</td><td class="fl-r'+cls((x.r==null)?null:(x.r-100))+'">'+rate(x.r)
      +'</td><td class="fl-a">'+gnum(x.a)
      +'</td><td class="fl-pl">'+rate(x.pl)
      +'</td></tr>').join("")+"</tbody></table>";
}
// チェックの受けは**まとめて委譲**(表は絞り込みのたびに作り直されるので、
// 1つずつ addEventListener すると付け直しが要る)。
(function(){
  const box=document.getElementById("fListBox");
  if(!box) return;
  box.addEventListener("change",e=>{
    const b=e.target;
    if(!b||!b.classList||!b.classList.contains("fl-cb")) return;
    const d=String(b.dataset.dai||"");
    if(b.checked) fCk.add(d); else fCk.delete(d);
    // 同じ台のチェックが2か所(上の一覧と機種ごとの内訳)に出るので両方そろえる
    box.querySelectorAll('.fl-cb[data-dai="'+d+'"]').forEach(x=>{ x.checked=b.checked; });
    paintCheckedList();
  });
  box.addEventListener("click",e=>{
    const t=e.target;
    const go=t&&t.closest?t.closest(".fl-go"):null;
    if(go){ e.stopPropagation(); openDaiFromList(go.dataset.dai); return; }
    if(t&&t.id==="fCkClear"){
      fCk.clear();
      box.querySelectorAll(".fl-cb").forEach(x=>{ x.checked=false; });
      paintCheckedList();
      return;
    }
    // チェックそのものは小さいので、**枠(td)のどこを押しても効く**ようにする
    const td=t&&t.closest?t.closest("td.fl-ck"):null;
    if(td&&t.tagName!=="INPUT"){
      const cb=td.querySelector(".fl-cb");
      if(cb){ cb.checked=!cb.checked; cb.dispatchEvent(new Event("change",{bubbles:true})); }
    }
  });
})();
document.getElementById("fList").addEventListener("click",()=>{
  const box=document.getElementById("fListBox"); if(!box) return;
  if(box.hidden){ paintFilterList(); box.hidden=false;
    document.getElementById("fList").textContent="一覧を閉じる";
    box.scrollIntoView({block:"nearest",behavior:"smooth"}); }
  else { box.hidden=true; box.innerHTML="";
    document.getElementById("fList").textContent="絞り込み台一覧"; }
});
// ---- 傾向分析レポート(2026-08-14新設・谷川氏指示) ----
// 「絞り込みパネルに傾向分析レポートのボタンを置き、押すと絞り込み内容に応じて分析し
//  表形式で見やすくまとめる。どのような傾向や癖が見られるか／おすすめの機種や台番／
//  絞り込みの意図を汲み取り、さらに絞るならどの絞り込みがおすすめか」。
// 一覧(fListBox)が「当たった台を並べる」ものなのに対し、こちらは
// **当たった台の集合が全体と何が違うか**を見る。
// **いま光っている台(.filt-hit)をそのまま読む**=絞り込みの判定を二度書かない
// (一覧と同じ考え方。条件が増えてもここを直さなくてよい)。
// 数字はすべて手元のデータから直接計算する(丸めた平均から逆算したり推定で代用しない)。
function repRec(dai,per){
  const m=DATA.machines[dai]||{}, w=mWork(dai,per);   // 狭めていればその日だけ(2026-08-14)
  return {dai:String(dai), nm:m.n||"（機種名なし）", p:m.p||"", pg:posGroup(m.p||""),
          sue:String(dai).slice(-1), v:mSum(dai,per), r:mRate(dai,per),
          days:w.days, g:w.g, avg:w.avg, plus:w.plus, pd:w.pd, gd:w.gd};
}
// 集合の代表値。**%は足せない**ので、出率は差枚合計とG数合計から出し直し、
// プラス率はプラスだった台日と総台日から出し直す(machineAgg と同じ考え方)。
function repAgg(list){
  let sv=0,nv=0,sg=0,sgd=0,pd=0,dd=0;
  list.forEach(x=>{
    if(typeof x.v==="number"){ sv+=x.v; nv++; }
    if(x.g){ sg+=x.g; sgd+=(x.gd||0); }
    if(x.days){ dd+=x.days; pd+=(x.pd||0); }
  });
  return {n:list.length, av:nv?Math.round(sv/nv):null, sum:nv?sv:null,
          rate:(nv&&sg>0)?rate(sv,sg):null,
          avgG:sgd?Math.round(sg/sgd):null,
          plus:dd?Math.round(pd*1000/dd)/10:null};
}
function repBy(list,key){
  const o={};
  list.forEach(x=>{ const k=x[key]; if(k===""||k==null) return; (o[k]=o[k]||[]).push(x); });
  return o;
}
// 軸ごとの偏り。「その値を持つ台のうち何台が該当したか(該当率)」を全体の該当率と比べる。
// 倍率が1より大きいほど、その値に該当台が集まっている=癖がある。
// 母数の小さい値はぶれるだけなので、**全体で minAll 台以上ある値だけ**を見る。
function repAxis(hits,all,key,minAll){
  const H=repBy(hits,key), A=repBy(all,key);
  const base=all.length?(hits.length/all.length):0;
  const rows=Object.keys(A).filter(k=>A[k].length>=(minAll||5)).map(k=>{
    const h=(H[k]||[]).length, a=A[k].length;
    return {k:k, h:h, a:a, rt:a?(h*100/a):0, lift:(base>0&&a)?((h/a)/base):0,
            ag:repAgg(H[k]||[])};
  }).filter(x=>x.h>0);
  rows.sort((x,y)=>(y.lift-x.lift)||(y.h-x.h));
  return {base:base*100, rows:rows};
}
// 該当台が「どの曜日に出しているか」。台の属性ではなく日ごとの実績なので、
// **台日(台×日)を母数**にして平均差枚を出す。選んだ期間の日だけを数える
// (perIdxList を使う=差枚・出率と同じ日を見る)。
function repDow(list,per){
  const L=DATA.labels||[], idx=perIdxList(per), o={};
  idx.forEach(i=>{
    const wd=(/\(([^)]+)\)/.exec(L[i]||"")||[])[1]||""; if(!wd) return;
    list.forEach(x=>{
      const m=DATA.machines[x.dai]; if(!m) return;
      const d=(m.d||[])[i]; if(!d||d[0]==null) return;
      const t=o[wd]||(o[wd]={n:0,s:0,p:0});
      t.n++; t.s+=d[0]; if(d[0]>0) t.p++;
    });
  });
  return o;
}
// いま入っている条件をまとめて取る(意図の読み取りと、重ねる提案の重複よけに使う)。
function repCur(){
  const num={};
  FNUM.forEach(id=>{ num[id]=parseNum(id); });
  return {num:num, sue:chipsOn("fSue"), pos:chipsOn("fPos"),
          dow:chipsOn("fDow"), toku:chipsOn("fToku"), set:chipsOn("fSet"),
          ner:chipsOn("fNer")};
}
// 何を探しているのかを1行で言い直す(谷川氏指示「絞り込みの意図を汲み取り」)。
// **入っている条件だけから組み立てる**=思い込みで決めない。
function repIntent(cur){
  const a=[], N=cur.num;
  if(N.fVmin!=null&&N.fVmin>0) a.push("出ている台");
  if(N.fVmax!=null&&N.fVmax<=0) a.push("凹んでいる台");
  if(N.fRmin!=null) a.push("出率の高い台");
  if(N.fRmax!=null) a.push("出率の低い台");
  if(N.fPmin!=null) a.push("プラスの日が多い＝安定して出ている台");
  if(N.fAmin!=null||N.fGmin!=null) a.push("よく回っている台");
  if(N.fNmin!=null) a.push("稼働日数の多い台");
  if(cur.set.length||N.fBBmin!=null||N.fBmin!=null||N.fKmin!=null)
    a.push("設定が入っていそうなノーマル機");
  if(cur.sue.length) a.push("末尾"+cur.sue.join("・")+"の癖");
  if(cur.pos.length) a.push("置かれた位置（"+cur.pos.join("・")+"）の癖");
  if(cur.dow.length) a.push(cur.dow.join("・")+"曜の出方");
  if(cur.toku.length) a.push("特定日の出方");
  if(cur.ner&&cur.ner.indexOf("weddip")>=0) a.push("水曜には出て、他の曜日は凹んでいる台");
  if(cur.ner&&cur.ner.indexOf("recat")>=0) a.push("直近7日で凹んでいるAT機");
  if(!a.length) return "条件がまだ少ないので、差枚か出率の下限を入れると傾向が見えやすくなります。";
  return "この絞り込みは「"+a.join("」と「")+"」を、期間「"+perLabel()+"」で探しています。";
}
// さらに絞るなら。**この画面に実際にある操作**だけを候補にする(押せない提案はしない)。
// いまの該当台をその条件で絞り直し、**平均差枚が上がったものだけ**を勧める。
// 3台を下回るものは出さない(1〜2台では平均が偶然で動くため)。
function repSuggest(hits,now,cur){
  const out=[];
  const add=(lab,how,set,sub)=>{
    if(sub.length<3||sub.length>=hits.length) return;
    const ag=repAgg(sub);
    if(ag.av==null||now.av==null||ag.av<=now.av) return;
    out.push({lab:lab,how:how,set:set,ag:ag,up:ag.av-now.av});
  };
  if(!cur.sue.length){
    for(let d=0;d<10;d++){
      const s=String(d);
      add("末尾 "+s,"「台番の末尾」の "+s+" を押す",{sue:s},hits.filter(x=>x.sue===s));
    }
  }
  if(!cur.pos.length){
    const P=repBy(hits,"p");
    Object.keys(P).forEach(k=>{
      add("位置区分 "+k,"「位置区分」の "+k+" を押す",{pos:k},P[k]);
    });
  }
  // 数値の候補は**いまの該当台の分布から作る**(2026-08-14に固定値から変更)。
  // 固定値(出率100/103/105/110 など)だと、すでに絞り込んで全部105%を超えている
  // ようなときに候補が1つも出せなかった。「上から4割」「上から2割」が残る線を採り、
  // 読みやすい刻みへ丸めてから**実際に当ててみて**効果を確かめる
  // (丸めで台数が変わるので、丸めた後の値で数え直す)。
  const quant=(arr,p)=>{
    const a=arr.slice().sort((x,y)=>x-y);
    if(!a.length) return null;
    return a[Math.min(a.length-1,Math.max(0,Math.round((a.length-1)*p)))];
  };
  const numc=(id,fld,lab,unit,step)=>{
    const cw=cur.num[id];
    const vals=hits.map(x=>x[fld]).filter(v=>typeof v==="number");
    if(vals.length<6) return;          // 母数が小さいと分位点が意味を持たない
    const seen={};
    [0.60,0.80].forEach(p=>{
      const q=quant(vals,p); if(q==null) return;
      const t=Math.round(q/step)*step;
      if(!isFinite(t)||seen[t]) return; seen[t]=1;
      if(cw!=null&&cw>=t) return;      // すでに同じか厳しい下限が入っているなら勧めない
      add(lab+" "+t.toLocaleString()+unit+"以上",
          "「"+lab+"」の左の欄へ "+t+" を入れる",{num:[id,t]},
          hits.filter(x=>typeof x[fld]==="number"&&x[fld]>=t));
    });
  };
  numc("fRmin","r","出率","%",1);
  numc("fPmin","plus","プラス率","%",5);
  numc("fAmin","avg","1日平均G数","G",100);
  numc("fVmin","v","差枚","枚",1000);
  if(cur.num.fVmin==null){
    add("差枚がプラスの台だけ","「差枚」の左の欄へ 1 を入れる",{num:["fVmin",1]},
        hits.filter(x=>typeof x.v==="number"&&x.v>0));
  }
  out.sort((a,b)=>(b.up-a.up)||(b.ag.n-a.ag.n));
  return out.slice(0,4);
}
const POSG={"外角":"外角","外":"外側","中":"中央","内":"内側","内角":"内角"};
function paintFilterReport(){
  const box=document.getElementById("fRepBox"); if(!box) return;
  const per=perNow();
  const hits=Array.from(document.querySelectorAll(".tap.filt-hit"))
                  .map(el=>repRec(el.dataset.dai,per));
  if(!hits.length){ box.innerHTML='<div class="fl-none">該当した台がありません</div>'; return; }
  // 比べる相手は**その期間に記録のある台**(1台も回っていない台を分母に入れると、
  // 該当率が実際より低く出る)。
  const all=Array.from(document.querySelectorAll(".tap"))
                 .map(el=>repRec(el.dataset.dai,per)).filter(x=>x.days!=null);
  const cur=repCur(), now=repAgg(hits), base=repAgg(all);
  const sv=v=>(typeof v==="number")?((v>0?"+":"")+v.toLocaleString()):"−";
  const pv=v=>(typeof v==="number")?(v.toFixed(1)+"%"):"−";
  const gv=v=>(typeof v==="number")?(v.toLocaleString()+"G"):"−";
  const cl=v=>(typeof v!=="number")?"":(v>0?" fl-p":(v<0?" fl-m":""));
  const dif=(a,b)=>(typeof a==="number"&&typeof b==="number")?(a-b):null;
  const pt=v=>(v==null)?"−":((v>0?"+":"")+(Math.round(v*10)/10)+"pt");
  let h='<div class="fl-h">傾向分析レポート（該当 '+hits.length+'台 / 記録のある '
       +all.length+'台）<span class="fl-hp">期間: '+esc(perLabel())+'</span></div>'
       +'<div class="fr-i">'+esc(repIntent(cur))+'</div>';
  // ① 全体との比べ
  const d1=dif(now.av,base.av), d2=dif(now.rate,base.rate),
        d3=dif(now.plus,base.plus), d4=dif(now.avgG,base.avgG);
  h+='<div class="fr-s">① この絞り込みは全体とどう違うか</div>'
    +'<table class="fl-t fr-t fr-tw"><thead><tr><th>項目</th><th>該当台</th><th>全体</th>'
    +'<th>差</th></tr></thead><tbody>'
    +'<tr><td class="fr-k">平均差枚</td><td class="'+cl(now.av)+'">'+sv(now.av)
      +'</td><td class="'+cl(base.av)+'">'+sv(base.av)+'</td><td class="'+cl(d1)+'">'
      +sv(d1)+'</td></tr>'
    +'<tr><td class="fr-k">出率</td><td class="'+cl(now.rate==null?null:now.rate-100)+'">'
      +pv(now.rate)+'</td><td class="'+cl(base.rate==null?null:base.rate-100)+'">'
      +pv(base.rate)+'</td><td class="'+cl(d2)+'">'+pt(d2)+'</td></tr>'
    +'<tr><td class="fr-k">プラス率</td><td>'+pv(now.plus)+'</td><td>'+pv(base.plus)
      +'</td><td class="'+cl(d3)+'">'+pt(d3)+'</td></tr>'
    +'<tr><td class="fr-k">1日平均G数</td><td>'+gv(now.avgG)+'</td><td>'+gv(base.avgG)
      +'</td><td class="'+cl(d4)+'">'+(d4==null?"−":((d4>0?"+":"")+d4.toLocaleString()+"G"))
      +'</td></tr>'
    +'</tbody></table>';
  // ② 軸ごとの偏り
  h+='<div class="fr-s">② どこに偏っているか（癖）</div>';
  [{k:"nm",t:"機種",min:4},{k:"sue",t:"台番の末尾",min:20},
   {k:"pg",t:"位置区分",min:20}].forEach(ax=>{
    const r=repAxis(hits,all,ax.k,ax.min);
    if(!r.rows.length){
      h+='<div class="fr-ax">'+esc(ax.t)+'<b class="fr-no">見るだけの数がありません</b></div>';
      return;
    }
    const top=r.rows[0];
    const strong=(top.lift>=1.5&&top.h>=3);
    h+='<div class="fr-ax">'+esc(ax.t)
      +'<b class="'+(strong?"fr-yes":"fr-no")+'">'
      +(strong?"偏りあり":"大きな偏りなし")+'</b>'
      +'<span class="fr-bs">全体の該当率 '+r.base.toFixed(1)+'%</span></div>'
      +'<table class="fl-t fr-t fr-tw"><thead><tr><th>'+esc(ax.t)+'</th><th>該当/全体</th>'
      +'<th>該当率</th><th>平均差枚</th></tr></thead><tbody>'
      +r.rows.slice(0,3).map(x=>'<tr><td class="fr-k">'
        +esc(ax.k==="pg"?(POSG[x.k]||x.k):x.k)+'</td>'
        +'<td>'+x.h+' / '+x.a+'台</td>'
        +'<td class="'+(x.lift>=1.5?"fl-p":"")+'">'+x.rt.toFixed(1)+'%</td>'
        +'<td class="'+cl(x.ag.av)+'">'+sv(x.ag.av)+'</td></tr>').join("")
      +'</tbody></table>';
  });
  // ③ 曜日ごとの出方(その期間に2曜日以上あるときだけ)
  const dh=repDow(hits,per), da=repDow(all,per);
  const wds=["月","火","水","木","金","土","日"].filter(w=>dh[w]&&dh[w].n);
  if(wds.length>=2){
    h+='<div class="fr-s">③ 曜日ごとの出方（該当台）</div>'
      +'<table class="fl-t fr-t"><thead><tr><th>曜日</th><th>該当台の平均</th>'
      +'<th>全体の平均</th><th>台日</th></tr></thead><tbody>'
      +wds.map(w=>{
        const a=Math.round(dh[w].s/dh[w].n);
        const b=(da[w]&&da[w].n)?Math.round(da[w].s/da[w].n):null;
        return '<tr><td class="fr-k">'+w+'</td><td class="'+cl(a)+'">'+sv(a)
          +'</td><td class="'+cl(b)+'">'+sv(b)+'</td><td>'+dh[w].n.toLocaleString()
          +'</td></tr>';
      }).join("")+'</tbody></table>'
      +'<div class="fr-note">平均は1台1日あたり。台日＝台数×日数（母数）</div>';
  }
  // ④ おすすめの機種
  const MG=repBy(hits,"nm");
  const mrank=Object.keys(MG).map(k=>({k:k,ag:repAgg(MG[k])}))
    .filter(x=>x.ag.n>=2&&x.ag.av!=null).sort((a,b)=>b.ag.av-a.ag.av);
  h+='<div class="fr-s">④ おすすめの機種（該当2台以上・平均差枚順）</div>';
  h+=mrank.length
    ? ('<table class="fl-t fr-t fr-tw"><thead><tr><th>機種</th><th>台数</th><th>平均差枚</th>'
       +'<th>ﾌﾟﾗｽ率</th></tr></thead><tbody>'
       +mrank.slice(0,5).map(x=>'<tr><td class="fl-n">'+esc(x.k)+'</td><td>'+x.ag.n
         +'台</td><td class="'+cl(x.ag.av)+'">'+sv(x.ag.av)+'</td><td>'+pv(x.ag.plus)
         +'</td></tr>').join("")+'</tbody></table>')
    : '<div class="fr-note">該当が2台以上ある機種がありません（1台ずつ散っています）</div>';
  // ⑤ おすすめの台番
  const byV=hits.filter(x=>typeof x.v==="number").sort((a,b)=>b.v-a.v).slice(0,5);
  const byS=hits.filter(x=>x.plus!=null&&x.days!=null&&x.days>=3)
    .sort((a,b)=>(b.plus-a.plus)||((b.r||0)-(a.r||0))).slice(0,5);
  const dlist=(ttl,arr,f,hd)=>arr.length
    ? ('<div class="fr-s2">'+ttl+'</div><table class="fl-t fr-t fr-t3"><thead><tr><th>台番</th>'
       +'<th>機種</th><th>'+hd+'</th></tr></thead><tbody>'
       +arr.map(x=>'<tr><td class="fl-d">'+daiBtn(x.dai)+'</td><td class="fl-n">'
         +esc(x.nm)+'</td>'+f(x)+'</tr>').join("")+'</tbody></table>')
    : "";
  h+='<div class="fr-s">⑤ おすすめの台番</div>'
    +dlist("差枚が大きい順",byV,x=>'<td class="'+cl(x.v)+'">'+sv(x.v)+'</td>',"差枚")
    +dlist("安定して出ている順（稼働3日以上）",byS,
           x=>'<td>'+pv(x.plus)+' ／ '+pv(x.r)+'</td>',"ﾌﾟﾗｽ率 ／ 出率")
    +'<div class="fr-note">台番を押すと、その条件のグラフで開きます</div>';
  // ⑥ さらに絞るなら
  const sg=repSuggest(hits,now,cur);
  h+='<div class="fr-s">⑥ さらに絞るなら</div>';
  h+=sg.length
    ? ('<table class="fl-t fr-t fr-tw fr-sg"><thead><tr><th>足す条件</th><th>残る台</th>'
       +'<th>平均差枚</th><th></th></tr></thead><tbody>'
       +sg.map((x,i)=>'<tr><td class="fr-k">'+esc(x.lab)+'<em>'+esc(x.how)+'</em></td>'
         +'<td>'+x.ag.n+'台</td>'
         +'<td class="'+cl(x.ag.av)+'">'+sv(x.ag.av)
         +'<span class="fr-up">'+sv(x.up)+'</span></td>'
         +'<td><button type="button" class="fr-go" data-i="'+i+'">足す</button></td>'
         +'</tr>').join("")+'</tbody></table>')
    : '<div class="fr-note">いまの条件から重ねて平均差枚が上がる絞り込みは見つかりませんでした（すでに絞り込めています）</div>';
  h+='<div class="fr-note">母数（台数・台日）の小さいものは偶然で動きます。'
    +'台数の列を必ず一緒に見てください。</div>';
  box.innerHTML=h;
  box._sg=sg;      // 「足す」ボタンから引くために持たせる
}
// レポートの中の操作はまとめて委譲(表は絞り込みのたびに作り直されるため)。
(function(){
  const box=document.getElementById("fRepBox");
  if(!box) return;
  box.addEventListener("click",e=>{
    const t=e.target;
    const go=t&&t.closest?t.closest(".fl-go"):null;
    if(go){ openDaiFromList(String(go.dataset.dai||"")); return; }
    const ad=t&&t.closest?t.closest(".fr-go"):null;
    if(!ad) return;
    const x=(box._sg||[])[parseInt(ad.dataset.i,10)];
    if(!x||!x.set) return;
    // 提案はこの画面の操作そのものなので、**実際の欄やボタンを動かす**
    // (レポートの中だけで別に絞り込むと、パネルの表示と結果が食い違う)。
    if(x.set.sue!=null){
      const b=document.querySelector('#fSue .ch[data-v="'+x.set.sue+'"]');
      if(b) b.click();
    }else if(x.set.pos!=null){
      const b=document.querySelector('#fPos .ch[data-v="'+x.set.pos+'"]');
      if(b) b.click();
    }else if(x.set.num){
      const el=document.getElementById(x.set.num[0]);
      if(el) el.value=String(x.set.num[1]);
      const a=document.getElementById("fApply"); if(a) a.click();
    }
    showToast("条件を足しました",1600);
  });
})();
document.getElementById("fRep").addEventListener("click",()=>{
  const box=document.getElementById("fRepBox"); if(!box) return;
  const b=document.getElementById("fRep");
  if(box.hidden){ paintFilterReport(); box.hidden=false;
    b.textContent="レポートを閉じる";
    box.scrollIntoView({block:"nearest",behavior:"smooth"}); }
  else { box.hidden=true; box.innerHTML=""; box._sg=null;
    b.textContent="傾向分析レポート"; }
});
// ★狙い方別 期待値表はここ(絞り込みパネル)にあったが、2026-08-15夕に
//   **下部バーの「期待値表」ボタン**へ移した(谷川氏指示「AI予想の右側に移設」)。
//   実装は下の「==== 狙い方別 期待値表のパネル ====」を参照。
document.getElementById("fClear").addEventListener("click",()=>{
  FNUM.forEach(id=>{ const el=document.getElementById(id); if(el)el.value=""; });
  document.querySelectorAll("#fSue .ch,#fPos .ch,#fDow .ch,#fToku .ch,#fSet .ch,"
                            +"#fNer .ch")
    .forEach(b=>b.classList.remove("on"));
  // 目押しの前提も未選択へ戻す(2026-08-14・谷川氏指示「チェリーボタンが最初から
  // 選択された状態になっているが最初は未選択にしておいて」)。両方外れていても
  // koLevel() がチェリー狙いへ倒すので、逆算の物差しは決まったままになる。
  document.querySelectorAll("#fKlv .ch").forEach(b=>b.classList.remove("on"));
  fDays.clear(); buildCal();   // 選んだ日も消す(2026-08-12)
  setFPer(PER_DEF.fPer);   // 期間も既定へ(2026-08-11。2026-08-12から1つ)
  clearHits();
  // 曜日の記憶も落とす(2026-08-14)。ここを消し忘れると、絞り込みを解除したあとも
  // カードに「水木のみ」ボタンが残り、条件が無いのに曜日で開いてしまう。
  FDOW=[]; syncMdow();
  syncFPeek(false,0);   // 「島図を見る」も引っ込める(2026-08-14)
  // 自動絞り込み(2026-08-14)に合わせ、空欄ではなく案内文に戻す。
  // 空欄のままだと「壊れて何も出ない」のか「条件が無いだけ」なのか見分けが付かない。
  // 期間も未選択へ戻る(2026-08-14)ので、次に何をすればよいかを書く
  document.getElementById("fCount").textContent="「期間」を選んで条件を入れると、自動で絞り込みます";
  // 一覧も畳んで消す(前の絞り込みの結果が残らないように・2026-08-12)
  const lx=document.getElementById("fListBox");
  if(lx){ lx.hidden=true; lx.innerHTML=""; }
  const lb=document.getElementById("fList");
  if(lb){ lb.disabled=true; lb.textContent="絞り込み台一覧"; }
  // 傾向分析レポートも畳んで消す(2026-08-14。前の絞り込みの分析が残らないように)
  const rx=document.getElementById("fRepBox");
  if(rx){ rx.hidden=true; rx.innerHTML=""; rx._sg=null; }
  const rb=document.getElementById("fRep");
  if(rb){ rb.disabled=true; rb.textContent="傾向分析レポート"; }
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
  syncFtClose("");
}
// 島図に浮かせる「絞り込み解除」(2026-08-12・谷川氏指示「絞り込み中は島図に
// 絞り込み解除ボタンを出す」)。それまでは、光った台を見ている状態から元へ戻すのに
// 絞り込みパネルを開き直して「クリア」を押す必要があった。
// 絞り込みで光っているのか検索で光っているのかで、文言と押したときの動きを変える
// (見た目はどちらも同じ黄色なので、言葉で示さないと何が消えるのか分からない)。
let hitSrc="";
function syncFtClose(src){
  if(src!=null) hitSrc=src;
  const b=document.getElementById("ftClose");
  if(!b) return;
  const on=!!hitSrc && !!document.querySelector(".tap.filt-hit");
  const sea=(hitSrc==="search");
  b.textContent=sea?"✕ 検索を解除":"✕ 絞り込み解除";
  b.setAttribute("aria-label",sea?"検索の光を消す":"絞り込みを解除する");
  b.classList.toggle("show",on);
  // 「絞り込み台一覧」も同じ条件で出す(2026-08-21)。ただし検索で光っているときは出さない
  // (検索は台を光らせるだけで、一覧に出す集計を作っていないため=ボタンも押せない)。
  const lb=document.getElementById("fList");
  const b2=document.getElementById("ftList");
  if(b2) b2.classList.toggle("show", on && !sea && !!lb && !lb.disabled);
  fitTabbar();     // 出し入れで段が変わる(矢印を消すボタンと同じ場所に積むため)
}
(function(){
  const b=document.getElementById("ftClose");
  if(b) b.addEventListener("click",e=>{
    e.stopPropagation();
    // 検索で光っているときは検索側の入口を押す=解除の道すじを1本にする
    const t=document.getElementById(hitSrc==="search"?"sClear":"fClear");
    if(t) t.click();
  });
})();
// 島図の「絞り込み台一覧」(2026-08-21)。絞り込みパネルを開き、一覧が閉じていれば開く。
// ★中身を作る道すじは1本のまま(パネルの #fList を押す)＝一覧の作り方を二度書かない。
(function(){
  const b=document.getElementById("ftList");
  if(!b) return;
  b.addEventListener("click",e=>{
    e.stopPropagation();
    const md=document.getElementById("filterModal");
    if(md){
      md.style.display="block";
      fitFilterModal();
      // 台番カードと同じ保険: 開いた直後は可視領域がまだ確定していないことがある
      requestAnimationFrame(()=>{ if(md.style.display==="block") fitFilterModal(); });
    }
    const box=document.getElementById("fListBox");
    const lb=document.getElementById("fList");
    if(box&&box.hidden&&lb&&!lb.disabled){ lb.click(); return; }
    if(box&&!box.hidden) box.scrollIntoView({block:"nearest"});
  });
})();
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
  // **光を付け終わってから**呼ぶ(中で .filt-hit の有無を見て出し入れを決めるため)
  syncFtClose("search");
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
// 「元の画面に戻る」の戻り先(2026-08-14夕・谷川氏指示「元に戻すというより元画面に
// 戻るボタンにしてください」)。台入替の内訳から光らせた/矢印を出したときだけ入る。
// 中身は消さずに隠しているだけなので、開き直すと**見ていた位置のまま**戻る。
// 島図の機種名ラベルから直に光らせたときは戻り先が無いので、従来の言い方のままにする。
// ★clearMove より**前**で宣言する。let は巻き上げされないので、後ろに置くと
//   clearMove が先に走ったときに「初期化前に参照した」で初期化ごと落ちる
//   (2026-08-02に urlLock で実際に踏んでいる)。
// ★受け渡しに2本使う。showLights()/showMove() は**冒頭で clearMove() を呼ぶ**ので、
//   1本だけだと渡した先から消される。mvBackNext(先に置いておく控え)は clearMove では
//   触らず、showMvClose が mvBack へ移し替えて使い切る。
let mvBack=null, mvBackNext=null;
function setMvBack(fn){ mvBackNext=fn||null; }
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
  // 戻り先は1回きり(2026-08-14夕)。ここで捨てないと、次に島図のラベルから
  // 光らせたときにも「元の画面に戻る」と出て、関係のない一覧が開いてしまう。
  mvBack=null;
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
  // 控えてあった戻り先をここで受け取って使い切る(無ければ戻り先なし=従来の言い方)
  mvBack=mvBackNext; mvBackNext=null;
  const txt=mvBack?"元の画面に戻る":label;
  b.textContent="✕ "+txt;
  b.setAttribute("aria-label",txt);
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
  // ★時間切れの自動解除はしない(2026-08-15夕・谷川氏指示「光らせたり、矢印だしたときに
  //   決まった秒数で自動解除しないようにして、手動解除のみにする」)。
  //   経緯: 2026-08-05に14秒の時間切れを入れていた(消し忘れ対策)。見ている途中で
  //   勝手に消えるほうが困る、という判断でここを外した。
  //   消し方は「✕ 矢印を消す / 元に戻す / 元の画面に戻る」のボタンだけ。
  //   showMvClose() が必ずそのボタンを出すので、閉じ込められることはない。
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
// word は現在地チップの言い方の差し替え(2026-08-14夕)。道すじも引ける増台/減台では
// 「増台/減台」と書くと台数の増減と読み違えるので「今の台番/元の台番」に差し替える。
function showLights(dais, name, kind, word) {
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
  // ★時間切れの自動解除はしない(2026-08-15夕・谷川氏指示)。矢印(showMove)と同じ扱い。
  //   光らせたまま島図をゆっくり見られるようにする。消すのはボタンだけ。
  const chip=document.getElementById("whereChip");
  // 何を光らせているのかを言葉でも出す(2026-08-14に新台・パチンコ新台を追加。
  // 新台を「増台」と書くと、元から有って増えた機種と読み違える)。
  const kw=word?(" の"+word+" ")
          :(kind==="minus")?" の減台 "
          :(kind==="new"||kind==="pachi")?" の新台 ":" の増台 ";
  if(chip){ chip.textContent=name+kw+dais.length+"台";
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
// 光らせる台番の呼び方(区分ごと)。2026-08-14に新台・パチンコ新台を追加。
const LIT_WORD={new:"新台の台番",pachi:"新台の台番",
                plus:"増えた台番",minus:"減った台番"};
// 道すじ(矢印)も引ける機種のときの言い方(2026-08-14夕)。島ごと引っ越して台数も変わった
// 機種は dai=今この機種が居る全台番 / gone=元に居た全台番なので、「増えた台番(40台)」と
// 書くと増えた差分(からくり2なら+2台)と読み違える。
const LIT_WORD_MV={plus:"今の台番",minus:"元の台番"};
function litWord(k,hasMv){
  return (hasMv&&LIT_WORD_MV[k])||LIT_WORD[k]||"該当する台番";
}
// 機種名から出せる選択肢を組み立てる。入替の動きが無い機種は null(=スペックを直に開く)。
// 2026-08-14夕・谷川氏指示「増台、減台も同じく光らせると機種ページ選択できるように」:
// **道すじが引ける増台/減台でも「光らせる」を必ず並べる**(最大3つ)。それまでは矢印を
// 優先して光らせる側を捨てていたため、からくりサーカス2・北斗・ヴヴヴ2・ゴッドイーター・
// スーパーリオエース2 の5機種だけ光らせる道が無かった(実データで確認)。
// 並びは「機種ページ → 矢印 → 光らせる」。1つ目は必ず機種スペックにする
// (器が無い古いHTMLを掴んだときに pickAction が先頭をそのまま実行するため、
//  何も知らせず盤面が暗くなるより機種ページが開くほうが安全)。
function actChoices(nm,mv,li){
  const ch=[{t:"機種スペックを見る",r:()=>openSpec(nm)}];
  if(mv&&mv.t&&mv.t.length)
    ch.push({t:"元の位置→今の位置を矢印で見る（"+mv.t.length+"台）",
             r:()=>showMove(mv.f,mv.t,nm)});
  if(li&&li.d&&li.d.length){
    const w=litWord(li.k,!!(mv&&mv.t&&mv.t.length));
    ch.push({t:w+"を光らせる（"+li.d.length+"台）",
             r:()=>showLights(li.d,nm,li.k,(w===LIT_WORD[li.k])?"":w)});
  }
  return ch.length>1?ch:null;
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
          if(it.from&&it.from.length&&it.dai&&it.dai.length)
            MOVES[k]={f:it.from,t:it.dai,n:it.name};
          // ★ここで return しない(2026-08-14夕・谷川氏指示「増台、減台も同じく
          //   光らせると機種ページ選択できるように」)。それまでは道すじが引ける機種を
          //   優先して打ち切っていたので、島ごと引っ越した増台/減台(からくりサーカス2など)
          //   は LIGHTS に載らず、島図の機種名からは光らせられなかった。
          //   区分が「移動台」の機種は下の判定に当たらないので、今までどおり矢印だけになる。
          // 光らせる台番は区分ごとに決める(2026-08-05・谷川氏指示)。
          //   増台 … その日にこの機種になった台番(dai)が増えた台
          //   減台 … その日にこの機種でなくなった台番(gone)が減った台
          //   新台 … その日に入った台番(dai)。2026-08-14に追加(谷川氏指示
          //          「台入替内の新台の機種を押すと島図の該当箇所が光るように」)。
          //          島図の機種名ラベルを押したときも同じ選択肢が出るよう、
          //          台入替パネル側だけでなくこちらの台帳にも入れる。
          if((c.key==="plus"||c.key==="new"||c.key==="pachi")&&it.dai&&it.dai.length)
            LIGHTS[k]={d:it.dai,n:it.name,k:c.key};
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
  // ★一覧は2か所に出す(検索パネルの中と、島図の「★一覧」パネル・2026-08-20夕)。
  //   描き方を1つにしておけば、片方だけ古いということが起きない。
  document.querySelectorAll(".pinlist").forEach(box=>{
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
        // どちらのパネルから押されても閉じる(2026-08-20夕に★一覧を新設したため)
        const sm=document.getElementById("searchModal");
        if(sm) sm.style.display="none";
        const pm=document.getElementById("pinModal");
        if(pm) pm.style.display="none";
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
  });
  // 「すべて外す」も一覧と同じ数だけある(検索パネルと★一覧パネル)。
  document.querySelectorAll(".pinclr").forEach(pc=>{ pc.hidden=!pins.length; });
  if(!pins.length) pinAskOff();
  const btn=document.getElementById("pinBtn");
  if(btn&&curDai) btn.classList.toggle("is-on",pins.indexOf(String(curDai))>=0);
  paintPinHl(pins.length);   // 左下のオンオフボタンの見た目(2026-08-20)
  paintPinLs(pins.length);   // 左下の「★一覧」の件数(2026-08-20夕)
}
// ---- ピン強調のオンオフ(2026-08-20・谷川氏指示) ----
// 島図のピン留めは常時「白+黒の二重罫」で控えめに出している(2026-08-02に光彩を外した
// 経緯があるため既定はこのまま)。そのうえで「今より目立たせたい」ときだけ押して光らせる。
// 状態は端末に覚えさせる(次に開いたときも同じ)。★盤面は貼り替えないので、
// 押しても見ている場所・拡大倍率は動かない(class を1つ付け外しするだけ)。
// ★PINHL_KEY の宣言はスクリプト前方(pinAskTimer の隣)。ここで const を書くと
//   初期化中の paintPins() から呼ばれた時点でTDZになり、画面ごと落ちる。
function pinHlOn(){ try{ return localStorage.getItem(PINHL_KEY)==="1"; }catch(e){ return false; } }
function paintPinHl(n){
  const on=pinHlOn();
  document.body.classList.toggle("pinhl",on);
  const b=document.getElementById("pinHl");
  if(!b)return;
  if(n===undefined) n=loadPins().length;
  b.classList.toggle("is-on",on);
  b.classList.toggle("empty",!n);
  b.setAttribute("aria-checked",on?"true":"false");
  const st=b.querySelector(".st"); if(st) st.textContent=on?"ON":"OFF";
}
(()=>{
  const b=document.getElementById("pinHl");
  if(!b)return;
  b.addEventListener("click",e=>{
    e.stopPropagation();
    const on=!pinHlOn();
    try{ localStorage.setItem(PINHL_KEY,on?"1":"0"); }catch(err){}
    const n=loadPins().length;
    paintPinHl(n);
    if(on) showToast(n?("ピンの"+n+"台を光らせます"):"ピン留めした台がまだありません",1800);
    else showToast("ピンの強調を消しました",1400);
  });
})();
// ---- ピン留め一覧のボタンとパネル(2026-08-20夕・谷川氏指示「島図にピン留め一覧の
//      ボタンを常に固定で出しておいて」) ----
// 一覧は検索パネルの下端にもあるが、そこへ行くには検索を開いて下までスクロールが要った。
// 島図から1タップで開けるようにする。中身は #pinList と同じ描き方(paintPins が
// .pinlist をまとめて描く)なので、片方だけ古くなることがない。
// ★件数をボタンに出す=開く前に「いま何台留めてあるか」が分かる。
function paintPinLs(n){
  const b=document.getElementById("pinLs");
  if(!b)return;
  if(n===undefined) n=loadPins().length;
  const c=b.querySelector(".ct");
  if(c) c.textContent=String(n);
  b.classList.toggle("empty",!n);
}
function fitPinModal(){
  positionOverlayCard(document.getElementById("pinCard"),pcTwo()?520:340);
}
(()=>{
  const b=document.getElementById("pinLs"), md=document.getElementById("pinModal");
  if(!b||!md)return;
  b.addEventListener("click",e=>{
    e.stopPropagation();
    paintPins();                 // 開く直前に最新の中身にする
    md.style.display="block";
    fitPinModal();
    // 台番カードと同じ保険: 開いた直後は可視領域がまだ確定していないことがある
    requestAnimationFrame(()=>{ if(md.style.display==="block") fitPinModal(); });
  });
  const cl=document.getElementById("pinLsClose");
  if(cl) cl.addEventListener("click",()=>{ md.style.display="none"; });
  md.addEventListener("click",e=>{ if(e.target.id==="pinModal") md.style.display="none"; });
})();
// 「すべて外す」は取り返しがつかないので2度押しにする(端末の確認ダイアログは使わない=
// PWAでは唐突に見えるため)。1度目は文言が変わり、3.5秒で元に戻る。
// **タイマーの宣言はスクリプト前方**(urlLockの隣)。paintPins()は初期化中の
// applyPeriod()からも呼ばれるので、ここでletを宣言するとTDZで初期化ごと落ちる。
function pinAskOff(){
  clearTimeout(pinAskTimer); pinAskTimer=0;
  document.querySelectorAll(".pinclr").forEach(pc=>{
    pc.classList.remove("ask"); pc.textContent="すべて外す";
  });
}
document.querySelectorAll(".pinclr").forEach(pc=>{
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
});
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
  // ★午前中のデータが届いたら、更新の時刻をそちらに合わせる(2026-08-18・谷川氏報告
  //   「今日の午前中のデータとれてボタン押せるようになってる状態なのに
  //    更新の時間が更新されてないの？」)。
  //   島図のデータ(last7.data.js)は夜に作るので GENAT は明け方のまま動かないが、
  //   午前中(hiru.json)は12:30過ぎに別で届く。画面に出ている**いちばん新しい**
  //   データの時刻を出すのが読み手の期待に合う。押したときの吹き出しには両方書く。
  let full=base;
  // 起動して少ししてから午前中の分を1回だけ見に行く(2026-08-18)。
  // 押すまで読まない作りだったので、開いた時点では時刻が夜のままだった。
  // 初回描画の邪魔をしないよう後回しにし、取れなくても何も起きない。
  setTimeout(()=>{ try{ if(typeof ensureHiruData==="function") ensureHiruData(); }
                   catch(e){} }, 1500);
  // 「8/20 12:30」の形を比べられる数にする(2026-08-20夕)。年はまたがない
  // (作り直しはその日のうち)ので、月日と時刻だけで足りる。読めなければ -1。
  const stampMin=(s)=>{
    const m=/^(\d+)\/(\d+)\s+(\d+):(\d+)/.exec(String(s||""));
    if(!m) return -1;
    return ((+m[1])*31+(+m[2]))*1440+(+m[3])*60+(+m[4]);
  };
  window.markHiruStamp=(j)=>{
    if(ready||!j||!j.date||!j.at) return;
    const md=String(j.date).split("-");
    const at=(md.length===3?(Number(md[1])+"/"+Number(md[2])+" "):"")+j.at;
    full=base+" ／ 午前中 "+at+" 時点";
    // ★出すのは**いちばん新しい方**(2026-08-20夕・谷川氏指示「本番更新した時は
    //   時間も更新する」)。午前中の時刻で必ず上書きしていたため、昼すぎに本番へ
    //   出し直しても行は「12:30 更新（午前中）」のままで、更新したのに時刻が
    //   戻ったように見えていた。
    //   ・夜に作って12:30に午前中が届く(通常) … 午前中の方が新しい=今までどおり
    //   ・昼以降に作り直した … 作り直した時刻(GENAT)の方が新しい=そちらを出す
    //   どちらの場合も、行を押したときの吹き出しには両方の時刻が出る。
    if(stampMin(at)>stampMin(GENAT)){
      el.textContent="データ "+DATADAY+"分まで反映 ／ "+at+" 更新（午前中）";
    }
    if(typeof fitBar==="function") fitBar();
  };
  const toNew=()=>{
    if(ready)return;
    ready=true;
    el.classList.add("is-new");
    el.textContent="新しいデータがあります ／ タップで表示";
    fitBar();
  };
  el.addEventListener("click",()=>{
    if(ready) location.reload();
    else showToast(full,2600);
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
  // 内訳(iretae.json)が「どの日の入替のものか」。読めた時点で覚える(2026-08-17)。
  // これが分かると「予定を出すか・実施済みの内訳を出すか」を日付の当てずっぽうでなく
  // **中身が届いているか**で決められる(下の future を参照)。
  let IR_DATE=null;
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
    // ★これから来る入替の「予定」を、前回の内訳と**同じ見た目のカード**で出す
    //   (2026-08-16・谷川氏指示「新台と増台の機種を前回の8/3の時と同じように
    //   新台入替を検知したら事前に出しておく」)。
    //   それまでは文字だけの一覧で、しかも内訳が読めた時点で消されていた
    //   (下の「旧リストは消す」が未来の入替でも走っていた)ため、実機では
    //   見出しだけが残って中身が何も出ていなかった。
    //   区分の名前と色は内訳(build_iretae_detail.py の CATS)に合わせる。
    //   ★減台は出さない(入替前は分からないため・谷川氏の指定)。
    const planCat=(label,color,arr,cls)=>{
      if(!arr.length) return "";
      const tot=arr.reduce((a,i)=>a+(i.n||0),0);
      const cards=arr.map(i=>{
        const pic=i.img
          ? '<img src="'+esc(asrc("kishu/"+i.img))+'" alt="" loading="lazy" decoding="async">'
          : '<span class="noimg">画像なし</span>';
        // 増台は入替前の台数が分からないので「計◯台」のまま出す
        // (内訳の「◯→◯台」は実績が出てから)
        return '<li class="icard" data-n="'+esc(i.name)+'">'
          +'<span class="ipic">'+pic+'</span>'
          +'<span class="iname">'+esc(i.name)+'</span>'
          +'<span class="inum">'+(i.add?"計":"")+i.n+'台</span></li>';
      }).join("");
      // 増台の合計は「入替後の総台数」なので足し上げても意味がない。件数だけ出す
      const cnt=arr.some(i=>i.add)? (arr.length+"機種")
                                  : (arr.length+"機種 "+tot+"台");
      return '<div class="icat '+(cls||"")+'"><div class="ihead" style="--ic:'
        +color+'"><span class="ibadge">'+esc(label)+'</span>'
        +'<span class="icnt">'+cnt+'</span></div>'
        +'<ul class="ilist">'+cards+'</ul></div>';
    };
    const planCards=(d)=>{
      const s=(d.slot||[]), p=(d.pachi||[]);
      return planCat("新台","#c62828",s.filter(i=>!i.add),"n-plan")
            +planCat("増台","#1f5fb4",s.filter(i=>i.add),"n-plan")
            +planCat("パチンコ新台","#7b5ea7",p.filter(i=>!i.add),"n-plan");
    };
    const d=n.detail||{pachi:[],slot:[]};
    // ★これから来る入替か(2026-08-15夕・谷川氏報告「8/17新台入替を押したら過去の
    //   入替の画面がでてくる」)。原因は、見出しは告知(8/17)なのに、中身へ差し込む
    //   内訳(iretae.json)が**前回すでに実施された入替**のものだったこと。
    //   台数も合わない(告知14機種46台に対し、内訳は新台6機種72台…)。
    //   直し方: これから来る入替のときは
    //     (1) その日に入る予定(告知の detail)を**先に**出す
    //     (2) 内訳は後ろへ回し、「前回 M/D の内訳」と日付を明記する
    //   ★内訳そのものは消さない。資料の「台入替」から開いたときの中身でもあるため。
    //   ★当日(dayDiff===0)も「これから」に含める(2026-08-17・谷川氏報告
    //     「台入替の情報が前回の台入替の情報になってる。8/17の情報消えてるよ」)。
    //     入替は朝9〜12時に行われ、島図がその配置になるのは**その夜の更新から**なので、
    //     当日の日中に読める内訳(iretae.json)はまだ前回のもの。ここを ">0" にしていたため、
    //     日付が変わった瞬間に予定のカードが消えて前回の内訳だけになっていた。
    //     ★2026-08-17 追記: 上の ">=0" は「当日の日中は島図がまだ前の配置」を前提に
    //       していたが、入替当日の日中に島図を更新する運用にしたので前提が崩れた
    //       (更新済みなのに「これから入る予定」のカードが出てしまう)。
    //       そこで**内訳が当日ぶんに入れ替わったかどうか**で決める。
    //       内訳がまだ前回のものなら従来どおり予定を出す。
    const dd=(dayDiff(n.date)||0);
    const future=dd>0 || (dd===0 && IR_DATE!==n.date);
    const plan=sec("スロット",(d.slot||[]),"n-slot")
              +sec("パチンコ",(d.pachi||[]),"n-pachi");
    const planC=planCards(d);
    // 右上にも閉じるボタンを置く(2026-08-04・谷川氏指示「閉じるボタンを右上にも作る」)。
    // 内訳は縦に長いので、下まで送らないと閉じられないのは手間。台番カードの「✕ 閉じる」と
    // 同じ見た目・同じ位置にして、押す場所を覚え直さなくて済むようにする。
    document.getElementById("noticeCard").innerHTML=
      '<button class="nclose ntop" aria-label="閉じる">✕ 閉じる</button>'
      +"<h3>"+esc(n._head||n.title)+"</h3><div class='nsum'>"+esc(n.summary||"")+"<br>"
      // 入替が済んでいるときは「島図の配置も更新済み」をここで伝える(見出しは1行に保つ)
      +(!future?"島図の配置も更新済みです。<br>":"")
      +esc(n.note||"")+"</div>"
      +(future
        ? ((planC?('<div class="nsec2">この日に入る予定（ホール告知）'
                   +'<span>（台番は入替の当日に決まります）</span></div>'
                   +'<div id="nplan">'+planC+'</div>'):"")
           +'<div id="iretae"></div>')
        : ('<div id="iretae"></div>'+plan))
      +'<button class="nclose">閉じる</button>';
    // 予定のカードも押したらスペックが開く(内訳のカードと同じ扱い・2026-08-16)。
    // ★台番はまだ決まっていないので「光らせる」「矢印」は出さない=スペックだけ。
    const np=document.getElementById("nplan");
    if(np) np.addEventListener("click",e=>{
      const li=e.target.closest && e.target.closest(".icard");
      if(li && li.dataset.n) openSpec(li.dataset.n);
    });
    // 入替の内訳(新台・増台・減台・移動台・撤去台)を筐体画像つきで出す(2026-08-04・
    // 谷川氏指示「新台の情報のみではなく増台減台撤去台の情報ものせて」)。
    // **後から差し込む**=iretae.jsonが取れなくても、従来の新台一覧はそのまま出る。
    fetch("iretae.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(ir=>{
      const host=document.getElementById("iretae");
      if(!ir||!ir.cats||!ir.cats.length||!host) return;
      // 内訳の日付を覚え、判定が変わるなら組み立て直す(2026-08-17)。
      // 入替当日の日中に島図を更新すると、内訳も当日ぶんに入れ替わる。その時は
      // 「これから入る予定」ではなく実施済みの内訳を先に出すのが正しい。
      // ★組み立て直しは1回だけ。IR_DATE を先に入れてから呼ぶので、次の回は
      //   future の値が変わらず、ここへ戻ってきても再帰しない。
      if(ir.date && IR_DATE!==ir.date){
        const was=IR_DATE; IR_DATE=ir.date;
        if(was===null && future && ir.date===n.date){ open(n); return; }
      }
      // 告知が無い時期に「台入替」ボタンから開いた場合、見出しが空のままになる。
      // 内訳が持っている入替日から作り直す(2026-08-04)。
      if(!(n._head||n.title) && ir.date){
        const h=document.querySelector("#noticeCard h3");
        if(h) h.textContent=mdw(ir.date)+" 新台入替の内訳";
      }
      // ★これから来る入替のときは、内訳が**いつのものか**を必ず書く(2026-08-15夕)。
      //   書かないと、8/17の告知を開いたのに前回の内訳を8/17のものと読んでしまう。
      const irBody=ir.cats.map(c=>{
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
          // 2026-08-14(谷川氏指示「台入替内の新台の機種を押すと島図の該当箇所が
          // 光るようにしてください」): **新台とパチンコ新台も**その台番を光らせる。
          // それまでは増台と減台にしか光らせる道が無く、新台はスペックしか開けなかった。
          // 撤去台(out)は入れない。dai に入っているのは「撤去された台番」で、いまその場所は
          // 別の機種になっているため、光らせると別物を指してしまう。
          const lt=(c.key==="minus")?(it.gone||[])
            :(c.key==="plus"||c.key==="new"||c.key==="pachi")?(it.dai||[]):[];
          // 2026-08-14夕(谷川氏指示「増台、減台も同じく光らせると機種ページ選択できる
          // ように」): **道すじが引ける機種でも光らせる台番を持たせる**。
          // それまでは矢印を出せる機種で打ち切っていたので、島ごと引っ越した
          // 増台/減台(からくりサーカス2など5機種)は光らせる選択肢が出なかった。
          const lit=lt.length
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
      // ★これから来る入替を見ているときは、**過去の入替の内訳を折りたたむ**
      //   (2026-08-16・谷川氏指示「過去の新台入替は折りたたんでおくこと」)。
      //   知りたいのはこれから入る台なのに、過去の内訳が5分類ぶん開いたままだと
      //   縦に長く、予定を読んだあと延々とスクロールすることになる。
      //   ★中身は消さない。見出しを押せば今までどおり全部見られる。
      //   過去の入替そのものを見に来たとき(資料の「台入替」など)は開いたままにする。
      host.innerHTML=future
        ? ('<details class="ipast"><summary>前回 '
           +esc(ir.date?mdw(ir.date):"")+' の入替の内訳'
           +'<span>（実際に入れ替わった台。上の予定とは別のものです）</span>'
           +'</summary>'+irBody+'</details>')
        : irBody;
      // 内訳のカードも押すと要点スペックを出す(2026-08-04・台番カードの写真と同じ扱い)。
      host.addEventListener("click",e=>{
        const li=e.target.closest && e.target.closest(".icard");
        if(!li) return;
        // **カードのどこを押しても選択肢を出す**(2026-08-14夕・谷川氏指示
        // 「タップして反応してスペックをみると光らせる範囲の画面表示を赤枠の範囲にして
        //   欲しい。今は機種名を正確にタップしないとでないため」)。
        // それまでは機種名(.iname)だけが選択肢の当たり判定で、写真や台数を押すと
        // スペックが直に開いていた(2026-08-04の作り)。指で押す端末では機種名の帯が
        // 細く、狙って当てるのが難しかった。
        // 入替の動きが無い機種は今までどおりスペックを直に開く(下の openSpec)。
        const nm=li.dataset.n||"";
        if(li.dataset.mvTo||li.dataset.lit){
          const mv=(li.dataset.mvFrom&&li.dataset.mvTo)
            ? {f:li.dataset.mvFrom.split(","),t:li.dataset.mvTo.split(",")} : null;
          const lt=li.dataset.lit
            ? {d:li.dataset.lit.split(","),k:li.dataset.lk} : null;
          const ch=actChoices(nm,mv,lt);
          if(ch){
            // 場所を見る方を選んだら、内訳の画面を閉じてから島図を見せる。
            // **2つめ以降すべてを包む**(2026-08-14夕)。選択肢が3つになったので、
            // ch[1] だけを包むと「光らせる」を選んだときに内訳の画面が残り、
            // 島図が光っているのに手前の一覧で隠れる。
            for(let i=1;i<ch.length;i++){
              const orig=ch[i].r;
              ch[i]={t:ch[i].t,r:()=>{
                const m=document.getElementById("noticeModal");
                if(m) m.style.display="none";
                // 逃げ道のボタンを「元の画面に戻る」にして、押したらこの一覧へ返す
                // (2026-08-14夕・谷川氏指示)。**orig() より前に渡す**
                // = showMvClose が言い方を決めるときに戻り先を見るため。
                setMvBack(()=>{
                  const m2=document.getElementById("noticeModal");
                  if(m2) m2.style.display="block";
                });
                orig();
              }};
            }
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
  // 「台入替」の入口(2026-08-04新設)。告知帯は入替の前後だけ出る一時的な物なので、
  // いつでも内訳を開ける入口を常設する。告知が無ければ iretae.json だけで開く。
  // ★2026-08-15夕に**下部バーから資料へ移した**(谷川氏指示)。開く物は同じなので、
  //   ここでは「開く関数」と「内訳が有るか」を外へ出すだけにして、
  //   ボタンの置き場所は資料側(buildDocs)に持たせる。
  let cur=null;
  window.openIretae=()=>open(cur||{});
  window.iretaeReady=false;
  fetch("iretae.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(ir=>{
    window.iretaeReady=!!(ir&&ir.cats&&ir.cats.length);
    // 資料を開いたままのときは、その場でボタンを押せるようにする
    const b=document.getElementById("docsIretae");
    if(b) b.disabled=!window.iretaeReady;
  }).catch(()=>{});
  const load=()=>fetch("notice.json",{cache:"no-store"})
    .then(r=>r.ok?r.json():null).then(n=>{ cur=n||null; show(n); }).catch(()=>{});
  if(window.requestIdleCallback) requestIdleCallback(load,{timeout:5000});
  else setTimeout(load,1800);
})();
// オプチャ情報(2026-08-04・谷川氏指示「オプチャ情報ボタンを台入替の右側に設置」)。
// トリノメ(LINEオープンチャットの監視ビューア)の熱田だけを開く。別アプリなので
// 新しいタブで開き、島図の状態(拡大位置・絞り込み)を失わないようにする。
// ★2026-08-14(谷川氏報告「PCブラウザでオプチャ情報をクリックすると、シマヒートの
//   ページが消えてトリノメになる」)。原因は window.open の**戻り値の仕様**。
//   noopener を付けた window.open は、新しいタブがちゃんと開いても null を返す
//   (chromium/webkit の両方で実測。どちらもタブは2枚に増えていた)。
//   そのため「開けなかったときの逃げ道」として書いていた location.href が毎回走り、
//   新しいタブを開いたうえで**今のタブも移動する**動きになっていた。
//   直し方は a要素を作って押す形。新しいタブが必ず開き、今のタブは絶対に移動しない。
//   ホーム画面から起動したPWAでも、島図を残したまま外のブラウザで開く。
(()=>{
  const b=document.getElementById("opechatBtn");
  if(!b)return;
  const url="https://opechat-viewer.pages.dev/?store="
    +encodeURIComponent("プレイランドキャッスル熱田");
  b.addEventListener("click",()=>{
    const a=document.createElement("a");
    a.href=url; a.target="_blank"; a.rel="noopener noreferrer";
    a.style.display="none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
})();
// ---- AI予想ランキング(2026-08-14新設・谷川氏指示) ----
// 「オプチャ情報の右側にAI予想ランキングのボタン追加。開くと当日のAT機、ノーマル機
//  それぞれでTOP10の機種を根拠、高配分確率、着地予測出率をだす。そして機種を押すと
//  その中でもTOP10の台番を根拠、高配分確率、着地予測出率を出す」。
//
// ★出せないものは出さない。ホールが入れた設定は公表されないので「高配分確率」は
//   原理的に計算できない。そこで**計算できる実績に置き換え、名前も実態に合わせた**
//   (谷川氏が案Bを選択・2026-08-14):
//     高配分確率   → 「高出率だった割合」＝ 出率103%以上だった台日 ÷ 全台日
//     着地予測出率 → 「出率の中央値」    ＝ 台日ごとの出率の中央値
//                    (平均だと1台の大勝ちで跳ねるので中央値を使う)
//     根拠         → 母数(台数・日数・台日)と、全体との差を1行で添える
// 「同じ条件の日」は予想する日の曜日。今日が特定日ならその特定日でも見られるようにするが、
// **曜日と特定日は重ねない**(重ねると1〜2日しか残らず母数が壊れる。66日のうち
//  曜日ごとは9〜10日・「8のつく日」は8〜9日あるが、その積は1〜2日しかない)。
// 計算はすべて手元の DATA と KOYAKU から直接行う(新しい取得はしない)。
const AI_HI=103.0;        // 「高出率」の線(客側にはっきりプラス)
const AI_MIN_N=20;        // 機種の母数の下限(台日)
// ★日数の下限。**台日だけでは足りない**(2026-08-14の試作で実際に踏んだ)。
// 8/5入替の新台が「42台×1日=42台日」で母数が厚く見え、金曜の6位に入ってしまった。
const AI_MIN_DAY=3;
const AI_MIN_DAI_N=3;     // 台番の母数の下限(台日)。1台あたり9〜10台日しか無い
function aiMed(a){
  const s=a.slice().sort((x,y)=>x-y), n=s.length;
  if(!n) return null;
  return (n%2)?s[(n-1)/2]:((s[n/2-1]+s[n/2])/2);
}
function aiDow(lab){ return (/\(([^)]+)\)/.exec(lab||"")||[])[1]||""; }
// 予想する日=今日(端末の時計)。データは前日までしか無いので、今日の曜日で過去を見る。
function aiToday(){
  const d=new Date();
  return {mo:d.getMonth()+1, da:d.getDate(), wd:"日月火水木金土".charAt(d.getDay())};
}
function aiTodayLab(){ const t=aiToday(); return t.mo+"/"+t.da+"("+t.wd+")"; }
// 当日の一桁から作る「◯のつく日」の呼び方(2026-08-14夕)。10日・20日・30日は
// 一桁が0なので「0のつく日」になる(これも区切りとして実在する言い方)。
function aiDgtName(){ return (aiToday().da%10)+"のつく日"; }
// 今日が当てはまる特定日(ゾロ目＋この店の特定日)。絞り込みの #fToku と同じ台帳を使う。
function aiTokuToday(){
  const lab=aiTodayLab();
  const list=[{k:"zoro",n:"ゾロ目の日"}].concat(
    ((typeof SHIMA!=="undefined"&&SHIMA.ftoku)||[]).map(t=>({k:t.k,n:t.n})));
  return list.filter(t=>isToku(lab,t.k));
}
// 集計する日の添字。曜日 / 特定日 / 全部の日 の3通り。
function aiIdx(mode){
  const L=DATA.labels||[], out=[], t=aiToday();
  // 「AI予想」は材料を自前で組み合わせる(aiPredRows)。ここでは母数の表示に使う
  // 全期間を返す(2026-08-14夕)。
  let md=mode||"dow";
  if(md==="ai") md="all";
  L.forEach((lab,i)=>{
    if(md==="all"){ out.push(i); return; }
    if(md==="dow"){ if(aiDow(lab)===t.wd) out.push(i); return; }
    // 当日の一桁と同じ日=「4のつく日」(2026-08-14夕・谷川氏指示「14日のみは削除、
    // 代わりに4のつく日=当日の一桁日」)。例: 今日が8/14なら 4日・14日・24日。
    // それまでは同じ日付だけ(14日だけ)を見ていたが、月に1日しか当たらず母数が薄かった。
    // 「◯のつく日」はホールの入れ方の癖としてよく使われる区切りでもある。
    if(md==="dgt"){
      const m=/^(\d+)\/(\d+)/.exec(lab||"");
      if(m&&(parseInt(m[2],10)%10)===(t.da%10)) out.push(i);
      return;
    }
    if(md.indexOf("toku:")===0&&isToku(lab,md.slice(5))) out.push(i);
  });
  return out;
}
// ★AT機とノーマル機の見分け(2026-08-14に作り直し・谷川氏指摘「オキドキはノーマル機
//   ではない」)。それまでは**回数(BB・RB)の記録があるか**で分けていたが、回数の蓄積は
//   ジャグハナ／BT機／技術介入機の3冊から作っているので、沖ドキ！BLACK や
//   スマスロ東京リベンジャーズ(どちらもAT機)までノーマル側に入っていた。
//   いまは p-town の機種ページに付いているタイプの旗から決める
//   (生成側 make_heat_html.load_ktype が SHIMA.ktype に入れる)。
//   遊技未来のスペック文がある43機種と突き合わせて全件一致することを確認済み。
//     at … ATやARTで出玉を増やす機械
//     nm … ボーナスで出玉を得る機械(Aタイプ・BT機)
//   旗が取れていない機種は "" になる。**どちらかへ勝手に寄せない**
//   (分からないものを分かったように並べない。画面には除いた数を出す)。
const KTYPE=(typeof SHIMA!=="undefined"&&SHIMA&&SHIMA.ktype)||{};
function aiKind(nm){ return ((KTYPE[nm]||{}).t)||""; }
function aiKindWhy(nm){ return ((KTYPE[nm]||{}).w)||""; }
// 台日ごとの出率を集めて束ねる。keyOf でまとめ方(機種名/台番/末尾/位置区分)を変える。
// **1台1日を1件**として数えるので、台数の多い機種が有利にも不利にもならない。
function aiCollect(idx,keyOf,want){
  const o={};
  Object.keys(DATA.machines).forEach(dai=>{
    const m=DATA.machines[dai]||{};
    if(want&&!want(dai,m)) return;
    const k=keyOf(dai,m);
    if(k==null||k==="") return;
    const t=o[k]||(o[k]={r:[],v:[],hi:0,pl:0,n:0,dai:{},day:{}});
    const d=m.d||[];
    idx.forEach(i=>{
      const x=d[i];
      if(!x||x[0]==null||!(x[1]>0)) return;
      const r=rate(x[0],x[1]);
      if(r==null) return;
      t.r.push(r); t.v.push(x[0]); t.n++; t.dai[dai]=1; t.day[i]=1;
      if(r>=AI_HI) t.hi++;
      if(x[0]>0) t.pl++;              // 差枚がプラスだった台日(2026-08-14)
    });
  });
  return o;
}
// 束ねたものを並べる。並べ方は2通り(2026-08-14・谷川氏指示「AI予想（差枚がその日で
// ると予測される）のボタンを生成してください」)。
//   hi … 高出率だった割合の高い順(出率で見る。従来)
//   v  … 差枚の中央値の高い順(その日いくら出そうかで見る)
// 差枚は**中央値**で並べる。平均だと1台の大勝ちで順位が跳ね、翌日の目安にならない。
// 平均差枚も一緒に出すので、median と mean の食い違い(＝跳ねている機種)も読める。
function aiRows(o,minN,minDay){
  const rows=Object.keys(o).map(k=>{
    const a=o[k];
    const sv=a.v.reduce((x,y)=>x+y,0);
    // 出率(平均)を足した(2026-08-14夕・谷川氏指示で表の列を
    // 「出率・出率中央」に入れ替えたため)。台日ごとの出率の平均。
    // **中央値と並べて出す**ことに意味がある(平均だけが高い＝1台の大勝ちで
    // 跳ねている、平均<中央値＝一部が大きく負けている、が読めるため)。
    const sr=a.r.reduce((x,y)=>x+y,0);
    return {k:k, n:a.n, hiN:a.hi, plN:a.pl, dai:Object.keys(a.dai).length,
            day:Object.keys(a.day).length,
            hi:a.n?(a.hi*100/a.n):0, md:aiMed(a.r),
            rav:a.r.length?(sr/a.r.length):null,
            vsum:a.n?sv:null, vav:a.n?Math.round(sv/a.n):null,
            pl:a.n?(a.pl*100/a.n):0};
  }).filter(x=>x.n>=minN&&x.day>=minDay);
  return aiSortRows(rows);
}
// 並べ替え(2026-08-14・谷川氏指示「上部の項目毎にソートできるようにしてください」)。
// 既定は高出率の高い順。見出しを押すとその項目で並び、もう一度押すと逆順になる。
// 値の無いもの(母数が薄くて中央値が出せない等)は必ず末尾へ送る
// (昇順にしたときに「値が無い」が上位に来ると、順位表として読めなくなる)。
// 既定の並び(2026-08-14夕)。AI予想のときは「予想」、実績を見るときは
// 「出率の中央値」。高出率の列を消したので、見えていない項目で並ばないようにする。
// 中央値にしたのは、平均だと1台の大勝ちで順位が跳ねて翌日の目安にならないから。
function aiSortDefault(){ return (aiMode==="ai")?"pred":"md"; }
let aiSortK="pred", aiSortD=-1;
// 並べ替えの本体。項目名と向きを渡す形にして、いま選ばれている項目以外でも
// 並べられるようにした(2026-08-15夕。凹み度の並びをここから使うため)。
function aiSortBy(rows,k,d){
  const val=x=>{
    const v=x[k];
    return (typeof v==="number")?v:null;
  };
  return rows.slice().sort((a,b)=>{
    const va=val(a), vb=val(b);
    if(va==null&&vb==null) return b.n-a.n;
    if(va==null) return 1;
    if(vb==null) return -1;
    return (va===vb)?(b.n-a.n):((va-vb)*d);
  });
}
function aiSortRows(rows){ return aiSortBy(rows,aiSortK,aiSortD); }
// 表の見出し(押すと並べ替わる)。key が空の列は押せない見出しにする。
// same には「既定の項目名」を渡せる(2026-08-15夕)。凹み度の列は、まだ一度も
// 押されていない状態(aiSortK="pred")でも既定で使われているので、矢印を出す。
function aiTh(cols){
  return "<thead><tr>"+cols.map(c=>{
    if(!c.k) return '<th>'+esc(c.t)+'</th>';
    const on=(aiSortK===c.k)||(!!c.same&&aiSortK===c.same);
    return '<th><button type="button" class="ai-sort'+(on?" on":"")
      +'" data-k="'+esc(c.k)+'">'+esc(c.t)
      +'<span class="ai-arw">'+(on?(aiSortD<0?"▼":"▲"):"")+'</span></button></th>';
  }).join("")+"</tr></thead>";
}
// ==== AI予想(2026-08-14夕・谷川氏指示) ===================================
// 「いまのままだとただの過去の結果を表示しているだけなので、AI予想のボタンを
//   金曜日だけより前の先頭に作り最初はそれが選ばれている状態にする。
//   AI予想は過去の実績から当日がどのような機種や台が差枚数を平均で多くでるかどうかを
//   分析して、実績ベースでなくてもよいあくまであなたのプロの打ち手として
//   予測されるランキング形式で出すようにすること」。
//
// ★何をしているか(画面にもそのまま書く)。
//   打ち手が台を選ぶときに見るものを4つに分け、それぞれ「出率の中央値」で測って
//   重みを付けて足す。**母数が薄いものは薄いなりにしか信じない**(縮小推定)。
//     地力 … 全期間。その機種/台がふだんどれくらい出るか
//     曜日 … 予想する日と同じ曜日。ホールの曜日ごとの入れ方の癖
//     日付 … 予想する日と同じ一桁の日(4のつく日など)。日付の癖
//     直近 … 直近14日。いま強いか弱いか(入替や設定の入れ方の変化を拾う)
//   縮小推定 = n/(n+基準)。台日が基準と同じなら効き目は半分、少なければさらに小さい。
//   これで「1日だけ大勝ちした機種」が先頭に来るのを防ぐ。
// ★予想であることを隠さない。当てを保証するものではないと画面に明記する。
const AI_W=[{k:"base",w:0.35,s:30,n:"地力"},
            {k:"dow", w:0.25,s:15,n:"曜日"},
            {k:"dgt", w:0.15,s:15,n:"日付"},
            {k:"rec", w:0.25,s:10,n:"直近"}];
const AI_REC_DAYS=14;     // 「直近」に使う日数
// 確度の満点。重みの合計(いまは1.0)。重みを足し引きしてもここが自動で追従する
const AI_WSUM=AI_W.reduce((s,c)=>s+c.w,0);
// 確度がこれ未満なら「材料が薄い」として色を変える。25%は台番の実測値
// (戦国コレクション6=25% / 沖ドキ！ＢＬＡＣＫの古い台=48% / 機種は62〜88%)を見て、
// 「ほぼ実績順になってしまう帯」を切る位置に置いた
const AI_CONF_THIN=35;
// ★損得なしの線(2026-08-15・谷川氏指示「予想が100%を割っている日は
//   見出しに『今日は見送り推奨』を出す」)。
//   ★100%ではない。この店は非等価(46枚貸し・5.06枚交換)なので、出率100%ちょうどでも
//   現金で買った分だけ負ける(交換単価19.76円 と 貸出単価21.74円 の差＝1.98円/枚)。
//   生成側 gcol.py と同じ定数・同じ式で解くと、持ち玉遊技比率90%のとき **101.0%**。
//     円収支 = 差枚×交換単価 − 現金投資枚×ギャップ ／ 現金投資枚 = 3G×(1−持ち玉比率)
//     差枚 = (出率−100)/100×3G なので 出率 = 100 + (1−持ち玉比率)×ギャップ/交換単価×100
//   ここを100にすると損得なしを1pt甘く見せることになる。gcol.py を変えたらここも直す。
const AI_EXC=100/5.06, AI_LEND=1000/46, AI_MOCHI=0.90;
const AI_BE=100+(1-AI_MOCHI)*(AI_LEND-AI_EXC)/AI_EXC*100;   // ＝101.0
// 予想の数値の読み方(2026-08-15)。**常に出す**。
//
// ★経緯: 当初は「最上位の予想が線を割っていたら見送り推奨」を出すつもりだったが、
//   歩進検証(ai_rank_backtest.py の skip_check)で過去56日を確かめたところ**逆**だった。
//     AT機の1位だけ打った場合
//       予想が線を超えた日(11日) … 実際の出率 92.2±1.8%／プラス率36.6%
//       予想が線を割った日(45日) … 実際の出率 99.6±1.7%／プラス率48.0%
//   差は誤差幅の3倍。見送り推奨を出すと、いちばん悪い日に「打ってよし」と言い、
//   マシな日に「見送れ」と言うことになる。理由は平均への回帰で、予想が線を超えるのは
//   直近で跳ねた機種があるときだから。跳ねた分は翌日に戻る。
// ★つまり予想は**順位付けとしては効く**(プラス率+6.8pt)が、**数値の絶対水準は
//   実際の出率と対応していない**。そこを画面に書いておく。条件つきの警告にはしない
//   (逆向きの助言になるため)。谷川氏の選択＝案A「注記に差し替える」。
function aiCalHtml(oneLine){
  if(oneLine){
    return '<div class="ai-cal"><b>予想の数値は順位を付けるためのものです。</b>'
      +'実際の出率の水準とは対応していません（損得なしの線は'
      +AI_BE.toFixed(1)+'%）。</div>';
  }
  // ★2026-08-17に測り直した(谷川氏指示「同じ物差しで計り直したバージョンで」)。
  //   旧文の「56日のうち11日→1日だけ」は**機種の見方**で測った値で、画面の確度の話
  //   (台番の見方)と物差しが違っていた。台番・上位10・7/4〜8/16の44日で測り直すと
  //   「予想はどの日も線を超えていたが、実際に超えて終われたのは24日(55%)」。
  //   材料は ai_rank_backtest.py --level dai の日別CSV(上位出率)。
  return '<div class="ai-cal"><b>予想の数値は順位を付けるためのものです。</b>'
    +'実際の出率の水準とは対応していません。<br>'
    +'<span class="ai-cal-s">過去44日（台番・上位10）で確かめると、'
    +'予想はどの日も損得なしの線（<b>'+AI_BE.toFixed(1)+'%</b>）を超えていましたが、'
    +'その上位10を実際に打っていたら、線を超えて終われたのは24日（55%）でした。'
    +'1位でも「今日の狙い台」ではなく「今日の中では相対的に上」と読んでください。<br>'
    +'損得なしが100%でなく'+AI_BE.toFixed(1)+'%なのは、この店が非等価'
    +'（46枚貸し・5.06枚交換）で、出率100%ちょうどでも現金で買った分だけ'
    +'負けるためです（持ち玉'+Math.round(AI_MOCHI*100)+'%で計算）。</span></div>';
}
function aiConfHtml(v){
  if(typeof v!=="number") return "";
  return '<span class="ai-cf'+(v<AI_CONF_THIN?" thin":"")+'">確度'
    +Math.round(v)+'%</span>';
}
// 直近n日の添字(データの末尾から数える)。
function aiRecentIdx(n){
  const L=DATA.labels||[], a=[];
  for(let i=Math.max(0,L.length-n);i<L.length;i++) a.push(i);
  return a;
}
// ==== 凹み度（連続差枚マイナス）で並べる =================================
// 2026-08-15夕・谷川氏の判断「差し替える」で採用。**ノーマル機の台番だけ**に効かせる。
//
// 発端: 期待値表(nerai_table.py)で「凹み台狙いはノーマル機8機種すべてで有効」と
//   出たので、AI予想の材料に足せるかを歩進検証で測った(ai_rank_backtest.py --dip)。
//   「足す」形は誤差の範囲だったが、測る途中でもっと重いことが分かった:
//     ノーマル機の台番は、いまの4材料だと上乗せが**マイナス**
//       画面と同じ形(機種の中・上位3) 現行 -3.4±1.2pt ／ 上位1では -5.7±1.9pt
//     凹み度だけで並べると             +4.0±1.0pt（現行との差 +7.5±1.7pt）
//     前半28日 +7.9 ／ 後半29日 +7.8 と、期間を割っても同じ
//   ★AT機は変えない(凹み度を入れても ±0.0±1.3pt で変わらないため)。
//   ★対立仮説は3つとも潰してある(同値の並び順・ただの逆張り・回っている台を選ぶだけ)。
//     詳細は memory: shimaheat-dip-signal-2026-08-15
//
// 並べ方:
//   1. その台がいま何日つづけてマイナスか(m1〜m4+)／プラスか(p1〜p4+)で段に分ける
//   2. 段ごとの「翌日の出率の中央値」を**過去の全ノーマル機**から学習する
//   3. その値の高い順。同じ段の中は**深く凹んでいる順**(連続期間の合計差枚が小さい順)
//   ★値を決め打ちしていないのが肝。向き(凹みが良いのか悪いのか)もデータに決めさせている。
const DIP_CAP=4, DIP_MIN_N=30, DIP_TIE_EPS=0.1, DIP_TIE_SCALE=5000;
function dipHas(x){ return !!x && x[0]!=null && !!x[1] && x[1]>0; }
// 日 t の朝に分かる凹み度。t-1 から遡って同じ向きが何日つづいたか。
// ★欠けた日で止める(窓に欠けのあるものを混ぜると公平に比べられない)。
function dipAt(d,t){
  if(!d||t<=0||t>d.length) return null;
  const x=d[t-1];
  if(!dipHas(x)||x[0]===0) return null;
  const minus=(x[0]<0);
  let k=0,s=0,i=t-1;
  while(i>=0){
    const y=d[i];
    if(!dipHas(y)||y[0]===0||((y[0]<0)!==minus)) break;
    k++; s+=y[0]; i--;
  }
  return {b:(minus?"m":"p")+(k<DIP_CAP?String(k):(DIP_CAP+"+")),
          k:k, minus:minus, v:s};
}
// 段 → 翌日の出率の中央値。**過去の全ノーマル機**から作る(1機種ぶんだと薄すぎる)。
let DIPT=null;
function dipTable(){
  if(DIPT) return DIPT;
  const L=DATA.labels||[], acc={};
  Object.keys(DATA.machines||{}).forEach(dai=>{
    const m=DATA.machines[dai]||{};
    if(aiKind(m.n||"")!=="nm") return;
    const d=m.d||[];
    for(let t=1;t<L.length;t++){
      const g=dipAt(d,t);
      if(!g) continue;
      const x=d[t];
      if(!dipHas(x)) continue;
      (acc[g.b]=acc[g.b]||[]).push((3*x[1]+x[0])/(3*x[1])*100);
    }
  });
  const out={};
  Object.keys(acc).forEach(b=>{
    const a=acc[b].slice().sort((p,q)=>p-q), n=a.length;
    if(n<DIP_MIN_N) return;        // 薄い段は使わない(偶然で動くため)
    out[b]={md:(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2), n:n};
  });
  DIPT=out;
  return out;
}
// 並べるための値。段の値に、同値を崩すぶんだけ深さを足す。
// ★足す幅(0.1)は段どうしの差(約1pt)より十分小さいので、**段の順番は入れ替わらない**。
function dipScore(g,T){
  const e=g?T[g.b]:null;
  return e ? (e.md + DIP_TIE_EPS*Math.tanh(-g.v/DIP_TIE_SCALE)) : null;
}
function dipLabel(g){
  if(!g) return "—";
  return (g.minus?"凹み ":"好調 ")
    +((g.k>=DIP_CAP)?(DIP_CAP+"日以上"):(g.k+"日"));
}
const DIP_ORDER=["m4+","m3","m2","m1","p1","p2","p3","p4+"];
// 並べ方の説明。**数字を出す以上、それが何の順なのかを画面に書く**(確度と同じ考え方)。
function aiDipNote(T){
  const li=DIP_ORDER.filter(b=>T[b]).map(b=>{
    const plus=(b.charAt(0)==="p"), cap=(b.indexOf("+")>0);
    const k=cap?DIP_CAP:parseInt(b.slice(1),10);
    return '<li>'+esc((plus?"好調 ":"凹み ")+k+"日"+(cap?"以上":""))
      +' → 翌日の出率 <b>'+aiPct(T[b].md)+'</b>'
      +'<span class="ai-dipn">（学習 '+T[b].n.toLocaleString()+'台日）</span></li>';
  }).join("");
  return '<div class="ai-cal"><b>ノーマル機の台番は「凹み度」で並べています。</b>'
    +'その台がいま何日つづけてマイナスかで段に分け、段ごとの'
    +'「翌日の出率の中央値」を過去の全ノーマル機から学習して、高い順に並べます。'
    +'同じ段の中は<b>深く凹んでいる順</b>です。'
    +'<span class="ai-cal-s">過去57日で確かめると、この並べ方は'
    +'プラスで終われた割合が全体より <b>+4.0±1.0pt</b> でした。'
    +'今までの4材料（地力・曜日・日付・直近）の並べ方は <b>-3.4±1.2pt</b> で、'
    +'ノーマル機では効いていませんでした（AT機は今までどおり4材料です）。<br>'
    +'学習した段ごとの目安:'
    +'<ul class="ai-dipt">'+li+'</ul>'
    +'この出率は「その状態だった台の翌日の中央値」で、'
    +'1台ごとの当たりを約束するものではありません。</span></div>';
}
// 期待値表の読み方に、マスを押せることを1行足す(2026-08-15夕)。
function nrTapNote(){
  // ★「◯台＝いま当てはまる台数／◯件＝母数」は下の図が言っているので消した
  //   (2026-08-16・谷川氏指示。memory: figure-replaces-text-rule)。
  //   図に入っていない「島図を光らせられる」だけを残す。
  return '<div class="nr-intro" style="padding-left:0">'
    +'マスを押すと、その台の一覧が出て<b>島図を光らせられます</b>。</div>';
}
// 予想の行を作る。母数の下限は「地力(全期間)」で見る(4つのうち必ずある物なので)。
function aiPredRows(keyOf,pick,minN,minDay){
  const sets={base:aiIdx("all"), dow:aiIdx("dow"),
              dgt:aiIdx("dgt"), rec:aiRecentIdx(AI_REC_DAYS)};
  const got={};
  Object.keys(sets).forEach(k=>{
    got[k]={};
    // 下限は掛けない(材料として使うだけ。薄さは縮小推定で効かせる)
    aiRows(aiCollect(sets[k],keyOf,pick),0,0).forEach(x=>{ got[k][x.k]=x; });
  });
  const out=[];
  Object.keys(got.base).forEach(k=>{
    const b=got.base[k];
    if(b.n<minN||b.day<minDay) return;
    let num=0, den=0; const why=[];
    AI_W.forEach(c=>{
      const x=got[c.k][k];
      if(!x||x.md==null||!x.n) return;
      const sh=x.n/(x.n+c.s);
      num+=c.w*sh*(x.md-100);
      den+=c.w*sh;
      why.push(c.n+" "+aiPct(x.md)+"("+x.n+"台日)");
    });
    if(!den) return;
    const o={};
    Object.keys(b).forEach(kk=>{ o[kk]=b[kk]; });
    o.pred=100+num/den;
    o.why=why.join(" ／ ");
    // ★確度(2026-08-14夜・谷川氏指示「当てにしてよい予想の%も機種毎、台番毎に」)。
    //   den は「重み×縮小」の合計＝**材料がどれだけ厚く揃っているか**。
    //   母数が無限なら縮小が1になり den は重みの合計＝満点になる。そこを100%とする。
    //   ★これは「当たる確率」ではない。**材料の揃い具合**であることを画面に明記する
    //   (勝てる確率だと読まれると、確度80%＝8割勝てる、と誤解されるため)。
    o.conf=den*100/AI_WSUM;
    out.push(o);
  });
  return aiSortRows(out);
}
// ★母数が薄い機種の注意書き(2026-08-14夜・谷川氏指示「新台に印を出す」)。
//
// 発端: 8/14 の戦国コレクション6(8/3導入・11日分)で、台番の並びが
//   **ほぼ実績順**になっていた(谷川氏の指摘。予想と地力の順位相関を測ると 0.905)。
//   原因は不具合ではなく構造的なもので、母数の薄い機種では必ずこうなる:
//     ・日数が AI_REC_DAYS(14日)以下だと「全期間」と「直近14日」が**同じ中身**になる
//     ・曜日と日付は1台日ずつしか無く、縮小推定 n/(n+基準) でほとんど消える
//   実測の配分は 地力38%/直近52%/曜日6%/日付4%(＝曜日+日付で10%)。
//   一方 沖ドキ！ＢＬＡＣＫ(62日)は 地力46/曜日17/日付8/直近29 で、
//   実際に順位が動く(2867 は地力2位→予想7位)。
//
// ★外れること自体は避けられない。出すのは「**どれくらい当てにしてよい予想か**」。
//   歩進検証では、4つを混ぜた形のプラス率の上乗せが +6.8pt なのに対し、
//   地力だけの形は +2.1pt しかない(ai_rank_backtest.py)。新台は後者と同じ状態になる。
const AI_THIN_SHARE=20;   // 曜日+日付の効き目がこれ未満なら「ほぼ実績順」と書く
function aiThinNote(nm,mdays){
  const sets={base:aiIdx("all"), dow:aiIdx("dow"),
              dgt:aiIdx("dgt"), rec:aiRecentIdx(AI_REC_DAYS)};
  const pick=(d,m)=>((m.n||"")===nm);
  const got={};
  Object.keys(sets).forEach(k=>{
    got[k]={};
    aiRows(aiCollect(sets[k],d=>String(d),pick),0,0).forEach(x=>{ got[k][x.k]=x; });
  });
  // 台ごとに「重み×縮小」を出して足し合わせる(1台だけの偏りに引っぱられないため)
  const eff={}, nsum={};
  AI_W.forEach(c=>{ eff[c.k]=0; nsum[c.k]=0; });
  let dais=0;
  Object.keys(got.base).forEach(k=>{
    const b=got.base[k];
    if(b.n<AI_MIN_DAI_N||b.day<AI_MIN_DAY) return;
    dais++;
    AI_W.forEach(c=>{
      const x=got[c.k][k];
      if(!x||x.md==null||!x.n) return;
      eff[c.k]+=c.w*(x.n/(x.n+c.s));
      nsum[c.k]+=x.n;
    });
  });
  let tot=0; AI_W.forEach(c=>{ tot+=eff[c.k]; });
  if(!dais||!tot) return "";
  const sh={}; AI_W.forEach(c=>{ sh[c.k]=eff[c.k]*100/tot; });
  const r1=v=>Math.round(v);
  const haba=AI_W.map(c=>c.n+" <b>"+r1(sh[c.k])+"%</b>").join(" ／ ");
  const dai1=AI_W.map(c=>c.n+r1(nsum[c.k]/dais)+"台日").join("・");
  const warn=[];
  if(mdays&&mdays<=AI_REC_DAYS){
    warn.push("この機種はデータが"+mdays+"日分しかないので、"
      +"「地力（全期間）」と「直近"+AI_REC_DAYS+"日」が同じ中身になっています。");
  }
  if((sh.dow+sh.dgt)<AI_THIN_SHARE){
    warn.push("曜日と日付は母数が薄く、ほとんど効いていません"
      +"（合わせて効き目の"+r1(sh.dow+sh.dgt)+"%）。"
      +"この並びはほぼ「これまでの実績順」です。"
      // 過去56日の実測(ai_rank_backtest.py の conf_split)。ここまで書いて初めて
      // 「では避ければいい」という行動につながる
      +"確度の低い台から選んだ場合、過去56日ではプラスで終わる割合が"
      +"全体平均より4.0pt低くなっていました。");
  }
  if(!warn.length) return "";
  return '<div class="ai-thin">予想の中身：'+haba
    +'<br><span class="ai-thin-s">1台あたり '+dai1+'</span><br>'
    +esc(warn.join("")) +'</div>';
}
// 全体(その条件の日・全機種)。根拠の「比べる相手」になる。
function aiBase(idx){
  const a=aiCollect(idx,()=>"全体",null)["全体"];
  if(!a||!a.n) return null;
  const sr=a.r.reduce((x,y)=>x+y,0);
  return {n:a.n, hi:a.hi*100/a.n, md:aiMed(a.r),
          rav:a.r.length?(sr/a.r.length):null,
          dai:Object.keys(a.dai).length, day:Object.keys(a.day).length};
}
const aiPct=v=>(typeof v==="number")?(v.toFixed(1)+"%"):"−";
// 差枚は符号つきで桁区切り(表の他の場所と同じ書き方にそろえる)
const aiSv=v=>(typeof v==="number")?((v>0?"+":"")+v.toLocaleString()):"−";
const aiPt=v=>(v==null)?"−":((v>0?"+":"")+(Math.round(v*10)/10)+"pt");
const aiCl=v=>(typeof v!=="number")?"":(v>0?" ai-p":(v<0?" ai-m":""));
// 最初に選ばれているのは「AI予想」(2026-08-14夕・谷川氏指示)
let aiMode="ai";
// 機種の種別のタブ(2026-08-20・谷川氏指示「AI予想を3つにする
// AI予想(総合)、AI予想(ノーマル)、AI予想(AT)」)。all=総合 / nm=ノーマル / at=AT。
// 端末に覚えさせる(毎回同じところから見たいため)。
const AI_KT_KEY="shimaheat-ai-kind";
let aiKindTab=(()=>{ try{ const v=localStorage.getItem(AI_KT_KEY);
  return (v==="nm"||v==="at")?v:"all"; }catch(e){ return "all"; } })();
let aiNm=null;           // 台番一覧を開いている機種(null なら機種の一覧)
// 集計する日の選び方。曜日は必ず出し、今日が特定日ならその分だけ増える。
function aiModeHtml(){
  const t=aiToday();
  // 先頭は「AI予想」(2026-08-14夕・谷川氏指示「AI予想のボタンを金曜日だけより前の
  // 先頭に作り最初はそれが選ばれている状態にする」)。残りは実績そのものの見方。
  const list=[{m:"ai",n:"AI予想"},
              {m:"dow",n:t.wd+"曜だけ"},
              // 当日の一桁と同じ日(2026-08-14夕・谷川氏指示)
              {m:"dgt",n:aiDgtName()}];
  // ★この店の特定日台帳に同じ「◯のつく日」があるときは自前のボタンを出さない
  //   (2026-08-14夕)。台帳には「8のつく日」が入っているので、8日・18日・28日に
  //   開くと同じ名前のボタンが2つ並んでしまう。台帳側の方が由来を持っているので残す。
  const toku=aiTokuToday();
  if(toku.some(x=>x.n===aiDgtName())){
    list.pop();
    if(aiMode==="dgt") aiMode="dow";   // 選ばれたまま消えると何も選ばれていない見た目になる
  }
  toku.forEach(x=>list.push({m:"toku:"+x.k,n:x.n}));
  list.push({m:"all",n:"全部の日"});
  return '<div class="ai-md" role="group" aria-label="集計する日">'
    +list.map(x=>'<button type="button" class="ai-mdb'+(x.m===aiMode?" on":"")
      +'" data-m="'+esc(x.m)+'">'+esc(x.n)+"</button>").join("")+"</div>";
}
function aiModeLabel(){
  const t=aiToday();
  if(aiMode==="ai") return "AI予想";
  if(aiMode==="all") return "全部の日";
  if(aiMode==="dow") return t.wd+"曜";
  if(aiMode==="dgt") return aiDgtName();
  const k=aiMode.slice(5);
  const f=[{k:"zoro",n:"ゾロ目の日"}].concat(
    ((typeof SHIMA!=="undefined"&&SHIMA.ftoku)||[]).map(x=>({k:x.k,n:x.n})))
    .find(x=>x.k===k);
  return f?f.n:"特定日";
}
// 見出し帯＋言葉の説明。**何を計算しているのか**をここで必ず言い切る
// (「高配分確率」という名前のまま出すと、設定を当てているように見えてしまうため)。
function aiHeadHtml(idx,base){
  const t=aiToday();
  const head='<div class="ai-h">'+esc(t.mo+"/"+t.da+"("+t.wd+")")+'の予想'
    +'<span class="ai-hp">'+aiModeLabel()+' '+idx.length+'日 / '
    +(base?base.n.toLocaleString():0)+'台日</span></div>'
    +aiModeHtml();
  // AI予想は「実績そのもの」ではないので、説明を丸ごと差し替える(2026-08-14夕)。
  if(aiMode==="ai"){
    return head
      // ★行の読み方を1枚の図で出す(2026-08-16・谷川氏指示「文字が多すぎて
      //   よく分からないので視覚的に」)。予想・確度・出率中央・母数・内訳の5つが
      //   1行の中に並んでいるので、言葉だけではどれの話か結びつかない。
      //   図を入れたぶん、**図と同じことを言っている文は消してある**
      //   （出率中央の説明／確度の定義／内訳の在りか）。
      //   図に入らない「目安の数値」「歩進検証で測った差」「断り書き」は文で残す。
      +'<figure class="ai-fig">'
      +'<img src="'+esc(asrc("airank_yomikata.jpg"))+'" alt="行の読み方"'
      +' loading="lazy" decoding="async">'
      +'<figcaption>行の読み方（押すと別の画面で大きく見られます）</figcaption></figure>'
      // ★2枚目の図(2026-08-17)。予想の組み立て(4材料と重み)と、確度の効きを
      //   「100台のうち何台がプラスで終わるか」で示す。
      //   ★谷川氏指示「ptの説明が必要」→「まだ意味がわからない」→
      //     「そもそも何台がプラスで終わる想定でプラス9台になるのかを入れた方が分かる」。
      //     ptという言い方をやめ、基準(何も選ばずに打つ=37台)から並べる形にした。
      //   この図が言っていること(材料と重み／確度の効き)は文から消してある。
      +'<figure class="ai-fig">'
      +'<img src="'+esc(asrc("airank_kumitate.jpg"))+'" alt="予想の組み立てと確度の効き"'
      +' loading="lazy" decoding="async">'
      +'<figcaption>予想の組み立てと確度の効き'
      +'（押すと別の画面で大きく見られます）</figcaption>'
      +'</figure>'
      +'<div class="ai-i">予想＝'+esc(t.mo+"/"+t.da+"("+t.wd+")")+'に出そうな出率の見立て'
      +'（曜日は'+t.wd+'曜、日付は'+esc(aiDgtName())+'で見ています）。'
      +'100%が損得なし。<br>'
      // ★確度(2026-08-14夜・谷川氏指示「当てにしてよい予想の%も機種毎、台番毎に」)。
      //   定義は1枚目の図、効きの大きさは2枚目の図にあるので、ここは
      //   **目安の数値**と**図に入っていない機種側の話**だけにする。
      +'<b>確度</b>の目安は 機種で60〜90%、台番で25〜50%。'
      +AI_CONF_THIN+'%未満は色を変えています。'
      +'<span class="ai-cau">当たる確率ではありません。</span><br>'
      +'機種の側は差が誤差の範囲だったので、確度は主に台番選びの目安にしてください。<br>'
      +'<span class="ai-cau">これは実績から組み立てた見立てで、当たりを約束するものでは'
      +'ありません。ホールが入れた設定は公表されないため計算できません。</span><br>'
      +'<span class="ai-red">※ 表の見出し（予想・出率中央・総差枚・平均差枚・母数）を押すと、'
      +'その項目の高い順に並べ替わります。もう一度押すと低い順になります。</span></div>';
  }
  return head
    // 列を 出率／出率中央 に入れ替えたので言葉の説明もそろえる(2026-08-14夕)。
    // 高出率は各行の根拠(<em>)に残っているので、意味だけはここで説明しておく。
    +'<div class="ai-i">出率＝台日ごとの出率の平均。出率中央＝台日ごとの出率の真ん中。'
    +'高出率＝出率'+AI_HI+'%以上だった台日の割合（各行の下に実数で出しています）。<br>'
    +'どれも「'+esc(aiModeLabel())+'」の実績そのもので、ホールが入れた設定ではありません'
    +'（設定は公表されないため計算できません）。<br>'
    // 並べ替えができることを赤で1行だけ書く(2026-08-14夕・谷川氏指示
    // 「項目毎にソート可能なことを※赤文字で説明書上にかいてください」)。
    // 赤は**この1行だけ**にする(絞り込みの使い方説明と同じ約束)。
    +'<span class="ai-red">※ 表の見出し（出率・出率中央・総差枚・平均差枚・母数）を押すと、'
    +'その項目の高い順に並べ替わります。もう一度押すと低い順になります。</span></div>';
}
// 機種のTOP10。AT機とノーマル機で分けて呼ぶ。
function aiMachineHtml(idx,base,ttl,pick,out){
  const pred=(aiMode==="ai");
  const rows=(pred?aiPredRows((d,m)=>m.n||"",pick,AI_MIN_N,AI_MIN_DAY)
                  :aiRows(aiCollect(idx,(d,m)=>m.n||"",pick),AI_MIN_N,AI_MIN_DAY))
             .slice(0,10);
  // 見送りの判定に使う「この表の最上位の予想」を呼び元へ返す(2026-08-15)。
  // ★ここで渡すのは、もう1度 aiPredRows を回さないため(2つの表で2回増える)
  if(out&&pred&&rows.length&&typeof rows[0].pred==="number") out.best=rows[0].pred;
  let h='<div class="ai-s">'+esc(ttl)+'</div>';
  if(!rows.length){
    return h+'<div class="ai-none">この条件で母数の足りる機種がありません'
      +'（'+AI_MIN_N+'台日以上かつ'+AI_MIN_DAY+'日以上ある機種だけを並べています）。'
      +'「全部の日」に切り替えると出ることがあります。</div>';
  }
  // 列は 機種／予想(実績の見方では出率)／出率中央／総差枚／平均差枚／母数 の6つ。
  // 2026-08-14夕に高出率・総差枚・平均差枚を外して4列にしたが、同日中に
  // 谷川氏指示「総差枚数と平均差枚を項目入れてください」で差枚の2つだけ戻した。
  // 外したままなのは高出率の列(実数は各行の根拠<em>に残してある)。
  h+='<table class="ai-t ai-t6">'
    +aiTh([{t:"機種"},pred?{t:"予想",k:"pred"}:{t:"出率",k:"rav"},
           {t:"出率中央",k:"md"},{t:"総差枚",k:"vsum"},
           {t:"平均差枚",k:"vav"},{t:"母数",k:"n"}])
    +'<tbody>'
    +rows.map((x,i)=>{
      const d=base?(x.hi-base.hi):null;
      // ★1件を**2段**に分ける(2026-08-15夕・谷川氏指示「内訳が折り返しが多く
      //   右側の余白がありすぎる、バランスよく配置しなおして」)。
      //   1段目 … 機種名と数字。2段目 … 内訳と台番詳細ボタンを**表の幅いっぱい**で。
      //   直す前は全部が1列目に入っていたが、1列目は端末幅390pxで84pxしかなく、
      //   60字ある内訳がそこで8行に折り返して行の高さを決めていた。右の数字は
      //   1〜2行なので、その差がまるごと右側の余白になっていた。
      //   幅いっぱいなら同じ内訳が2行で収まる=行が縮み、余白も消える。
      //   ★検証(verify_shimaheat_airank.py)は行を1件1行で数えているので、
      //     1段目に .ai-r1 を付けて数える側もそろえてある。
      return '<tr class="ai-r1"><td class="ai-k"><span class="ai-rk">'+(i+1)+'</span>'
        +'<button type="button" class="ai-go" data-nm="'+esc(x.k)+'">'+esc(x.k)+'</button>'
        +'</td>'
        +(pred?('<td class="'+aiCl(x.pred==null?null:x.pred-100)+'">'+aiPct(x.pred)
                +'<br>'+aiConfHtml(x.conf)+'</td>')
              :('<td class="'+aiCl(x.rav==null?null:x.rav-100)+'">'+aiPct(x.rav)+'</td>'))
        +'<td class="'+aiCl(x.md==null?null:x.md-100)+'">'+aiPct(x.md)+'</td>'
        +'<td class="'+aiCl(x.vsum)+'">'+aiSv(x.vsum)+'</td>'
        +'<td class="'+aiCl(x.vav)+'">'+aiSv(x.vav)+'</td>'
        +'<td class="ai-n">'+x.dai+'台<br>'+x.day+'日<br>'+x.n+'台日</td></tr>'
        // 2段目。★種別の1行は廃止(2026-08-15夕・谷川氏指示「種別表記は不要」)。
        // 分類そのものは表の見出し(AT機/ノーマル機)で分けているので、根拠を毎行
        // 出さなくても読み手は困らない。分類を直すときは ptown_flags.json を見る。
        +'<tr class="ai-r2"><td class="ai-sub" colspan="6"><div class="ai-subw">'
        // AI予想のときは**何が効いて上位に来たのか**を4つの内訳で出す(2026-08-14夕)。
        +(pred?('<em>内訳: '+esc(x.why||"")+'</em>')
              :('<em>高出率 '+x.hiN+' / '+x.n+'台日'
                +(base?('（全体 '+base.hi.toFixed(1)+'% より '+aiPt(d)+'）'):"")
                +' ／ プラス '+aiPct(x.pl)+'</em>'))
        // 台番のランキングへ進む道を**ボタンとしても**置く(2026-08-14夕・谷川氏指示
        // 「台番詳細ボタンを機種毎に追加、押すと機種名押した時と同じように
        //   台番のランキングが出る」)。機種名そのものも押せるが、名前を押すと
        //   別の何かが開くのか分かりにくいので、行き先を言葉で示したボタンを添える。
        // ★class は .ai-go のまま(押したときの動きは機種名と同じ経路を通す)。
        +'<button type="button" class="ai-go ai-dt" data-nm="'+esc(x.k)+'">'
        +'台番詳細 ▸</button></div></td></tr>';
    }).join("")+'</tbody></table>';
  return h;
}
// 機種の一覧(最初の画面)。
function aiPaintMachines(keep){
  const body=document.getElementById("aiBody");
  const back=document.getElementById("aiBack");
  const ttl=document.getElementById("aiTitle");
  if(!body) return;
  // ★見ていた位置の控え(2026-08-20夕)。keep が真のときはここへ戻す。
  const y0=body.scrollTop;
  if(back) back.hidden=true;
  if(ttl) ttl.textContent="AI予想ランキング";
  const idx=aiIdx(aiMode), base=aiBase(idx);
  let h=aiHeadHtml(idx,base);
  if(!idx.length||!base){
    body.innerHTML=h+'<div class="ai-none">この条件に当てはまる日が手元のデータにありません。</div>';
    return;
  }
  // 分類できていない機種を数える(島図に居る機種のうち、旗の取れなかったもの)。
  const unk={};
  Object.keys(DATA.machines).forEach(d=>{
    const n=(DATA.machines[d]||{}).n||"";
    if(n&&!aiKind(n)) unk[n]=1;
  });
  const unkN=Object.keys(unk).length;
  // ★表を先に組み立ててから、その最上位を見て見送りの帯を**表の手前**に差す
  //   (読んだあとに気づいても遅い。2026-08-15)
  const oAt={}, oNm={}, oAll={};
  let tbl="";
  if(Object.keys(KTYPE).length){
    // パソコン(2カラム)では2つの表を左右に並べる(2026-08-14)。AT機とノーマル機は
    // 「どちらを打つか」を決めるために見比べるものなので、縦に積むとスクロールで
    // 行き来することになる。器で包んでおき、並べるかどうかはCSSに任せる。
    // ★3つのタブに分けた(2026-08-20・谷川氏指示「AI予想を3つにする
    //   AI予想(総合)、AI予想(ノーマル)、AI予想(AT)」)。
    //   それまでは AT機とノーマル機を左右に並べていたが、端末幅390pxでは1列が
    //   84pxしか取れず、機種名も数字も折り返していた。タブなら表を幅いっぱいに使える。
    //   「総合」は種別で絞らない=種別の取れていない機種もそのまま入る。
    const TABS=[["all","総合"],["nm","ノーマル"],["at","AT"]];
    tbl+='<div class="ai-tabs" role="tablist">'
      +TABS.map(t=>'<button type="button" class="ai-tab'
        +(aiKindTab===t[0]?" is-on":"")+'" data-kt="'+t[0]+'" role="tab"'
        +' aria-selected="'+(aiKindTab===t[0]?"true":"false")+'">'
        +t[1]+'</button>').join("")
      +'</div>';
    const kpick=(aiKindTab==="all")?null:(d,m)=>aiKind(m.n||"")===aiKindTab;
    const kttl=(aiKindTab==="all")?"全機種 TOP10"
      :(aiKindTab==="nm")?"ノーマル機 TOP10":"AT機 TOP10";
    tbl+=aiMachineHtml(idx,base,kttl,kpick,oAll);
    if(unkN&&aiKindTab!=="all"){
      tbl+='<div class="ai-note">種別が取れていない'+unkN+'機種は、この表には'
        +'入れていません（分からないものを混ぜないため）。「総合」には入ります。</div>';
    }
  }else{
    // 種別の台帳が渡ってきていないときは分けられない。黙って片側だけ出すと
    // 「AT機に全機種が並ぶ」ことになるので、1つにまとめて理由を書く。
    tbl+=aiMachineHtml(idx,base,"全機種 TOP10",null,oAll)
      +'<div class="ai-note">機種の種別が読めなかったため、'
      +'AT機とノーマル機に分けられていません。</div>';
  }
  // 読み方の注記は**条件なしで常に**出す(2026-08-15。条件つきにすると
  // 逆向きの助言になることが歩進検証で分かったため。aiCalHtml の説明を参照)
  if(aiMode==="ai") h+=aiCalHtml(false);
  h+=tbl;
  // 分け方の出どころを画面に書く(2026-08-14)。分類は見出しそのものなので、
  // 何を根拠にどちらへ入れたのかが読めないと、間違いに気づけない。
  h+='<div class="ai-note">機種名を押すと、その機種の中の台番TOP10が出ます。<br>'
    +'母数は「台数・日数・台日」。台日＝台数×日数で、これが小さいものは偶然で動きます。<br>'
    // ★何を良しとして並べているのかを1行で明示する(2026-08-20・谷川氏指示
    //   「AI予想は負けにくい台を選ぶこと」)。平均ではなく中央値で並べている理由が
    //   まさにそこなので、方針として書いておく。
    +'並びの既定は出率の中央値の高い順（同じときは母数の多い順）。'
    +'平均ではなく中央値なのは、1台の大勝ちで順位が跳ねるのを避けて'
    +'「負けにくい台」を上に出すためです。<br>'
    +'上の「総合／ノーマル／AT」で機種の種別を切り替えられます。<br>'
    +'AT機＝ATやARTで出玉を増やす機械／ノーマル機＝ボーナスで出玉を得る機械'
    +'（Aタイプ・BT機）。種別は p-town の機種ページのタイプ表示から取っています。</div>';
  body.innerHTML=h;
  body.scrollTop=keep?y0:0;
  // 種別のタブ(2026-08-20)。押したら覚えて描き直す。
  // ★押しても画面の位置は動かさない(2026-08-20夕・谷川氏指示「ATとかボタンを押した時に
  //   上部まで画面が移動されるのでボタン押しても画面位置を変えないでほしい」)。
  //   表そのものは入れ替わるが、読んでいる途中に先頭へ跳ぶ方が困る。
  body.querySelectorAll(".ai-tab").forEach(b=>{
    b.addEventListener("click",e=>{
      e.stopPropagation();
      const k=b.dataset.kt;
      if(!k||k===aiKindTab) return;
      aiKindTab=k;
      try{ localStorage.setItem(AI_KT_KEY,k); }catch(err){}
      aiPaintMachines(true);
    });
  });
}
// 機種の中の台番TOP10。
// 1台あたり9〜10台日しか無いので**台の実績だけでは根拠が薄い**。そこで
// 末尾・位置区分の癖(839台×その日数ぶんあるので厚い)を各行に添える。
function aiPaintDais(nm,keep){
  const body=document.getElementById("aiBody");
  const back=document.getElementById("aiBack");
  const ttl=document.getElementById("aiTitle");
  if(!body) return;
  const y0=body.scrollTop;   // 見ていた位置の控え(2026-08-20夕)
  if(back) back.hidden=false;
  if(ttl) ttl.textContent=nm;
  const idx=aiIdx(aiMode), base=aiBase(idx);
  let h=aiHeadHtml(idx,base);
  const mine=aiRows(aiCollect(idx,(d,m)=>m.n||"",(d,m)=>((m.n||"")===nm)),0,0)[0];
  h+='<div class="ai-s">'+esc(nm)+'</div>';
  if(mine&&mine.n){
    h+='<div class="ai-i">この機種の全体：高出率 <b>'+aiPct(mine.hi)+'</b>'
      +(base?('（全体 '+base.hi.toFixed(1)+'% より '+aiPt(mine.hi-base.hi)+'）'):"")
      +' ／ 出率の中央値 <b>'+aiPct(mine.md)+'</b><br>'
      +'母数 '+mine.dai+'台 '+mine.day+'日 '+mine.n+'台日</div>';
  }
  const pred=(aiMode==="ai");
  // ★ノーマル機の台番だけ、並べ方を「凹み度」に差し替える(2026-08-15夕・谷川氏の判断)。
  //   4材料の並べ方はノーマル機では上乗せがマイナスだった(dipTable の上の説明を参照)。
  const dipMode=pred&&(aiKind(nm)==="nm");
  // 母数が薄い機種は予想がほぼ実績順になる。表の**手前**に出す
  // (読んだあとで注意書きに気づいても遅いため。2026-08-14夜)
  // ★凹み度で並べるときは出さない。あの注意書きは「4材料の効き目の配分」の話で、
  //   並べ方が別物になった以上、そのまま出すと読み手を誤らせる。
  if(pred&&!dipMode) h+=aiThinNote(nm,mine?mine.day:0);
  let rowsAll=(pred
    ? aiPredRows(d=>String(d),(d,m)=>((m.n||"")===nm),AI_MIN_DAI_N,AI_MIN_DAY)
    : aiRows(aiCollect(idx,d=>String(d),(d,m)=>((m.n||"")===nm)),
             AI_MIN_DAI_N,AI_MIN_DAY));
  let DT=null;
  if(dipMode){
    DT=dipTable();
    const tNow=(DATA.labels||[]).length;   // 今日の朝＝データの最後の日の次
    rowsAll.forEach(x=>{
      const mm=DATA.machines[x.k]||{};
      x.dip=dipAt(mm.d||[],tNow);
      x.dscore=dipScore(x.dip,DT);
    });
    // 見出しをまだ押していない(既定の"pred")なら凹み度で並べる。
    // 別の見出しを押したときは、今までどおりその項目で並べる。
    rowsAll=aiSortBy(rowsAll,(aiSortK==="pred"?"dscore":aiSortK),aiSortD);
  }
  const rows=rowsAll.slice(0,10);
  if(!rows.length){
    body.innerHTML=h+'<div class="ai-none">この条件で母数の足りる台がありません'
      +'（'+AI_MIN_DAI_N+'台日以上かつ'+AI_MIN_DAY+'日以上）。</div>';
    body.scrollTop=keep?y0:0;
    return;
  }
  // 台番の側にも読み方を1行だけ添える(2026-08-15)。台番の予想は機種より大きく
  // 振れる(確度25%程度)ので、117%のような数字をそのまま期待値と読まれやすい。
  // ★凹み度で並べているときは、その並べ方の説明に差し替える(別の物差しなので)。
  if(dipMode) h+=aiDipNote(DT);
  else if(pred) h+=aiCalHtml(true);
  // 末尾・位置区分の癖は**その条件の日の全機種**から出す(839台ぶんあるので厚い)。
  const sueM={}, posM={};
  aiRows(aiCollect(idx,d=>String(d).slice(-1),null),AI_MIN_N,AI_MIN_DAY)
    .forEach(x=>{ sueM[x.k]=x; });
  aiRows(aiCollect(idx,(d,m)=>posGroup(m.p||""),null),AI_MIN_N,AI_MIN_DAY)
    .forEach(x=>{ posM[x.k]=x; });
  // ★台番ごとにピン留めの★を置く(2026-08-20夕・谷川氏指示「台番詳細の台番の一覧画面で
  //   台番毎にピン留め★ボタンをつけて」)。それまでは1台ずつカードを開いて見出しの★を
  //   押すしかなく、一覧を見ながら気になる台を拾えなかった。
  const pinNow=loadPins();
  h+='<table class="ai-t ai-t6">'
    +aiTh([{t:"台番"},
           dipMode?{t:"いまの状態",k:"dscore",same:"pred"}
                  :(pred?{t:"予想",k:"pred"}:{t:"出率",k:"rav"}),
           {t:"出率中央",k:"md"},{t:"総差枚",k:"vsum"},
           {t:"平均差枚",k:"vav"},{t:"母数",k:"n"}])
    +'<tbody>'
    +rows.map((x,i)=>{
      const m=DATA.machines[x.k]||{};
      const pg=posGroup(m.p||""), sue=String(x.k).slice(-1);
      const kuse=[];
      if(sueM[sue]) kuse.push("末尾"+sue+" "+aiPct(sueM[sue].hi)
        +(base?("("+aiPt(sueM[sue].hi-base.hi)+")"):""));
      if(posM[pg]) kuse.push((POSG[pg]||pg)+" "+aiPct(posM[pg].hi)
        +(base?("("+aiPt(posM[pg].hi-base.hi)+")"):""));
      // 機種の表と同じ2段組み(2026-08-15夕)。1段目は台番と数字だけ、
      // 位置・内訳・この日の癖は2段目へ回して表の幅いっぱいで読ませる。
      const isPin=pinNow.indexOf(String(x.k))>=0;
      return '<tr class="ai-r1"><td class="ai-k"><span class="ai-rk">'+(i+1)+'</span>'
        +'<button type="button" class="ai-god" data-dai="'+esc(x.k)+'">'+esc(x.k)+'</button>'
        +'<button type="button" class="ai-pin'+(isPin?" is-on":"")
        +'" data-dai="'+esc(x.k)+'" aria-pressed="'+(isPin?"true":"false")
        +'" aria-label="台'+esc(x.k)+' をピン留めする">★</button>'
        +'</td>'
        +(dipMode
          ? ('<td class="ai-dip'+((x.dip&&x.dip.minus)?" is-dip":"")+'">'
             +esc(dipLabel(x.dip))
             +((x.dip&&DT[x.dip.b])
               ? ('<br><span class="ai-dipr">翌日 '+aiPct(DT[x.dip.b].md)+'</span>')
               : "")+'</td>')
          : (pred?('<td class="'+aiCl(x.pred==null?null:x.pred-100)+'">'+aiPct(x.pred)
                   +'<br>'+aiConfHtml(x.conf)+'</td>')
                 :('<td class="'+aiCl(x.rav==null?null:x.rav-100)+'">'+aiPct(x.rav)+'</td>')))
        +'<td class="'+aiCl(x.md==null?null:x.md-100)+'">'+aiPct(x.md)+'</td>'
        +'<td class="'+aiCl(x.vsum)+'">'+aiSv(x.vsum)+'</td>'
        +'<td class="'+aiCl(x.vav)+'">'+aiSv(x.vav)+'</td>'
        +'<td class="ai-n">'+x.day+'日<br>'+x.n+'台日</td></tr>'
        +'<tr class="ai-r2"><td class="ai-sub" colspan="6"><div class="ai-subw">'
        +'<span class="ai-sube">'
        +'<em>'+esc(m.p||"位置不明")+' ／ 高出率 '+x.hiN+' / '+x.n+'台日</em>'
        +(!pred?"":(dipMode
            ? ('<em>'+esc("直近の連続: "+dipLabel(x.dip)
                +(x.dip?("（この間 "+aiSv(x.dip.v)+"）"):""))+'</em>')
            : ('<em>内訳: '+esc(x.why||"")+'</em>')))
        +(kuse.length?('<em>この日の癖: '+esc(kuse.join(" ／ "))+'</em>'):"")
        +'</span></div></td></tr>';
    }).join("")+'</tbody></table>'
    +'<div class="ai-note">台番を押すと、その台の3週間のグラフが開きます。<br>'
    +'1台あたりの母数は'+idx.length+'台日しかないので、'
    +'「この日の癖」（同じ条件の日の全台から出した末尾・位置区分ごとの高出率だった割合）'
    +'も一緒に見てください。</div>';
  body.innerHTML=h;
  body.scrollTop=keep?y0:0;
}
// keep=true のときは「見ていた位置のまま描き直す」(タブ・集計する日・並べ替え)。
function aiPaint(keep){
  if(aiNm) aiPaintDais(aiNm,keep); else aiPaintMachines(keep);
}
// 一覧のその場でピン留めする(2026-08-20夕)。**表は描き直さない**=押した位置から
// 動かないようにするため、押したボタンの見た目だけをその場で変える。
// 盤面の印・検索パネルの一覧・「★一覧」の件数は paintPins() がまとめて直す。
function aiTogglePin(btn){
  const d=String(btn.dataset.dai||"");
  if(!d) return;
  const pins=loadPins(), i=pins.indexOf(d);
  let on;
  if(i>=0){ pins.splice(i,1); on=false; }
  else{ pins.unshift(d); on=true; }
  savePins(pins.slice(0,40));
  paintPins();
  btn.classList.toggle("is-on",on);
  btn.setAttribute("aria-pressed",on?"true":"false");
  showToast(on?("台"+d+" をピン留めしました"):("台"+d+" のピンを外しました"),1600);
}
// 台番を押したら島図のカードを開く(絞り込み一覧と同じ動き)。期間は3週間
// (この画面の並びは曜日ごとの実績だが、カードのグラフ期間は6つに決まっているため)。
function aiOpenDai(dai){
  if(!DATA.machines[dai]) return;
  const md=document.getElementById("aiModal");
  if(md) md.style.display="none";
  if(typeof curView!=="undefined"&&curView==="island") focusDai(dai);
  renderCard(dai,NDAYS);
}
(()=>{
  const btn=document.getElementById("aiBtn"), md=document.getElementById("aiModal");
  const body=document.getElementById("aiBody"), back=document.getElementById("aiBack");
  if(!btn||!md||!body) return;
  const open=()=>{
    md.style.display="block";
    fitAiModal();
    // 台番タップ時と同じ保険: 開いた直後は visualViewport がまだ確定していないことがある
    requestAnimationFrame(()=>{ if(md.style.display==="block") fitAiModal(); });
  };
  btn.addEventListener("click",()=>{
    aiNm=null;
    open();
    // 材料は DATA と SHIMA.ktype だけ(2026-08-14に回数の外部ファイルへの依存をやめた)。
    // 待ち時間なしでその場で描ける。
    aiPaint();
  });
  document.getElementById("aiClose").addEventListener("click",()=>{ md.style.display="none"; });
  md.addEventListener("click",e=>{ if(e.target.id==="aiModal") md.style.display="none"; });
  // 戻るときも同じ位置に置く(2026-08-20夕)。進むときに位置を保つので、
  // 戻れば押したボタンがそのまま目の前にある。
  if(back) back.addEventListener("click",()=>{ aiNm=null; aiPaint(true); });
  // 中の操作はまとめて委譲(表は集計のたびに作り直されるため)。
  body.addEventListener("click",e=>{
    const t=e.target;
    if(!t||!t.closest) return;
    // 読み方の図は押すと大きく見られる(2026-08-16)。パネル幅では引き出し線の
    // 説明が小さいので、全画面の写真ビューア(openPhoto)へ渡す。
    const fg=t.closest(".ai-fig img");
    if(fg){
      e.stopPropagation();
      // 全画面の覆いではなく**説明の図だけのページへ移る**(2026-08-17・実機が
      // 落ちるため。理由は openFigPage の説明を参照)。
      openFigPage(fg.src,fg.alt,"ai");
      return;
    }
    const mb=t.closest(".ai-mdb");
    // 集計する日を切り替えたら**並べ替えの既定に戻す**(2026-08-14夕)。
    // AI予想の表には「予想」の列、実績の表には「出率」の列しか無いので、
    // 持ち越すと片方では存在しない項目で並べることになり、順位が母数順に化ける。
    if(mb){
      aiMode=String(mb.dataset.m||"dow");
      aiSortK=aiSortDefault(); aiSortD=-1;
      aiPaint(true); return;   // ★押しても位置は動かさない(2026-08-20夕)
    }
    // 見出しを押して並べ替え(2026-08-14)。同じ見出しをもう一度押すと逆順。
    const sb=t.closest(".ai-sort");
    if(sb){
      const k=String(sb.dataset.k||"hi");
      if(k===aiSortK) aiSortD=-aiSortD; else { aiSortK=k; aiSortD=-1; }
      // ★並べ替えても見ていた位置のままにする(2026-08-17・谷川氏指示
      //   「総差枚とかを押してソートすると最上部に画面がかわってしまう。
      //    押したら画面を上部にもっていかずに画面はそのままの位置で」)。
      //   aiPaint() はパネルの中身をまるごと作り直すので、何もしないと必ず
      //   先頭へ跳ぶ。スクロールの器は #aiBody(overflow-y:auto)。
      //   2026-08-20夕に aiPaint(keep) へまとめた(タブ・集計する日と同じ仕組み)。
      aiPaint(true);
      return;
    }
    const go=t.closest(".ai-go");
    // ★機種名・台番詳細で進むときも、見ていた位置のままにする(2026-08-20夕・谷川氏指示
    //   「台番詳細ボタン押した時も上部に移動せずにそのままの位置で変わらないように
    //    する」)。押したボタンは一覧の途中にあるので、先頭へ跳ぶと今どの機種を見て
    //   いたのか分からなくなる。
    if(go){ aiNm=String(go.dataset.nm||""); aiPaint(true); return; }
    // ★は台を開かずにピンだけ付け外しする(2026-08-20夕)
    const pn=t.closest(".ai-pin");
    if(pn){ e.stopPropagation(); aiTogglePin(pn); return; }
    const gd=t.closest(".ai-god");
    if(gd){ aiOpenDai(String(gd.dataset.dai||"")); }
  });
})();

// ==== 狙い方別 期待値表のパネル(2026-08-15夕) ==============================
// 谷川氏指示「期待値表を絞り込みの中ではなくAI予想の右側に移設。あと各マスを
// 押したら該当する台番の一覧がでてきて、一覧画面の中に一覧の台を島図の台番を
// 光らせるというボタンを作ってください。そのボタンを押したら島図画面が表示される
// ようにして、その島図画面には元の画面に戻るボタンをつくってください」。
//
// ★一覧に出すのは「**今日**その狙い方に当てはまる台」(谷川氏が案Aを選択)。
//   表の数字は「過去にその狙い方で選んだ台の翌日の成績」だが、打ち手が欲しいのは
//   これから狙う台なので、同じ規則で**今日**選び直す。
// ★選び方は nerai_table.py の pick_rules / win_stats / koyaku_win を**そのまま写す**。
//   片方だけ直すと表の数字と一覧の顔ぶれが食い違うので、変えるときは両方直す。
//     ・比べるのは**機種の中**(機種をまたいで差枚を比べても意味が無い)
//     ・その機種の台が4台未満なら出さない(順位が付けられない)
//     ・窓(過去n日)に1日でも欠けがある台は外す(公平に比べられないため)
//     ・順位の狙い方は上位と下位が重ならない範囲でだけ出す(台数 >= 2k)
const NR_MINDAI = 4;
let nrView = null;        // {tab, rule, n, sel} 一覧を見ているときだけ入る
// 表を離れるときの見ていた位置(2026-08-15夕・谷川氏報告「期待値表へ戻るボタンを
// 押した時に元々の画面の位置でもどってほしいが、画面位置が初期位置でもどってしまう」)。
// 表は縦にも横にも長いので、**縦(パネル)と横(表の器)の両方**を覚える。
// 横を忘れると、過去6日のマスを押して戻ったのに過去1日の列が出る。
let nrPos = { top: 0, left: 0 };
// 一覧側の位置(2026-08-15夕・谷川氏指示「位置覚えて」)。島図で光らせてから
// 「元の画面に戻る」で帰ってきたときに、見ていた台のところへ戻す。
let nrPosList = 0;
function nrSavePos() {
  const b = document.getElementById("nrBody");
  if (!b) return;
  const w = b.querySelector(".nr-wrap");
  nrPos = { top: b.scrollTop, left: w ? w.scrollLeft : 0 };
}
function nrRestorePos(keep) {
  const b = document.getElementById("nrBody");
  if (!b) return;
  const w = b.querySelector(".nr-wrap");
  if (w) w.scrollLeft = keep ? nrPos.left : 0;
  b.scrollTop = keep ? nrPos.top : 0;
}

function nrWin(d, idx) {
  let v = 0, g = 0;
  for (const i of idx) {
    const x = (i >= 0 && i < d.length) ? d[i] : null;
    if (!x || x[0] == null || !x[1] || x[1] <= 0) return null;
    v += x[0]; g += x[1];
  }
  return { v: v, g: g };
}
// 窓の中の合計G数・合計ボーナス回数。1日でも欠けていたら null(回数は15機種だけ)。
function nrKoyakuWin(dai, idx) {
  if (!KOYAKU) return null;
  const t = ((KOYAKU.d || {})[String(dai)]) || null;
  if (!t) return null;
  const L = DATA.labels || [];
  let g = 0, bb = 0, rb = 0;
  for (const i of idx) {
    const md = String(L[i] || "").split("(")[0];
    const v = t[md];
    if (!v || !v[0]) return null;
    g += v[0]; bb += (v[1] || 0); rb += (v[2] || 0);
  }
  // BB と RB は別々にも返す(期待設定の計算に要る・2026-08-15夕)
  return { g: g, bo: bb + rb, bb: bb, rb: rb };
}
// 期待設定(2026-08-15夕・谷川氏指示「期待設定ワースト、および連続で期待設定
// 3以下・4以上」)。カードの「期間の期待設定」と**同じ関数**を通す
// (hCalcRow/hKitai)。別式を書くと必ず食い違う。
// 期待値表を作る側は Python の settei_calc.py が同じ式を持っており、
// 両者が一致することは check_settei_calc.py で突き合わせてある。
const NR_KT_LOW = 3, NR_KT_HIGH = 4;
function nrKitai(dai, g, bb, rb, v) {
  if (!KOYAKU || !(g > 0)) return null;
  const nm = ((DATA.machines || {})[String(dai)] || {}).n || "";
  const st = ((KOYAKU.st) || {})[nm] || null;
  if (!st || !st.labels) return null;
  const ky = st.koyaku;
  return hKitai(hCalcRow({ g: g, bb: bb, rb: rb }, v, ky), st,
    hDen(st.bb), hDen(st.rb), ky ? hDen(ky.settei) : null);
}
// 1日ぶんの期待設定。連続の狙い方(3以下/4以上)はこちらを日ごとに見る。
function nrKitaiDay(dai, i) {
  if (!KOYAKU) return null;
  const t = ((KOYAKU.d || {})[String(dai)]) || null;
  if (!t) return null;
  const md = String((DATA.labels || [])[i] || "").split("(")[0];
  const k = t[md];
  const d = ((DATA.machines || {})[String(dai)] || {}).d || [];
  const x = (i >= 0 && i < d.length) ? d[i] : null;
  if (!k || !k[0] || !x || x[0] == null) return null;
  return nrKitai(dai, k[0], k[1] || 0, k[2] || 0, x[0]);
}
// その機種の中から、**全部の狙い方**について選ばれる台番を一度に返す。
// {狙い方: [台番, ...]}。nerai_table.py の pick_rules と同じ形・同じ順序。
// ★1つずつ数え直すとマスの数(狙い方20×窓10=200)ぶん走ることになるので、
//   まとめて出す形にした(2026-08-15夕・マスごとの台数を出すため)。
function nrRulesAll(c) {
  const out = {}, m = c.length;
  if (m < NR_MINDAI) return out;
  const byV = c.slice().sort((a, b) => a.w.v - b.w.v);
  const byG = c.slice().sort((a, b) => a.w.g - b.w.g);
  for (let i = 0; i < 3; i++) {
    if (m >= 2 * (i + 1)) {
      out["差枚ワースト" + (i + 1)] = [byV[i].dai];
      out["差枚ベスト" + (i + 1)] = [byV[m - i - 1].dai];
    }
  }
  for (let i = 0; i < 2; i++) {
    if (m >= 2 * (i + 1)) {
      out["回転数ワースト" + (i + 1)] = [byG[i].dai];
      out["回転数ベスト" + (i + 1)] = [byG[m - i - 1].dai];
    }
  }
  const minus = c.filter(x => x.vals.every(v => v < 0)).map(x => x.dai);
  const plus = c.filter(x => x.vals.every(v => v > 0)).map(x => x.dai);
  if (minus.length) out["連続差枚マイナス"] = minus;
  if (plus.length) out["連続差枚プラス"] = plus;
  // 回数を使う狙い方。材料があるのは15機種だけなので、無ければ静かに出さない
  const ky = c.filter(x => x.w.bo != null);
  if (ky.length >= NR_MINDAI) {
    const byB = ky.slice().sort((a, b) => a.w.bo - b.w.bo);
    // 合算確率＝G÷ボーナス回数。**大きいほど悪い**ので降順が「ワースト」
    const go = ky.filter(x => x.w.bo > 0)
      .sort((a, b) => (b.w.kg / b.w.bo) - (a.w.kg / a.w.bo));
    for (let i = 0; i < 2; i++) {
      if (ky.length >= 2 * (i + 1)) {
        out["ボナ回数ワースト" + (i + 1)] = [byB[i].dai];
        out["ボナ回数ベスト" + (i + 1)] = [byB[ky.length - i - 1].dai];
      }
      if (go.length >= 2 * (i + 1)) {
        out["合算確率ワースト" + (i + 1)] = [go[i].dai];
        out["合算確率ベスト" + (i + 1)] = [go[go.length - i - 1].dai];
      }
    }
  }
  // 期待設定を使う狙い方(2026-08-15夕)。nerai_table.py の pick_rules と同じ順番。
  const kt = c.filter(x => x.w.kt != null);
  if (kt.length >= NR_MINDAI) {
    const byK = kt.slice().sort((a, b) => a.w.kt - b.w.kt);
    for (let i = 0; i < 2; i++) {
      if (kt.length >= 2 * (i + 1)) {
        out["期待設定ワースト" + (i + 1)] = [byK[i].dai];
        out["期待設定ベスト" + (i + 1)] = [byK[kt.length - i - 1].dai];
      }
    }
  }
  // 連続系は台を1つに絞らず、当てはまる台を全部拾う(差枚の連続と同じ)。
  // ★窓の全日に期待設定が出ている台だけが対象(1日でも欠けたら外す)。
  const lo = c.filter(x => x.ktd && x.ktd.length
    && x.ktd.every(v => v != null && v <= NR_KT_LOW)).map(x => x.dai);
  const hi = c.filter(x => x.ktd && x.ktd.length
    && x.ktd.every(v => v != null && v >= NR_KT_HIGH)).map(x => x.dai);
  if (lo.length) out["連続期待設定3以下"] = lo;
  if (hi.length) out["連続期待設定4以上"] = hi;
  return out;
}
function nrRulePick(c, rule) {
  return nrRulesAll(c)[rule] || [];
}
// 今日その狙い方に当てはまる台。
// 返り値は [{dai, nm, w:{v,g,...}, dip:{k,minus,v}}, ...]
//   w   … 過去n日(窓)の合計差枚・合計G数。表を作るときと同じ集計
//   dip … いま何日つづけてマイナス/プラスか(dipAt と同じもの)
// ★2026-08-15夕に w / dip を返すようにした(谷川氏指示「期待値枚数や台毎の
//   連続差枚数などの情報も一覧に付け加える」)。
// 1台ぶんの「窓の集計」を作る(2026-08-15夕にここへ切り出した)。
// nrPick と nrCounts の2か所で同じものを作っていたので、期待設定を足すときに
// 片方だけ直す事故を防ぐ。★中身は nerai_table.py の cands と同じ形。
let NR_KTD = {};        // 日ごとの期待設定は使い回す(窓の数だけ計算し直さない)
function nrKitaiDayC(dai, i) {
  const k = dai + "|" + i;
  if (k in NR_KTD) return NR_KTD[k];
  return (NR_KTD[k] = nrKitaiDay(dai, i));
}
function nrCand(dai, idx) {
  const d = (DATA.machines[dai] || {}).d || [];
  const w = nrWin(d, idx);
  if (!w) return null;
  const kw = nrKoyakuWin(dai, idx);
  if (kw) {
    w.bo = kw.bo; w.kg = kw.g;
    w.kt = nrKitai(dai, kw.g, kw.bb, kw.rb, w.v);
  }
  const ktd = idx.map(i => nrKitaiDayC(dai, i));
  return { dai: dai, w: w, vals: idx.map(i => d[i][0]),
           ktd: ktd.some(x => x == null) ? null : ktd };
}
function nrPick(tab, rule, n) {
  const L = DATA.labels || [], t = L.length;
  if (t - n < 0) return [];
  const idx = [];
  for (let i = t - n; i < t; i++) idx.push(i);
  const by = {};
  Object.keys(DATA.machines || {}).forEach(dai => {
    const m = DATA.machines[dai] || {}, nm = m.n || "";
    if (!nm) return;
    if (tab.kind === "kishu") { if (nm !== tab.n) return; }
    else if (aiKind(nm) !== tab.t) return;
    (by[nm] = by[nm] || []).push(dai);
  });
  const out = [];
  Object.keys(by).forEach(nm => {
    const dais = by[nm];
    if (dais.length < NR_MINDAI) return;
    const cands = [], byDai = {};
    dais.forEach(dai => {
      const c = nrCand(dai, idx);
      if (!c) return;
      cands.push(c);
      byDai[dai] = c;
    });
    nrRulePick(cands, rule).forEach(dai => {
      const c = byDai[dai] || {};
      out.push({ dai: dai, nm: nm, w: c.w || null,
                 dip: dipAt((DATA.machines[dai] || {}).d || [], t) });
    });
  });
  return out;
}
// マスごとの「いま当てはまる台数」(2026-08-15夕・谷川氏指示
// 「マスごとに台数が見えるようにしてください」)。
// 押す前に、どのマスに台が居るのかが分かるようにする(0台のマスの方が多い)。
// ★窓ごとに1回だけ台を集めて、全部の狙い方に当てる。マスごとに数え直すと
//   200回ぶん走ることになる(狙い方20×窓10)。
// 返り値: {狙い方: {窓: 台数}}
let NR_CNT = {};      // タブごとに覚える(表を描き直すたびに数え直さない)
function nrCounts(tab, maxn) {
  const key = tab.k + "|" + maxn + "|" + (KOYAKU ? "k" : "-");
  if (NR_CNT[key]) return NR_CNT[key];
  const L = DATA.labels || [], t = L.length, out = {};
  const by = {};
  Object.keys(DATA.machines || {}).forEach(dai => {
    const m = DATA.machines[dai] || {}, nm = m.n || "";
    if (!nm) return;
    if (tab.kind === "kishu") { if (nm !== tab.n) return; }
    else if (aiKind(nm) !== tab.t) return;
    (by[nm] = by[nm] || []).push(dai);
  });
  const names = Object.keys(by);
  for (let n = 1; n <= maxn; n++) {
    if (t - n < 0) break;
    const idx = [];
    for (let i = t - n; i < t; i++) idx.push(i);
    names.forEach(nm => {
      const dais = by[nm];
      if (dais.length < NR_MINDAI) return;
      const cands = [];
      dais.forEach(dai => {
        const c = nrCand(dai, idx);
        if (c) cands.push(c);
      });
      const picks = nrRulesAll(cands);
      Object.keys(picks).forEach(rule => {
        (out[rule] = out[rule] || {})[n] =
          (out[rule][n] || 0) + picks[rule].length;
      });
    });
  }
  NR_CNT[key] = out;
  return out;
}
// その機種でこの狙い方をしたときの期待値(2026-08-15夕・谷川氏指示
// 「期待値が高い順番に並べて」)。
// ★台1台ぶんの実績は9〜10台日しか無く、そこから期待値は出せない。
//   同じ表の**機種ごとのタブ**に、まさに「その機種でこの狙い方をしたときの
//   翌日の実績」があるので、それを台の期待値として使う(同じ機種の台は同じ値)。
//   機種ごとのタブが無い/その窓のマスが薄いときは、押したマス(全体)の値を使う。
// 返り値: {r:出率, v:平均差枚, n:件数, src:"機種"|"全体"} または null
function nrExp(D, nm, rule, n, fallback) {
  const kt = (D.tabs || []).find(t => t.kind === "kishu" && t.n === nm);
  if (kt) {
    const row = (kt.rows || []).find(r => r.r === rule);
    const c = row && (row.c || [])[n - 1];
    if (c) return { r: c[0], v: c[1], n: c[2], src: "機種" };
  }
  if (fallback) return { r: fallback[0], v: fallback[1], n: fallback[2], src: "全体" };
  return null;
}
// 回数(G数・BB・RB)の記録が要る狙い方。AT機には元データが無いので出ない。
// ★期待設定も回数から出す(2026-08-15夕に足した)。ここに書き忘れると
//   AT機のタブで「材料が無いのに0台」と出て、理由が読めなくなる。
function nrNeedsKoyaku(rule) {
  return /^(ボナ回数|合算確率|期待設定|連続期待設定)/.test(rule || "");
}
// 一覧を描く。
// ★並びは**期待値の高い順**(2026-08-15夕・谷川氏指示)。期待値は機種ごとに決まる
//   ので、結果として機種のまとまりが期待値の順に並ぶ。同じ機種の中は
//   **深く凹んでいる順**(窓の合計差枚が小さい順)にする。
// ★順位付けに使うのは「平均差枚」で出率ではない。出率は割り算なので回っていない台
//   ほど跳ねる(memory: 沖ドキ！ゴージャスは106.03%なのに差枚-241枚)。
function nrPaintList(tab, rule, n, keep) {
  const body = document.getElementById("nrBody");
  const back = document.getElementById("nrBack");
  const ttl = document.getElementById("nrTitle");
  if (!body) return;
  if (back) back.hidden = false;
  if (ttl) ttl.textContent = "該当する台";
  const sel = nrPick(tab, rule, n);
  // 押したマスの値(機種ごとの数字が無いときの控え)
  const trow = (tab.rows || []).find(r => r.r === rule);
  const fb = trow && (trow.c || [])[n - 1];
  const by = {};
  sel.forEach(x => { (by[x.nm] = by[x.nm] || []).push(x); });
  const names = Object.keys(by).sort((a, b) => {
    const ea = nrExp(NERAI, a, rule, n, fb), eb = nrExp(NERAI, b, rule, n, fb);
    const va = ea ? ea.v : -1e9, vb = eb ? eb.v : -1e9;
    return (va === vb) ? (by[b].length - by[a].length) : (vb - va);
  });
  names.forEach(nm => by[nm].sort((a, b) =>
    ((a.w ? a.w.v : 0) - (b.w ? b.w.v : 0))));
  // 光らせる順も期待値の順にそろえる(見ている順で光るように)
  nrView = { tab: tab, rule: rule, n: n,
             sel: [].concat.apply([], names.map(nm => by[nm])) };
  let h = '<div class="nr-lh">' + esc(rule) + ' ／ 過去' + n + '日'
    + '<br><span style="font-weight:normal">' + esc(tab.n) + '</span></div>'
    + '<div class="nr-lsub">いま（' + esc(String((DATA.labels || []).slice(-1)[0] || ""))
    + ' までのデータ）でこの狙い方に当てはまる台です。'
    + '機種の中で比べて選んでいます（4台以上ある機種だけ）。<br>'
    + '並びは<b>期待値（平均差枚）の高い順</b>。期待値はその機種で同じ狙い方をした'
    + 'ときの実績で、1台ごとの当たりを約束するものではありません。</div>';
  if (!sel.length) {
    h += '<div class="nr-none">今日この狙い方に当てはまる台はありません。'
      + (nrNeedsKoyaku(rule)
        ? 'この狙い方は回数（ボーナス回数）の記録がある機種にしか出ません。' : '')
      + '</div>';
    body.innerHTML = h; body.scrollTop = 0; return;
  }
  h += '<button type="button" class="nr-lit" id="nrLight">🗺️ 島図で光らせる（'
    + sel.length + '台）</button>';
  names.forEach((nm, gi) => {
    const e = nrExp(NERAI, nm, rule, n, fb);
    h += '<div class="nr-lg"><div class="nr-lgn">'
      + '<span class="nr-rk">' + (gi + 1) + '</span>' + esc(nm)
      + '<span>' + by[nm].length + '台</span></div>';
    if (e) {
      h += '<div class="nr-exp' + (e.v > 0 ? " up" : (e.v < 0 ? " dn" : "")) + '">'
        + '期待値 <b>' + aiSv(e.v) + '</b>／出率 <b>' + e.r.toFixed(1) + '%</b>'
        + '<span class="nr-expn">' + (e.src === "機種" ? "この機種" : "全体")
        + 'の実績 ' + e.n.toLocaleString() + '件</span></div>';
    }
    h += '<div class="nr-dl">' + by[nm].map(x => {
      const w = x.w || {}, dp = x.dip;
      const st = dp
        ? ((dp.minus ? "連続マイナス " : "連続プラス ") + dp.k + "日 "
           + aiSv(dp.v))
        : "前日のデータなし";
      return '<button type="button" class="nr-dr" data-dai="' + esc(x.dai) + '">'
        + '<span class="nr-dn">' + esc(x.dai) + '</span>'
        + '<span class="nr-dd"><span class="' + aiCl(w.v) + '">過去' + n + '日 '
        + aiSv(w.v) + '</span> ／ ' + (w.g || 0).toLocaleString() + 'G'
        + '<em>' + esc(st) + '</em></span></button>';
    }).join("") + '</div></div>';
  });
  h += '<div class="nr-lsub">台番を押すと、その台の3週間のグラフが開きます。</div>';
  body.innerHTML = h;
  // 島図から「元の画面に戻る」で帰ってきたときは、見ていた台のところへ戻す
  // (2026-08-15夕・谷川氏指示「位置覚えて」)。開いた直後は頭から。
  body.scrollTop = keep ? nrPosList : 0;
  if (keep) requestAnimationFrame(() => { body.scrollTop = nrPosList; });
}
// 表を描く。keep=true なら**見ていた位置に戻す**(一覧から帰ってきたとき)。
function nrPaintTable(keep) {
  const body = document.getElementById("nrBody");
  const back = document.getElementById("nrBack");
  const ttl = document.getElementById("nrTitle");
  if (!body) return;
  nrView = null;
  if (back) back.hidden = true;
  if (ttl) ttl.textContent = "狙い方別 期待値表";
  if (NERAI && (NERAI.tabs || []).length) {
    body.innerHTML = nrTapNote() + nrIntro(NERAI) + nrHtml(NERAI);
    // 描いた直後だと器の大きさがまだ決まっておらず scrollLeft が入らないことが
    // あるので、次の描画でもう一度当てる(実機で1回目が効かないことがある)
    nrRestorePos(keep);
    requestAnimationFrame(() => nrRestorePos(keep));
    return;
  }
  body.innerHTML = '<div class="dempty">読み込み中…</div>';
  neraiLoad().then(j => {
    if (nrView) return;      // 読み終える前に一覧へ進んでいたら何もしない
    body.innerHTML = (j && (j.tabs || []).length)
      ? (nrTapNote() + nrIntro(j) + nrHtml(j))
      : '<div class="dempty">期待値表がまだ作られていません。</div>';
    nrRestorePos(keep);
    requestAnimationFrame(() => nrRestorePos(keep));
  });
}
(function () {
  const btn = document.getElementById("nrBtn");
  const md = document.getElementById("nrModal");
  const body = document.getElementById("nrBody");
  const back = document.getElementById("nrBack");
  if (!btn || !md || !body) return;
  // 表そのものが配られていない版では押せなくする(押しても何も出ない、を作らない)
  if (!(typeof SHIMA !== "undefined" && SHIMA && SHIMA.neraiUrl)) btn.disabled = true;
  const open = () => {
    md.style.display = "block";
    if (typeof fitAiModal === "function") fitAiModal("nrCard");
  };
  btn.addEventListener("click", () => {
    open();
    nrPos = { top: 0, left: 0 };   // 開き直しは頭から
    nrPaintTable(false);
    // 回数を使う狙い方(ボナ回数・合算確率)に要るので、裏で読んでおく。
    // **開くまで落とさない**約束は守りつつ、押した瞬間に待たせないため。
    // ★届いたら表を描き直す。回数が無いとボナ回数・合算確率のマスの台数が
    //   0台のままになり、実際は居るのに「居ない」と読めてしまう。
    if (typeof koyLoad === "function") {
      const had = !!KOYAKU;
      koyLoad().then(() => {
        if (!had && KOYAKU && !nrView && md.style.display === "block") {
          nrSavePos();          // 裏で描き直すだけなので、見ている位置は保つ
          nrPaintTable(true);
        }
      });
    }
  });
  const close = () => { md.style.display = "none"; };
  const cb = document.getElementById("nrClose");
  if (cb) cb.addEventListener("click", close);
  md.addEventListener("click", e => { if (e.target === md) close(); });
  // ★戻るときは**見ていた位置に戻す**(2026-08-15夕・谷川氏報告)
  if (back) back.addEventListener("click", () => nrPaintTable(true));
  body.addEventListener("click", e => {
    const t = e.target;
    if (!t || !t.closest) return;
    // 読み方の図は押すと大きく見られる(2026-08-16)。パネル幅では引き出し線の
    // 説明文が小さいので、全画面の写真ビューア(openPhoto)へ渡す。
    const fig = t.closest(".nr-fig img");
    if (fig) {
      e.stopPropagation();
      // 全画面の覆いではなく**説明の図だけのページへ移る**(2026-08-17・実機が
      // 落ちるため。理由は openFigPage の説明を参照)。
      openFigPage(fig.src,fig.alt,"nr");
      return;
    }
    // 「どれを見るか」のタブ
    const tb = t.closest(".nr-tb");
    if (tb && NERAI) {
      nrTab = tb.dataset.nk;
      const cur = body.querySelector(".nr-box");
      if (cur) cur.outerHTML = nrHtml(NERAI);
      return;
    }
    // マスを押すと、今日その狙い方に当てはまる台の一覧へ
    const td = t.closest("td.nr-c1");
    if (td && NERAI) {
      const tab = (NERAI.tabs || []).find(x => x.k === nrTab) || (NERAI.tabs || [])[0];
      const rule = td.dataset.nrr, n = parseInt(td.dataset.nrn, 10);
      if (!tab || !rule || !n) return;
      nrSavePos();    // 戻ってきたときに同じ場所を見せるため、いまの位置を覚える
      if (nrNeedsKoyaku(rule) && !KOYAKU && typeof koyLoad === "function") {
        body.innerHTML = '<div class="dempty">回数のデータを読み込み中…</div>';
        koyLoad().then(() => nrPaintList(tab, rule, n));
        return;
      }
      nrPaintList(tab, rule, n);
      return;
    }
    // 島図で光らせる
    if (t.closest("#nrLight") && nrView && nrView.sel.length) {
      const v = nrView, dais = v.sel.map(x => x.dai);
      nrPosList = body.scrollTop;     // 見ていた位置を覚えておく
      // 「元の画面に戻る」で、いま見ていた一覧へ帰す(台入替の内訳と同じ仕組み)
      setMvBack(() => {
        md.style.display = "block";
        if (typeof fitAiModal === "function") fitAiModal("nrCard");
        nrPaintList(v.tab, v.rule, v.n, true);
      });
      close();
      showLights(dais, v.rule + "（過去" + v.n + "日）", "new", "該当台");
      return;
    }
    // 台番を押すとその台のカードを開く
    const ch = t.closest(".nr-dr") || t.closest(".nr-chip");
    if (ch) {
      const dai = String(ch.dataset.dai || "");
      if (!DATA.machines[dai]) return;
      close();
      if (typeof curView !== "undefined" && curView === "island") focusDai(dai);
      renderCard(dai, NDAYS);
    }
  });
})();
// ---- 午前中の数字の計算(2026-08-11) ----
// 島図のセル(台ごとの期待設定)とカードの表の両方から呼ぶので、paintHiru の中に
// 閉じ込めず、ここに置いている。中身は「二項分布の確からしさで設定を重み付けする」
// 一本の考え方で、けんスロの判別ページと実データで突き合わせ済み。
// log(n!) の近似(スターリング。回数が多いので階乗はそのまま持てない)
function hLg(n){
  if(n<2) return 0;
  let s=0; for(let i=2;i<=n&&i<=170;i++) s+=Math.log(i);
  if(n<=170) return s;
  return n*Math.log(n)-n+0.5*Math.log(2*Math.PI*n)+1/(12*n);
}
// 二項分布の対数確率(n回まわしてk2回起きる確からしさ)
function hLbin(k2,n,p){
  if(!(n>0)||!(p>0)||!(p<1)||k2<0||k2>n) return null;
  return hLg(n)-hLg(k2)-hLg(n-k2)+k2*Math.log(p)+(n-k2)*Math.log1p(-p);
}
// 「1/273.1」や「5.910」から分母だけを取り出す(設定別の目安と突き合わせるため)
function hDen(a){
  return (a||[]).map(x=>{
    const s=String(x||"");
    const m=/^1\/([\d.]+)$/.exec(s);
    const v=m?parseFloat(m[1]):parseFloat(s);
    return (v>0)?v:null;
  });
}
// 確からしさ(対数)の並び → 段の番号で重み付けした平均と、各段の割合(%)
function hMean(L){
  if(!L||!L.length||L.some(x=>x==null)) return null;
  const mx=Math.max.apply(null,L);
  const w=L.map(x=>Math.exp(x-mx));
  const s=w.reduce((a,b)=>a+b,0);
  if(!(s>0)) return null;
  // 設定Vのように数字でない段は「その位置＋1」を番号として扱う
  return {mean:w.reduce((a,x,i)=>a+(i+1)*x/s,0), pct:w.map(x=>x/s*100)};
}
// 1項目ぶんの推定設定(2026-08-11・谷川氏指示「推定設定の数字①〜⑥から
// 通常数字で小数点第二まで」)。**丸数字のときと同じ「いちばん近い設定」の考え方**を
// 保ったまま、段と段の間も見えるように連続の数にした。目安の間に入るときは
// その割合で按分し、端を超えるときは端の段に丸める。
// 二項分布で重み付けした平均(=期待設定の出し方)は使わない。それだと同じ 1/207 でも
// 回数が少ないと中央へ引き戻され、丸数字が⑥だった台が3.92のように別の意味になる。
function hNearF(mine,list){
  if(!(mine>0)||!list||!list.length) return null;
  const p=[];                       // [段の番号, 分母] の使える組だけ
  list.forEach((v,i)=>{ if(v>0) p.push([i+1,v]); });
  if(!p.length) return null;
  if(p.length===1) return p[0][0];
  for(let i=0;i<p.length-1;i++){
    const a=p[i], b=p[i+1];
    if(mine>=Math.min(a[1],b[1])&&mine<=Math.max(a[1],b[1]))
      return a[0]+(mine-a[1])/(b[1]-a[1])*(b[0]-a[0]);
  }
  const first=p[0], last=p[p.length-1];
  // 段が上がるほど分母が小さい並び(BB/RB/合成/ブドウはすべてこれ)かどうかで、
  // どちら側の端に丸めるかが変わる。
  const asc=last[1]>first[1];
  if(asc) return (mine<first[1])?first[0]:last[0];
  return (mine>first[1])?first[0]:last[0];
}
// 1台ぶん(または機種合計ぶん)の値をまとめて作る。
// ブドウ／ベルの逆算: (差枚 + C×G - BIG枚数×BB - REG枚数×RB) ÷ 1回の払い出し枚数。
// **Cは前任者の目押しレベルで変わる**ので、どのレベルだったかは分からないまま
// 幅として並べて出す。
function hCalcRow(r,v,ky){
  if(!r) return null;
  const g=r.g, bb=r.bb, rb=r.rb, o={g:g, v:v, bb:bb, rb:rb};
  o.bbD=(bb>0&&g>0)?(g/bb):null;
  o.rbD=(rb>0&&g>0)?(g/rb):null;
  const n=(bb||0)+(rb||0);
  o.gtD=(n>0&&g>0)?(g/n):null;
  if(ky&&g>0&&typeof v==="number"){
    o.ko={}; o.koN={};
    (ky.show||[]).forEach(lv=>{
      const C=(ky.Cs||{})[lv];
      if(!(C>0)) return;
      const c=(v + C*g - ky.big*(bb||0) - ky.reg*(rb||0))/ky.pay;
      if(c>0){ o.ko[lv]=g/c; o.koN[lv]=c; }
    });
  }
  return o;
}
// 期待設定。BIG・REG・ブドウ/ベルをそれぞれ二項分布で見た確からしさの積を
// 合計1にならし、段の番号で重み付けした平均。ブドウは「チェリー狙い」の逆算値を
// 使う(けんスロの既定と同じ)。実データで突き合わせ済み
// (4,950G/BIG17/REG21/ブドウ823 → 3.92。こちらの計算も3.92)。
function hKitai(o,st,sBB,sRB,sKO){
  if(!o||!(o.g>0)||!st||!st.labels||!sBB||!sRB) return null;
  // ★ボーナスが1回も出ていない台は設定を出さない(2026-08-14夕・谷川氏指示
  //   「推定設定もまだだせないはずだから-にしたほうがよい」)。
  //   計算そのものは通るが、BB0・RB0でG数が少ないうちはどの設定でも確からしさが
  //   ほとんど変わらず、答えが段の真ん中に張り付くだけで中身が無い
  //   (実測: 33G・BB0・RB0 で 3.5 と出ていた)。ブドウの逆算も差枚が要るので、
  //   差枚の読めない台では効かない。分からないものは「−」のままにする。
  if(!(((o.bb||0)+(o.rb||0))>0)) return null;
  const gn=o.koN?Math.round(o.koN["チェリー狙い"]):null;
  const L=st.labels.map((lb,i)=>{
    let s=0, ok=false;
    const a=hLbin(o.bb||0,o.g,sBB[i]?1/sBB[i]:0); if(a!=null){ s+=a; ok=true; }
    const b=hLbin(o.rb||0,o.g,sRB[i]?1/sRB[i]:0); if(b!=null){ s+=b; ok=true; }
    if(gn!=null&&sKO&&sKO[i]>0){ const c=hLbin(gn,o.g,1/sKO[i]); if(c!=null) s+=c; }
    return ok?s:null;
  });
  const r=hMean(L);
  if(!r) return null;
  o.pct=r.pct;
  return r.mean;
}
// 台1つぶんの期待設定(島図のセルに出す用・2026-08-11・谷川氏指示
// 「台番上の位置区分の右側の①〜⑥のところも、午前中を押した時のその台の
//  期待設定を表示する」)。設定別の台帳が無い機種(AT機など)は null。
function hiruKitaiDai(dai){
  const D=window.HIRU&&window.HIRU.data;
  if(!D||!D.k) return null;
  const key=String(dai), k=D.k[key];
  if(!k) return null;
  const st=(D.st||{})[(D.mn||{})[key]]||null;
  if(!st||!st.labels) return null;
  const ky=st.koyaku;
  return hKitai(hCalcRow(k,(D.v||{})[key],ky),st,
                hDen(st.bb),hDen(st.rb),ky?hDen(ky.settei):null);
}
// 台番セルの1行目「位置区分＋推定設定(丸数字)」の推定設定のところを、
// 午前中の期待設定(小数)に差し替える(2026-08-11・谷川氏指示)。
// 島図に元から出ている丸数字は**対象期間の合算**で出したもの。午前中を見ている間に
// 並んでいると、どちらの数字か分からなくなるので、その場所を今日の午前中に譲る。
// 元の中身は覚えておいて、消すときに書き戻す。
function setCellKitai(el){
  const kt=hiruKitaiDai(el.dataset.dai);
  if(kt==null) return;
  // **島図の中は丸数字のまま**(2026-08-11・谷川氏指示「島図の台番の上の推定設定は
  // ①〜⑥でよい。表記が崩れるため」)。台番セルは1行に「位置区分＋推定設定」を
  // 収める幅しかなく、小数(3.53)にすると2〜3文字ぶん増えて台番が押し出される。
  // 期待設定はいちばん近い段へ丸めて、元の丸数字と同じ見た目にそろえる。
  // カードの表のほうは小数のまま(そちらは幅に余裕があり、細かさに意味がある)。
  const mi=Math.round(kt);
  if(!(mi>=1&&mi<=9)) return;
  const mk="①②③④⑤⑥⑦⑧⑨"[mi-1];
  // 期間の貼り替えでセルが描き直されることがあるので、**まだ差し替えていないときだけ**
  // 覚え直す(差し替え後の中身を元と誤って覚えると台番が二重になる)。
  if(!/ktn/.test(el.innerHTML)) el.dataset.h0=el.innerHTML;
  const h=el.dataset.h0||"";
  const m=/<br\s*\/?>/i.exec(h);
  if(!m) return;
  const head=h.slice(0,m.index).replace(/[①-⑨]/g,"");
  // **全体を1つの span で包む**(2026-08-12・谷川氏の実機写真で判明)。
  // .cell は display:flex なので、中に要素を直接置くとそこが独立したフレックス項目に
  // なり、「位置区分＋推定設定」と「台番」が改行されずに**横並び**になる
  // (中内/1 と ④260/6 が2列に割れる)。包みを1枚かませば中身は普通の行として流れ、
  // br が効いて元どおり2行になる。.ktn は検証が数えているので残す
  // (verify_shimaheat_hiru.py の `.tap .ktn`)。
  el.innerHTML='<span class="kwrap">'+head+'<span class="ktn">'+mk+"</span>"
               +h.slice(m.index)+"</span>";
}
function clearCellKitai(el){
  if(el.dataset.h0!=null){ el.innerHTML=el.dataset.h0; delete el.dataset.h0; }
}
// ---- 今日の午前中の実数をカードに出す(2026-08-11・谷川氏指示
//      「午前中に取得したG数、BB、RB、差枚数…が台番を押したときに見れるように」
//      「機種毎の合計も同じようにが各台番押した時に合わせて見えるように」) ----
// window.HIRU は下の「今日の午前中」のかたまりが出し入れする {on, data}。
//   data.k = 台番ごとの {g, bb, rb, gt} / data.m = 機種ごとの合計 / data.mn = 台番→機種名
// **出しているときだけ**表示する。押していないのに今日の数字が混ざると、
// いま見ている期間(直近7日など)の数字と取り違える。
// 合成確率はこちらで (BB+RB) から割り直す=合計行にも同じ物差しで出せるようにするため
// (サイトが出す台ごとの値 gt とは丸めの分だけずれることがある)。
function paintHiru(dai){
  const el=document.getElementById("mhiru"); if(!el) return;
  const H=window.HIRU;
  // 午前中を出していない(または今日の数字が無い)ときは、**同じ場所に期間の詳細**を出す
  // (2026-08-12・谷川氏指示)。要素を1つにしておくと、見た目の作りも1つで済む。
  const hide=()=>paintDetail(dai);
  if(!H||!H.on||!H.data||!H.data.k) return hide();
  const D=H.data, key=String(dai), k=D.k[key], nm=(D.mn||{})[key];
  const tot=nm?(D.m||{})[nm]:null;
  if(!k&&!tot) return hide();
  const st=(D.st||{})[nm]||null;      // 設定別の台帳(settei_table.json 由来)
  const ky=st&&st.koyaku;             // ブドウ/ベルの逆算の係数

  const num=v=>(typeof v==="number")?v.toLocaleString():"−";
  const sgn=v=>(typeof v!=="number")?"−":((v>0?"+":"")+v.toLocaleString());
  // 詳細一覧の見出し用。**推定設定の欄は丸数字をやめて小数にした**(2026-08-11)ので、
  // 丸数字が残るのは「設定別の一覧」の見出しだけ。
  const MARU="①②③④⑤⑥⑦⑧⑨";
  // 設定別の分母は hKitai の**呼び出しより前**に用意する(2026-08-11)。
  // const は巻き上がっても初期化前は触れない(TDZ)ため、下に置いたままだと
  // 「今日の午前中」を出した状態で台番カードを開いた瞬間に
  // ReferenceError でカードが開かなくなる。
  // file:// では hiru.json を読めず昼が点かないのでローカル検証は素通りし、
  // 本番URLの検証だけが捕まえた。
  const sBB=st?hDen(st.bb):null, sRB=st?hDen(st.rb):null;
  const sGT=(sBB&&sRB)?sBB.map((b,i)=>{
    const r=sRB[i]; return (b>0&&r>0)?(1/(1/b+1/r)):null; }):null;
  const sKO=ky?hDen(ky.settei):null;

  const A=hCalcRow(k,(D.v||{})[key],ky);
  const B=tot?hCalcRow(tot,tot.v,ky):null;
  if(A) A.kitai=hKitai(A,st,sBB,sRB,sKO);
  if(B) B.kitai=hKitai(B,st,sBB,sRB,sKO);

  // 1機種ぶんのセルは「回数／内容／推定設定」の3つに分ける
  // (2026-08-11・谷川氏指示「回数、内容、推定設定の列を入れて縦線もいれて見やすく」)。
  // 推定設定は小数第1位まで(2026-08-12・谷川氏指示「台番タップして開いた画面内の
  // 推定設定は小数点第1にする」。前日は第2位だった)。**画面の推定設定は全部この桁**
  // にそろえる=期待設定の行・詳細一覧も同じ。確率の「1/5.85」は推定設定ではないので
  // 第2位のまま(桁を落とすと設定の見分けが付かなくなる)。
  const c3=(n,body,se)=>"<td>"+n+'</td><td class="hc">'+body+'</td><td class="hs">'
    +(se==null?"":'<span class="hb">'+se.toFixed(1)+"</span>")+"</td>";
  const cell=(o,kind)=>{
    if(!o) return c3("−","","");
    // G数の内容は「何位/全○台中」(台の列だけ。合計は順位に意味が無い)
    if(kind==="g")  return c3(num(o.g),
      (o===A&&rankG)?(rankG+"位/全"+rankN+"台中"):"",null);
    // 差枚の内容は出率(2026-08-11・谷川氏指示)。1G=3枚として (3G+差枚)/3G。
    if(kind==="v"){
      const rr=rate(o.v,o.g);
      return '<td class="'+(o.v>0?"plus":(o.v<0?"minus":""))+'">'+sgn(o.v)
        +'</td><td class="hc">'+(rr!=null?(rr.toFixed(1)+"%"):"")+'</td><td class="hs"></td>';
    }
    if(kind==="bb") return c3(num(o.bb),o.bbD?("1/"+Math.round(o.bbD)):"−",
      hNearF(o.bbD,sBB));
    if(kind==="rb") return c3(num(o.rb),o.rbD?("1/"+Math.round(o.rbD)):"−",
      hNearF(o.rbD,sRB));
    if(kind==="gt") return c3((o.bb!=null&&o.rb!=null)?num((o.bb||0)+(o.rb||0)):"−",
      o.gtD?("1/"+Math.round(o.gtD)):"−",hNearF(o.gtD,sGT));
    if(kind==="kitai"){
      // 期待設定は「推定設定」の欄だけに入れる(谷川氏指示)
      const e=o.kitai;
      return '<td></td><td class="hc"></td><td class="hs">'
        +(e?('<span class="hb">'+e.toFixed(1)+"</span>"):"")+"</td>";
    }
    if(kind&&kind.indexOf("ko:")===0){
      const lv=kind.slice(3), d=(o.ko||{})[lv], c=(o.koN||{})[lv];
      return c3(c?Math.round(c).toLocaleString():"−",
                d?("1/"+d.toFixed(2)):"−",hNearF(d,sKO));
    }
    return c3("−","",null);
  };

  let h='<div class="hh">'+(D.date?hiruDayLabel(D.date):"今日")+'の午前中（'+(D.at||"")+' 時点';
  if(D.kat&&D.kat!==D.at) h+=' ／ 回数は '+D.kat;
  h+='）</div>';
  // 右の列は機種名を出さない(2026-08-11・谷川氏指示「機種名は無しにして全台(〇〇台)とする」)。
  // 機種名は見出しの2行目に出ているので、ここでは何台ぶんの合計かだけが分かればよい。
  // 名前が長いと列が広がって表が横に出る、という実害もあった。
  const c2=(tot&&tot.n)?("全台（"+tot.n+"台）"):"全台";
  // 同じ機種の中でのG数の順位(2026-08-11・谷川氏指示「G数 何位/全○台中」)。
  // 回されている台ほど上に来るので、朝から人が付いているかの目安になる。
  let rankG=null, rankN=null;
  if(nm&&D.k&&D.mn&&k&&k.g>0){
    const gs=[];
    Object.keys(D.k).forEach(x=>{ if(D.mn[x]===nm&&D.k[x]&&D.k[x].g>0) gs.push(D.k[x].g); });
    gs.sort((a,b)=>b-a);
    rankN=gs.length; rankG=gs.indexOf(k.g)+1;
  }
  // 見出しは2段。上が「台◯◯／機種名」、下が「回数・内容・推定設定」(谷川氏指示)
  h+='<div class="htbl"><table>'
    +'<tr class="h1"><th></th><th colspan="3">台'+dai+'</th>'
    +'<th colspan="3">'+c2+"</th></tr>"
    +'<tr class="h2"><th></th><th>回数</th><th>内容</th><th>推定設定</th>'
    +"<th>回数</th><th>内容</th><th>推定設定</th></tr>";
  const rows=[["期待設定","kitai"],["G数","g"],["差枚","v"],
              ["BB","bb"],["RB","rb"],["合成","gt"]];
  // ブドウ／ベルは前任者の目押しレベルごとに1行ずつ(どれだったか分からないため)
  if(ky) (ky.show||[]).forEach(lv=>rows.push([ky.kind+"<br><span class='hp'>"
    +lv+"</span>","ko:"+lv]));
  rows.forEach(r=>{ h+="<tr><th>"+r[0]+"</th>"+cell(A,r[1])+cell(B,r[1])+"</tr>"; });
  h+="</table></div>";
  // 詳細一覧(2026-08-11・谷川氏指示)。設定ごとの期待度を出す。
  // 中身は上で出した pct(合計100になるようにならした確からしさ)。
  if(A&&A.pct&&st&&st.labels){
    const pr=(o,lb)=>{
      if(!o||!o.pct) return "";
      return "<tr><th>"+lb+"</th>"+o.pct.map(x=>"<td>"+x.toFixed(1)+"%</td>").join("")
        +"<td>"+(o.kitai?o.kitai.toFixed(1):"−")+"</td></tr>";
    };
    const th=st.labels.map(x=>"<th>"+(/^[1-9]$/.test(String(x))
      ?MARU[parseInt(x,10)-1]:x)+"</th>").join("");
    h+='<details class="hdet"><summary>詳細一覧</summary><div class="hset">'
      +"<table><tr><th></th>"+th+"<th>期待</th></tr>"
      +pr(A,"台"+dai)+pr(B,"機種計")+"</table>"
      +'<div class="est">各設定の起こりやすさ（BB・RB・'+(ky?ky.kind:"小役")
      +"を二項分布で見た確からしさの積）。ブドウはチェリー狙いの逆算値を使用"
      +(ky&&ky.slug?'<br><a href="https://kenslo65536.com/sp/hanbetsu/'+ky.slug
        +'" target="_blank" rel="noopener">けんスロの判別ページを開く</a>':"")
      +"</div></div></details>";
  }
  // 段が数字でない機種(ニューキングハナハナV-30の「設定V」など)は、
  // 何番目が何かを添える(小数にしたので丸数字のように段の名前を出せないため)。
  const nonNum=(st&&st.labels)
    ? st.labels.map((lb,i)=>/^[1-9]$/.test(String(lb))?null:((i+1)+"＝"+lb)).filter(Boolean)
    : [];
  // 回数はあるのに差枚が「−」の台は、その理由を1行で書く(2026-08-14夕・谷川氏報告
  // 「午前中にデータがあるのになぜ台番が黒くなっている？」)。取得元が12:30時点で
  // その台のスランプグラフをまだ出しておらず、大当り一覧のG数だけが取れている状態。
  // 島図では灰色にして「回っていない台(黒)」と区別しているので、こちらでも理由を示す。
  const noV=(k&&typeof k.g==="number"&&k.g>0&&typeof (D.v||{})[key]!=="number");
  h+='<div class="est">'
    +(noV?"この台は差枚がまだ出ていません（取得元のスランプグラフが空のため）。"
          +"回数だけ出しています。<br>":"")
    +'推定設定＝いちばん近い設定（目安。段の間はその割合で小数）'
    +(nonNum.length?"。"+nonNum.join("・"):"")
    +(ky?"／"+ky.kind+"は逆算の推定。前任者の目押しで変わるので幅で出しています"
        +"（ボーナス成立後のブドウ抜きは0%として計算）":"")
    +(D.same===false?"。差枚と回数を取った時刻が違う日は"+(ky?ky.kind:"逆算")+"がずれます":"")
    +"</div>";

  // 設定別の一覧(段数は機種ごと。ニューキングハナハナV-30は①〜④＋設定Vの5段)。
  // **たたんでおく**(2026-08-11)。開いたままだとカードが縦に伸び、
  // 下端のつまみの受け口(#gripExt)が中身に隠れて「払っても閉じない」になった
  // (verify_shimaheat_grip.py が捕まえた)。
  if(st&&st.labels&&st.bb){
    h+='<details class="hdet"><summary>設定別の一覧</summary>';
    const th=st.labels.map((x,i)=>"<th>"+(/^[1-9]$/.test(String(x))
      ?MARU[parseInt(x,10)-1]:x)+"</th>").join("");
    const row=(name,list,fx)=>{
      if(!list||!list.length) return "";
      return "<tr><th>"+name+"</th>"+st.labels.map((_,i)=>"<td>"
        +(list[i]>0?("1/"+list[i].toFixed(fx)):"−")+"</td>").join("")+"</tr>";
    };
    h+='<div class="hset"><table><tr><th>設定</th>'+th+"</tr>"
      +row("BB",sBB,1)+row("RB",sRB,1)+row("合成",sGT,1)
      +(ky?row(ky.kind,sKO,2):"")+"</table>"
      +(st.note?'<div class="est">'+st.note+"</div>":"")+"</div></details>";
  }
  // 画像で保存(2026-08-12・谷川氏指示「午前中の判別結果をPNGで保存」)。
  // **画面を写し取るのではなく、同じ数値から専用の画像を描き起こす**
  // (画面写しの外部ライブラリはiOSのSafariで欠けることがあるため)。
  // 描くのに要るものを1か所にまとめて持っておく=描画側でHTMLを読み直さない。
  hiruSnap={dai:dai, nm:nm, date:D.date, at:D.at, kat:D.kat, same:D.same,
            A:A, B:B, st:st, ky:ky, sBB:sBB, sRB:sRB, sGT:sGT, sKO:sKO,
            rankG:rankG, rankN:rankN, totN:(tot&&tot.n)||null};
  h+='<div class="hsave"><button id="hiruPng" type="button">'
    +'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    +'<path d="M12 3v11M12 14l-4-4M12 14l4-4" stroke="currentColor" stroke-width="2.1" '
    +'stroke-linecap="round" stroke-linejoin="round"/>'
    +'<path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" stroke="currentColor" '
    +'stroke-width="2.1" stroke-linecap="round"/></svg>判別結果を画像で保存</button></div>';
  el.innerHTML=h; el.hidden=false;
  const pb=document.getElementById("hiruPng");
  if(pb) pb.addEventListener("click",e=>{ e.stopPropagation(); saveHiruPng(); });
  fitHiru();
}
// 画像に描くための材料(paintHiru が毎回入れ替える)。
let hiruSnap=null;
// 表の中身を**文字だけ**で作り直す(画面のHTMLからは読まない)。
// 画面側の cell() と同じ並び・同じ丸めにそろえてある(片方だけ直すとズレるので、
// 桁を変えるときは必ず両方直すこと)。
function hiruPngTable(){
  const S=hiruSnap; if(!S) return null;
  const num=v=>(typeof v==="number")?v.toLocaleString():"−";
  const sgn=v=>(typeof v!=="number")?"−":((v>0?"+":"")+v.toLocaleString());
  const f1=v=>(v==null)?"":v.toFixed(1);
  const c3=(o,kind)=>{
    if(!o) return ["−","",""];
    if(kind==="kitai") return ["","",o.kitai?o.kitai.toFixed(1):""];
    if(kind==="g") return [num(o.g),
      (o===S.A&&S.rankG)?(S.rankG+"位/全"+S.rankN+"台中"):"",""];
    if(kind==="v"){
      const rr=rate(o.v,o.g);
      return [sgn(o.v),(rr!=null?(rr.toFixed(1)+"%"):""),""];
    }
    if(kind==="bb") return [num(o.bb),o.bbD?("1/"+Math.round(o.bbD)):"−",
                            f1(hNearF(o.bbD,S.sBB))];
    if(kind==="rb") return [num(o.rb),o.rbD?("1/"+Math.round(o.rbD)):"−",
                            f1(hNearF(o.rbD,S.sRB))];
    if(kind==="gt") return [(o.bb!=null&&o.rb!=null)?num((o.bb||0)+(o.rb||0)):"−",
                            o.gtD?("1/"+Math.round(o.gtD)):"−",f1(hNearF(o.gtD,S.sGT))];
    if(kind&&kind.indexOf("ko:")===0){
      const lv=kind.slice(3), d=(o.ko||{})[lv], c=(o.koN||{})[lv];
      return [c?Math.round(c).toLocaleString():"−", d?("1/"+d.toFixed(2)):"−",
              f1(hNearF(d,S.sKO))];
    }
    return ["−","",""];
  };
  const defs=[["期待設定","kitai"],["G数","g"],["差枚","v"],
              ["BB","bb"],["RB","rb"],["合成","gt"]];
  // ブドウ／ベルの行は「ブドウ」と目押しレベルを**2行**にする(画面と同じ)。
  // 1行に並べると「ブドウ チェリー狙い」が見出しの幅に収まらず数字に重なる。
  if(S.ky) (S.ky.show||[]).forEach(lv=>defs.push([S.ky.kind+"|"+lv,"ko:"+lv]));
  return defs.map(d=>({name:d[0], kind:d[1], a:c3(S.A,d[1]), b:c3(S.B,d[1])}));
}
// 判別結果の画像を描く(2026-08-12)。**画面の見た目を写すのではなく描き起こす**ので、
// ダーク配色で見ていても保存されるのは白地の読みやすい1枚になる。
// 幅は760pxで作り、2倍の解像度で描く(スマホで拡大しても字が潰れない)。
function drawHiruPng(){
  const S=hiruSnap, rows=hiruPngTable();
  if(!S||!rows) return null;
  const R=2, W=760, PAD=22;
  // FOOT は注記の折り返し3行ぶんを見込んだ高さ(足りないと下が切れる)
  const HEAD=112, RH=34, H2=30, FOOT=56;
  const H=HEAD+H2+H2+rows.length*RH+FOOT+PAD;
  const cv=document.createElement("canvas");
  cv.width=W*R; cv.height=H*R;
  const c=cv.getContext("2d");
  c.scale(R,R);
  const FT='"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif';
  // 収まるまで字を小さくする(画面の fitTitle と同じ作法)。機種名は長いものがあり、
  // 決め打ちの大きさだと右へはみ出して切れる。
  const fitFont=(t,max,base,min,bold)=>{
    let px=base;
    const set=()=>{ c.font=(bold?"bold ":"")+px+"px "+FT; };
    set();
    while(px>min && c.measureText(t).width>max){ px-=0.5; set(); }
    return px;
  };
  c.fillStyle="#ffffff"; c.fillRect(0,0,W,H);
  // 上の帯(見出し)
  c.fillStyle="#1F3864"; c.fillRect(0,0,W,HEAD);
  c.fillStyle="#ffffff";
  c.textBaseline="alphabetic";
  fitFont("台"+S.dai+(S.nm?("　"+S.nm):""),W-PAD*2,26,15,true);
  c.fillText("台"+S.dai+(S.nm?("　"+S.nm):""),PAD,44);
  c.font="15px "+FT;
  c.fillStyle="rgba(255,255,255,.86)";
  const at=(S.date?hiruDayLabel(S.date):"今日")+"の午前中（"+(S.at||"")+" 時点"
    +((S.kat&&S.kat!==S.at)?("／回数は "+S.kat):"")+"）";
  c.fillText(at,PAD,72);
  c.fillText("プレイランドキャッスル熱田　シマヒート",PAD,96);
  // 表の枠組み
  const x0=PAD, tw=W-PAD*2;
  const wName=104, wCell=(tw-wName)/6;
  const colX=i=>x0+wName+wCell*i;
  let y=HEAD+8;
  c.textAlign="center";
  // 1段目の見出し(台◯◯ / 全台)
  c.fillStyle="#eef1f7"; c.fillRect(x0,y,tw,H2);
  c.fillStyle="#1F3864"; c.font="bold 14px "+FT;
  c.fillText("台"+S.dai,colX(0)+wCell*1.5,y+20);
  c.fillText(S.totN?("全台（"+S.totN+"台）"):"全台",colX(3)+wCell*1.5,y+20);
  y+=H2;
  // 2段目の見出し(回数 / 内容 / 推定設定)
  c.fillStyle="#f6f7fb"; c.fillRect(x0,y,tw,H2);
  c.fillStyle="#555f72"; c.font="13px "+FT;
  ["回数","内容","推定設定","回数","内容","推定設定"].forEach((t,i)=>{
    c.fillText(t,colX(i)+wCell/2,y+20);
  });
  y+=H2;
  const yTop=HEAD+8;
  // 中身
  rows.forEach((r,i)=>{
    if(i%2===1){ c.fillStyle="#fafbfd"; c.fillRect(x0,y,tw,RH); }
    c.textAlign="left";
    // 見出しは「ブドウ｜チェリー狙い」のように2段になることがある(画面と同じ)
    const nm=String(r.name).split("|");
    if(nm.length>1){
      c.fillStyle="#20293a"; c.font="bold 12.5px "+FT;
      c.fillText(nm[0],x0+8,y+16);
      c.fillStyle="#5a6478";
      fitFont(nm[1],wName-14,11,8.5,false);
      c.fillText(nm[1],x0+8,y+29);
    }else{
      c.fillStyle="#20293a";
      fitFont(r.name,wName-14,13.5,10,true);
      c.fillText(r.name,x0+8,y+22);
    }
    c.textAlign="center";
    [r.a,r.b].forEach((v,side)=>{
      v.forEach((t,j)=>{
        if(!t) return;
        const cx=colX(side*3+j)+wCell/2;
        const isNum=(j===0), isSet=(j===2);
        c.font=(isSet?"bold 14px ":(isNum?"bold 14.5px ":"12.5px "))+FT;
        // 差枚だけは色を付ける(プラス=青 / マイナス=赤。画面と同じ意味)
        c.fillStyle=(r.kind==="v"&&isNum)
          ? (t.indexOf("+")===0?"#1F5FB4":(t.indexOf("-")===0?"#C0202A":"#20293a"))
          : (isSet?"#1F3864":(isNum?"#20293a":"#5a6478"));
        c.fillText(t,cx,y+(isNum||isSet?22:21));
      });
    });
    y+=RH;
  });
  // 罫線(縦は列の区切り、横は行の区切り)
  c.strokeStyle="#d8dde8"; c.lineWidth=1;
  c.beginPath();
  for(let i=0;i<=6;i++){ const x=colX(i)+.5; c.moveTo(x,yTop); c.lineTo(x,y); }
  c.moveTo(x0+.5,yTop); c.lineTo(x0+.5,y);
  c.moveTo(x0+tw-.5,yTop); c.lineTo(x0+tw-.5,y);
  for(let i=0;i<=rows.length+2;i++){
    const yy=yTop+ (i<2?H2*i : H2*2+RH*(i-2)) +.5;
    c.moveTo(x0,yy); c.lineTo(x0+tw,yy);
  }
  c.moveTo(x0,y+.5); c.lineTo(x0+tw,y+.5);
  c.stroke();
  // 台と全台の境目だけ濃くする(左右の読み違いを防ぐ)
  c.strokeStyle="#1F3864"; c.lineWidth=1.6;
  c.beginPath(); c.moveTo(colX(3),yTop); c.lineTo(colX(3),y); c.stroke();
  // 下の注記。長くなるので**収まるまで小さくする**のではなく、幅で折り返す
  // (小さくすると読めなくなる。行が増えても下に余白があるので困らない)。
  c.textAlign="left"; c.fillStyle="#6b7488"; c.font="11.5px "+FT;
  const note="推定設定＝いちばん近い設定（目安）"
    +(S.ky?("／"+S.ky.kind+"は逆算の推定（前任者の目押しで変わります）"):"")
    +((S.same===false)?"／差枚と回数の取得時刻が違う日です":"");
  let line="", ny=y+22;
  for(const ch of note){
    if(c.measureText(line+ch).width>tw){ c.fillText(line,x0,ny); ny+=15; line=ch; }
    else line+=ch;
  }
  if(line) c.fillText(line,x0,ny);
  return cv;
}
// 画像を保存する。iOSのSafariは a[download] が効かないことがあるので、
// **共有シート(ファイル)→ダウンロード→新しいタブ**の順に落としていく
// (新しいタブでも長押しで「写真に追加」ができる)。
function saveHiruPng(){
  const S=hiruSnap;
  const cv=drawHiruPng();
  if(!cv){ showToast("画像を作れませんでした",2200); return; }
  const name="午前中判別_台"+S.dai+"_"+(S.date||"")+".png";
  cv.toBlob(async blob=>{
    if(!blob){ showToast("画像を作れませんでした",2200); return; }
    try{
      const f=new File([blob],name,{type:"image/png"});
      if(navigator.canShare&&navigator.canShare({files:[f]})){
        await navigator.share({files:[f],title:name});
        return;
      }
    }catch(e){ if(e&&e.name==="AbortError") return; }
    const url=URL.createObjectURL(blob);
    try{
      const a=document.createElement("a");
      if("download" in a){
        a.href=url; a.download=name;
        document.body.appendChild(a); a.click(); a.remove();
        showToast("✓ 画像を保存しました",2000);
      }else{ window.open(url,"_blank"); }
    }catch(e){ window.open(url,"_blank"); }
    setTimeout(()=>URL.revokeObjectURL(url),8000);
  },"image/png");
}
// 午前中の表が横へはみ出すときは、文字を1段ずつ小さくして収める(2026-08-11)。
// 「回数／内容／推定設定」の3列化で7列になり、幅320pxで82px・390pxでも12px
// はみ出して横スクロールが要る状態だった(谷川さんは横スクロールを嫌う)。
// 作法は見出し(fitTitle)・注記(fitCap)と同じ「収まるまで縮める」。列を削ったり
// 見出しの言い回しを変えたりはしない=指示どおりの中身をそのまま残す。
// 9pxまで縮めても収まらないときは、それ以上小さくすると読めないので
// .htbl の横スクロールに委ねる(情報は失わない)。
// 2026-08-13: #mhiru の中の表**全部**にかけるようにした(谷川氏報告
// 「内容詳細の方が見切れていて横スクロールしないと見れない」)。内容詳細が増えて
// 表が2つになったのに、ここは1つ目しか掴んでおらず、内容詳細だけ素の12.5pxのまま
// はみ出していた。畳んである間は幅が0で測れないので、**開かれた時にも呼ぶ**
// (paintDetail の toggle)。
// 縮め方は2段。まず字を9pxまで小さくし、それでも収まらなければ余白を詰める
// クラス(.tight)を足して**12.5pxからやり直す**。字を小さくするより余白を削る方が
// 読みやすさが残るので、詰めたうえでできるだけ大きい字に戻す、という順にしてある。
function fitHiru(){
  document.querySelectorAll("#mhiru .htbl").forEach(tb=>{
    if(!tb.clientWidth) return;
    const t=tb.querySelector("table"); if(!t) return;
    const shrink=()=>{
      t.style.fontSize="";
      let px=12.5;
      while(px>9 && tb.scrollWidth>tb.clientWidth+0.5){
        px-=0.5; t.style.fontSize=px+"px";
      }
    };
    tb.classList.remove("tight");
    shrink();
    if(tb.scrollWidth>tb.clientWidth+0.5){
      tb.classList.add("tight");
      shrink();
    }
  });
}
// カードの中の「◯/◯(曜)午前中」ボタンを、いまの状態に合わせる(2026-08-11)。
// 期間チップと同じ .mchip だが**期間ではない**ので、点灯は昼の状態だけを見る。
function syncMhiru(){
  const b=document.getElementById("mhiruBtn"); if(!b) return;
  // カードのボタンは**カードの状態**で光らせる(2026-08-14夕)。島図が午前中でも、
  // カードの中で別の期間を選んでいる間は消しておかないと、期間と午前中が
  // 二重に光って「どちらを見ているのか」が読めない。
  const H=window.HIRU, on=cardHiru();
  const j=H&&H.data&&H.data.date;
  const d=new Date();
  b.textContent=(j?hiruDayLabel(j)
    :((d.getMonth()+1)+"/"+d.getDate()+"("+"日月火水木金土"[d.getDay()]+")"))+"午前中";
  b.classList.toggle("is-on",on);
  // その台に午前中の数字が無ければ暗くして押せなくする(2026-08-11・谷川氏指示)。
  // 昼スナップはノーマル機だけを回っているので、AT機など対象外の台では
  // 押しても色も表も変わらない=「押したのに何も起きない」に見えてしまう。
  // button の disabled にするので、押しても click ハンドラ自体が動かない。
  b.disabled=!hiruHasDai(curDai);
}
// その台の午前中の数字があるか。差枚(v)か回数(k)のどちらかがあれば「ある」。
// 差枚だけの台(回数を取れていない機種)でも島図の色と当日の軌跡は見られるため。
function hiruHasDai(dai){
  const D=window.HIRU&&window.HIRU.data;
  if(!D||dai==null) return false;
  const key=String(dai);
  if(D.v&&typeof D.v[key]==="number") return true;
  return !!(D.k&&D.k[key]);
}
// 「8/11(火)」の形にする(2026-08-11・谷川氏指示「○/○(曜日)の午前中」)。
function hiruDayLabel(iso){
  const p=String(iso||"").split("-").map(Number);
  if(p.length<3||!p[0]) return "今日";
  const d=new Date(p[0],p[1]-1,p[2]);
  return p[1]+"/"+p[2]+"("+"日月火水木金土"[d.getDay()]+")";
}

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
  // 「稼働はあるのに差枚が読めない台」の色(2026-08-14夕新設・谷川氏報告
  // 「午前中にデータがあるのになぜ台番が黒くなっている？」)。
  // 真因: 取得元(ダイコク)が12:30時点でその台のスランプグラフをまだ出していない。
  //   大当り一覧(D3300)にはG数が出るので回数だけが取れる。8/14は12台あり、
  //   保存されたグラフ画像は12台とも**線の無い空のグラフ**でバイト単位まで同一だった。
  // データ無(黒)と同じ色にすると「回っていない台」と読み違えるので灰色で区別する。
  // ★差枚そのものは作らない(読めない値を0などで埋めない)。
  const HIRU_NOV="#6E6E6E";
  const hiruRan=dai=>{
    const k=data&&data.k&&data.k[dai];
    return !!(k&&typeof k.g==="number"&&k.g>0);
  };

  let on=false, data=null, titleEl=null, titleWas=null;
  // 出している間は期間そのものを「単日」に切り替える(2026-08-11・谷川氏指示
  // 「今日の午前中を押した時には単日も押された状態にする」)。
  // 最初は印だけを付け替えたが、**カードのグラフ期間が元のまま**になり
  // 「単日が光っているのにグラフは水曜のみ」というちぐはぐが出た(谷川氏の実機で判明)。
  // 中の期間ごと動かし、消したときに元の期間へ戻す。
  let prevPeriod=null, switching=false;
  // applyPeriod は期間データが未取得だと取りに行くので、終わりは
  // 「shimaheat-period」の合図で受ける(同期で終わればその場で流れる)。
  const toSingle=(after)=>{
    if(typeof applyPeriod!=="function"||typeof curPeriod!=="string"||
       curPeriod==="single"){ after(); return; }
    prevPeriod=curPeriod;
    switching=true;
    const done=()=>{
      window.removeEventListener("shimaheat-period",done);
      switching=false; after();
    };
    window.addEventListener("shimaheat-period",done);
    // 期間データが読めなかったときに待ち続けないための保険
    setTimeout(()=>{ if(switching){ switching=false;
      window.removeEventListener("shimaheat-period",done); after(); } },8000);
    applyPeriod("single",false);   // remember=false=谷川氏の既定の期間は書き換えない
  };
  // ボタンの文字(2026-08-11)。期間の並びへ移して幅が画面の1/3になったので、
  // 時刻(「 12:30」)は載せない=「今日の午前中 12:30 ✕」は幅320pxの端末で入らない。
  // 時刻は出している間の見出し(「今日の午前中：8/10(月) 12:30時点 …」)と、
  // 押した直後のトーストに出るので、情報としては失われない。
  // 「8/11(火)の午前中」と日付で出す(2026-08-11・谷川氏指示
  // 「今日の午前中というボタンの表記を○/○(曜日)の午前中に変更」)。
  // 押す前は hiru.json をまだ読んでいないので、端末の今日の日付で書く
  // (押したあとは読み込んだ日付に合わせる=食い違いが起きない)。
  const dayLbl=()=>{
    const j=data&&data.date;
    if(j&&typeof hiruDayLabel==="function") return hiruDayLabel(j);
    const d=new Date();
    return (d.getMonth()+1)+"/"+d.getDate()+"("+"日月火水木金土"[d.getDay()]+")";
  };
  const label=()=>{
    const t=dayLbl()+"午前中"+(on?" ✕":"");
    btn.textContent=t;
    const mb=document.getElementById("mhiruBtn");
    if(mb){ mb.textContent=dayLbl()+"午前中"; mb.classList.toggle("is-on",on); }
  };
  // 島図の上端の見出し(「対象期間：6/9(火)〜8/9(日) 最大62日」)を探す。
  // 資料テーブル側(.tc)にも「対象期間の差枚平均」という別の文言があるので、そちらは除く。
  // **「対象日」も見る**(2026-08-11)。単日・水曜のみの見出しは「対象日：単日 8/8(土)」で、
  // 「対象期間」しか探していなかったため、単日へ切り替えてから昼を出すと
  // 見出しだけ差し替わらなかった(本番の検証が捕まえた)。
  const findTitle=()=>[...document.querySelectorAll("#board [data-k]")]
    .find(e=>!e.classList.contains("tc")&&
             /^(対象期間|対象日)/.test((e.textContent||"").trim()));
  const WD="日月火水木金土";
  const paint=()=>{
    // カード側(paintHiru)が読めるように、いまの状態を置いておく(2026-08-11)
    window.HIRU={on:true,data:data};
    mHiruOff=false;   // 午前中を出し直したらカードの一時切り替えは解く(2026-08-14夕)
    // **期間チップは光らせない**(2026-08-11・谷川氏指示「単日ボタン一緒に押された状態は
    // 無しにして、午前中ボタンだけ押された状態に」)。中の期間は単日のままにしておく
    // =カードのグラフ期間が単日で開くのはそのため。光だけを消す。
    document.querySelectorAll(".pchip").forEach(b=>b.classList.remove("is-on"));
    if(typeof curDai!=="undefined"&&curDai) paintHiru(curDai);
    document.querySelectorAll(".tap[data-dai]").forEach(el=>{
      const v=data.v[el.dataset.dai];
      if(typeof v==="number"){ const i=band(v);
        el.style.backgroundColor=col(i); el.style.color=ink(i); }
      else if(hiruRan(el.dataset.dai)){
        el.style.backgroundColor=HIRU_NOV; el.style.color="#ffffff"; }
      else { el.style.backgroundColor=col(9); el.style.color=ink(9); }
      setCellKitai(el);
    });
    // 見出しも昼の顔にする(2026-08-10・谷川氏指示)。色だけ変えて見出しが
    // 「対象期間：…」のままだと、いつの数字を見ているのか分からなくなる。
    // 元の文字は覚えておいて、消すときに書き戻す(期間の貼り替えに頼らない)。
    titleEl=titleEl||findTitle();
    if(titleEl){
      if(titleWas===null) titleWas=titleEl.innerHTML;
      const p=String(data.date).split("-").map(Number);
      const d=new Date(p[0],p[1]-1,p[2]);
      titleEl.textContent=p[1]+"/"+p[2]+"("+WD[d.getDay()]+")午前中 "
        +data.at+"時点 "+(data.kind==="all"?"全機種":"ノーマル機")+data.n+"台";
    }
    // 上端の常時ステータスも昼の顔にする(2026-08-22)。ここで呼ばないと、
    // 期間を切り替えるまで上端だけ元の対象期間のままになる。
    if(typeof paintTopStat==="function") paintTopStat();
  };
  const titleBack=()=>{
    if(titleEl&&titleWas!==null){ titleEl.innerHTML=titleWas; titleWas=null; }
    if(typeof paintTopStat==="function") paintTopStat();
  };
  // 台番セルの推定設定を元(対象期間の丸数字)に戻す。期間の貼り替えでも描き直されるが、
  // 貼り替えが走らない経路(もう一度押して消すだけ)があるのでここでも戻す。
  const cellsBack=()=>document.querySelectorAll(".tap[data-dai]").forEach(clearCellKitai);
  const off=()=>{
    on=false; btn.classList.remove("is-on"); label();
    window.HIRU={on:false,data:data}; mHiruOff=false;
    if(typeof curDai!=="undefined"&&curDai) paintHiru(curDai);
    titleBack(); cellsBack();
    // 押す前の期間へ戻す(単日へ動かしていた場合)。戻す先が無ければいまの期間を引き直す。
    // どちらも「自前で元の色を覚えておく」より確実(貼り替えでまるごと描き直すため)。
    const back=prevPeriod; prevPeriod=null;
    if(typeof applyPeriod==="function") applyPeriod(back||curPeriod,false);
    else if(typeof restoreBase==="function") restoreBase();
  };
  // 期間を切り替えたら昼の色は消える(貼り替えで上書きされる)ので、印も戻しておく。
  // 見出しは貼り替えの対象でないことがあるので、こちらでも明示的に書き戻す。
  window.addEventListener("shimaheat-period",()=>{
    // 自分で単日へ動かしている最中の合図は、消す合図として扱わない。
    if(switching) return;
    if(on){ on=false; btn.classList.remove("is-on"); label();
            window.HIRU={on:false,data:data}; mHiruOff=false;
            if(typeof curDai!=="undefined"&&curDai) paintHiru(curDai);
            cellsBack();
            titleWas=null; titleEl=null;     // 貼り替え後の文字が正しいので覚え直す
            // 谷川氏が自分で期間を選んだので、戻す先は捨てる。
            prevPeriod=null; }
  });
  btn.addEventListener("click",()=>{
    if(on){ off(); return; }
    if(data){ toSingle(()=>{ on=true; btn.classList.add("is-on"); label(); paint(); });
              return; }
    btn.classList.add("loading");
    // ★読むのは ensureHiruData に一本化した(2026-08-18)。以前はここで別に
    //   fetch していたので、起動時に読んだ分と合わせて2回落としていた。
    //   日付が今日かどうかの照合も向こうに入っている。
    ensureHiruData().then(j=>{
      btn.classList.remove("loading");
      if(!j){
        showToast("今日の午前中の分はまだありません",2600); return;
      }
      data=j;
      toSingle(()=>{
        on=true; btn.classList.add("is-on"); label();
        paint();
        showToast((j.kind==="all"?"全機種":"ノーマル機")+" "+j.n+"台 / "+j.at+" 時点",2600);
      });
    }).catch(()=>{
      btn.classList.remove("loading");
      showToast("今日の午前中の分はまだありません",2600);
    });
  });
})();
