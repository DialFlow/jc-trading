// TJR video pipeline: stream recordings → timestamped transcripts → candidate trade moments, for the private TJR Trade Log.
// Needs (free, installed separately): yt-dlp, ffmpeg, and whisper.cpp (whisper-cli + a ggml model) for videos without captions.
// Nothing here is published: everything is written under the trade log folder (outside the website repo).
//
//   node scripts/tjr-videos.mjs list <channel or playlist url> <logDir>     list videos/streams with dates → <logDir>/videos.csv
//   node scripts/tjr-videos.mjs captions <video url> <logDir>               YouTube captions → transcripts/<date>_<id>.txt
//   node scripts/tjr-videos.mjs whisper <video url> <logDir> <model.bin>    audio → whisper.cpp → transcripts/<date>_<id>.txt
//   node scripts/tjr-videos.mjs moments <transcript.txt> [--minute-data <dir>]  trade-language moments, with ET clock time if
//                                                                         the stream start is known, checked against 1m prices
//
// Transcript format: one line per caption, "[video hh:mm:ss | ET hh:mm:ss] text" (ET only when the video is a live
// stream with a known start time). The ET clock is what lets each trade be logged to the minute and checked against
// the 1-minute candles.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';

const [cmd, a1, a2, a3] = process.argv.slice(2);
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const hms = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const etClock = t => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York' });
const etDate = t => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function meta(url) {
  const j = JSON.parse(run('yt-dlp', ['-J', '--no-warnings', '--skip-download', url]));
  // a live stream's start: release_timestamp (YouTube/Kick live) is when it went live; else the upload time (not reliable)
  const start = j.release_timestamp || null;
  return { id: j.id, title: j.title, duration: j.duration, start, date: start ? etDate(start) : (j.upload_date ? `${j.upload_date.slice(0, 4)}-${j.upload_date.slice(4, 6)}-${j.upload_date.slice(6)}` : 'unknown'), live: !!(j.was_live || j.live_status === 'was_live'), url };
}
const line = (m, sec, text) => `[video ${hms(sec)}${m.start ? ` | ET ${etClock(m.start + sec)}` : ''}] ${text.replace(/\s+/g, ' ').trim()}`;
const header = m => `# ${m.title}\n# ${m.url}\n# date ${m.date} · ${m.live ? `live stream, started ${m.start ? etClock(m.start) + ' ET' : 'unknown'}` : 'not a live stream: ET times unknown'} · ${hms(m.duration || 0)}\n`;

if (cmd === 'list') {
  const j = JSON.parse(run('yt-dlp', ['-J', '--flat-playlist', '--no-warnings', a1]));
  const rows = (j.entries || []).map(e => [e.id, `"${(e.title || '').replace(/"/g, "'")}"`, e.duration || '', e.url || `https://www.youtube.com/watch?v=${e.id}`]);
  mkdirSync(a2, { recursive: true });
  writeFileSync(join(a2, 'videos.csv'), 'id,title,duration_s,url\n' + rows.map(r => r.join(',')).join('\n') + '\n');
  console.log(`${rows.length} videos → ${join(a2, 'videos.csv')} (dates are filled in when each video is processed)`);
} else if (cmd === 'captions') {
  const m = meta(a1), tmp = join(a2, 'transcripts', '_tmp'); mkdirSync(tmp, { recursive: true });
  run('yt-dlp', ['--skip-download', '--write-auto-subs', '--write-subs', '--sub-langs', 'en.*', '--sub-format', 'json3', '-o', join(tmp, '%(id)s.%(ext)s'), a1]);
  const f = readdirSync(tmp).find(x => x.startsWith(m.id) && x.endsWith('.json3'));
  if (!f) { console.log('no captions on this video: use the whisper command'); process.exit(2); }
  const ev = JSON.parse(readFileSync(join(tmp, f), 'utf8')).events || [], out = [];
  for (const e of ev) { const text = (e.segs || []).map(s => s.utf8).join(''); if (text.trim()) out.push(line(m, (e.tStartMs || 0) / 1000, text)); }
  const file = join(a2, 'transcripts', `${m.date}_${m.id}.txt`); writeFileSync(file, header(m) + out.join('\n') + '\n'); rmSync(tmp, { recursive: true, force: true });
  console.log(`${out.length} caption lines → ${file}`);
} else if (cmd === 'whisper') {
  const m = meta(a1), tmp = join(a2, 'transcripts', '_tmp'); mkdirSync(tmp, { recursive: true });
  const wav = join(tmp, `${m.id}.wav`);
  run('yt-dlp', ['-x', '--audio-format', 'wav', '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1', '-o', join(tmp, '%(id)s.%(ext)s'), a1]);
  run('whisper-cli', ['-m', a3, '-f', wav, '-l', 'en', '-oj', '-of', join(tmp, m.id)]);
  const segs = JSON.parse(readFileSync(join(tmp, `${m.id}.json`), 'utf8')).transcription || [];
  const out = segs.map(s => line(m, (s.offsets?.from || 0) / 1000, s.text));
  const file = join(a2, 'transcripts', `${m.date}_${m.id}.txt`); writeFileSync(file, header(m) + out.join('\n') + '\n'); rmSync(tmp, { recursive: true, force: true });
  console.log(`${out.length} segments → ${file}`);
} else if (cmd === 'moments') {
  // trade language worth a look; each hit is a candidate, confirmed by reading the lines around it (and the chart)
  const RX = /\b(long|short|buy|sell|entered|entry|in at|filled|stop(?:ped)?(?: out| loss)?|take profit|tp ?[12]|partial|break ?even|target|out of|closed|cut it|no trade|sitting out|not trading)\b/i;
  const PRICE = /\b(\d{1,2},?\d{3}(?:\.\d{1,2})?)\b/g;
  const txt = readFileSync(a1, 'utf8').split('\n'), hits = [];
  txt.forEach((l, i) => { if (!l.startsWith('[') || !RX.test(l)) return; hits.push({ i, l, prices: [...l.matchAll(PRICE)].map(x => x[1]) }); });
  console.log(`${hits.length} candidate moments in ${basename(a1)} (read ±3 lines around each before logging a trade):\n`);
  for (const h of hits) console.log(`${h.l}${h.prices.length ? `   ← prices said: ${h.prices.join(', ')}` : ''}`);
} else {
  console.log('commands: list | captions | whisper | moments (see the top of this file)');
}
