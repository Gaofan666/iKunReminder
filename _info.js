const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
const APP = __dirname; require(path.join(APP, 'main.js'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let win = null;
app.on('browser-window-created', (e, w) => { try { if (w.getTitle() === 'pet-bubble') return; } catch (x) { } if (!win) win = w; });
const log = [];

const INFO = "(function(){var c=document.getElementById('stage');var x=c.getContext('2d');" +
  "var w=c.width,h=c.height,d=x.getImageData(0,0,w,h).data;" +
  "var y0=h,y1=-1,x0=w,x1=-1;" +
  "for(var y=0;y<h;y++){for(var xx=0;xx<w;xx++){if(d[(y*w+xx)*4+3]>10){" +
  "if(y<y0)y0=y;if(y>y1)y1=y;if(xx<x0)x0=xx;if(xx>x1)x1=xx;}}}" +
  "var cs=getComputedStyle(c);" +
  "return JSON.stringify({bw:w,bh:h,cssW:cs.width,cssH:cs.height," +
  "dpr:window.devicePixelRatio,top:y0,bot:y1,left:x0,right:x1});})()";

app.whenReady().then(async () => {
  for (let i = 0; i < 200 && !win; i++) await sleep(50);
  const wc = win.webContents;
  if (wc.isLoading()) await new Promise(r => wc.once('did-finish-load', r));
  await sleep(2600);
  const js = (c) => wc.executeJavaScript(c);

  log.push('=== 主界面 ===');
  log.push('  ' + (await js(INFO)));

  const before = win.getBounds();
  await js("document.getElementById('btnPet').click(); true;");
  await sleep(1600);
  const after = win.getBounds();
  log.push('');
  log.push('=== 切到宠物模式后 ===');
  log.push('  窗口尺寸 主界面 ' + before.width + 'x' + before.height +
    '  ->  宠物 ' + after.width + 'x' + after.height);
  log.push('  ' + (await js(INFO)));
  log.push('');
  log.push('  说明：bot 如果等于 bh-1，说明内容被画布底边裁掉了');
  fs.writeFileSync(path.join(APP, '_info.txt'), log.join('\n'), 'utf8');
  app.exit(0);
});
setTimeout(() => { fs.writeFileSync(path.join(APP, '_info.txt'), log.join('\n') + '\n!! 超时', 'utf8'); app.exit(1); }, 90000);
