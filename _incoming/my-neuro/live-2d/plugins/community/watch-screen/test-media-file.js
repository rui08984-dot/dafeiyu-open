// test-media-file.js —— media-file 纯函数验证（不依赖真视频/ffprobe）
const media = require('./media-file.js');

function test_parseTitle() {
  const cases = [
    ['我的三体.mkv - PotPlayer 64bit', 'PotPlayer', '我的三体.mkv'],
    ['D:\\Movies\\流浪地球2.mp4 - PotPlayer', 'PotPlayer', '流浪地球2.mp4'],
    [' attack on titan s01e01.mkv - MPC-BE ', 'MPC', 'attack on titan s01e01.mkv'],
    ['SomeShow.S01E05.webm - VLC media player', 'VLC', 'SomeShow.S01E05.webm'],
    ['离职拿到赔偿金之后.m2ts', 'generic', '离职拿到赔偿金之后.m2ts'],
    ['英雄联盟（Riot Client）', null, null],
    ['文档1 - 记事本', null, null],
  ];
  let pass = 0;
  for (const [title, player, name] of cases) {
    const r = media.parsePlayerTitle(title);
    const ok = (player === null) ? r === null : (r && r.player === player && r.name === name);
    if (ok) pass++;
    console.log((ok ? 'PASS' : 'FAIL') + ` "${title}" → ${r ? r.player + '/' + r.name : 'null'}`);
  }
  console.log(`parsePlayerTitle ${pass}/${cases.length}`);
}

function test_parseSrt_and_locate() {
  const srt = [
    '1', '00:01:02,000 --> 00:01:04,500', '归乡的路上，风很大。', '',
    '2', '00:31:10,120 --> 00:31:13,000', '我不吃香菜，说过多少遍了', '',
    '3', '00:58:03,000 --> 00:58:06,200', '一切都结束了。', '',
  ].join('\n');
  const lines = media.parseSrt(srt);
  if (lines.length !== 3) { console.log('FAIL parseSrt 行数', lines.length); return; }
  if (lines[1].start !== ((31 * 60 + 10) * 1000 + 120)) { console.log('FAIL 时间解析', lines[1].start); return; }

  // ASR 把「我不吃香菜」听成「我不吃香菜了」也能反查到位置
  const pos = media.locatePlayback('我不吃香菜，说了多少遍了啊', lines);
  if (!pos || pos.index !== 1) { console.log('FAIL locatePlayback', JSON.stringify(pos)); return; }
  const around = media.around(lines, pos);
  if (!around || !around.includes('[31:10]') || !around.includes('归乡')) { console.log('FAIL around', around); return; }
  console.log('PASS parseSrt+locatePlayback+around（模糊匹配 + 位置邻域）');
}

function test_findFile(tmp) {
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mf-'));
  fs.writeFileSync(path.join(dir, '测试影片.mkv'), 'x');
  const hit = media.findFile('测试影片.mkv', [dir]);
  const miss = media.findFile('不存在的.mkv', [dir]);
  const ok = hit === path.join(dir, '测试影片.mkv') && miss === null;
  console.log((ok ? 'PASS' : 'FAIL') + ' findFile');
  fs.rmSync(dir, { recursive: true, force: true });
}

test_parseTitle();
test_parseSrt_and_locate();
test_findFile();
console.log('DONE');
