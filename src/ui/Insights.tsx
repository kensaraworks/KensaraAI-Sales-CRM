import { useState } from 'preact/hooks';
import { useStore } from '../lib/store';
import { CONNECTED } from '../lib/outcomes';
import { funnel, leaderboard, lostReasons, metrics, onTimePct, pipeline, series, level, type Metrics } from '../lib/stats';
import { buildQueue } from '../lib/schedule';
import { DAY, startOfDay, startOfWeek } from '../lib/util';
import { Avatar, Icon, Seg } from './components';
import { HBars, Heatmap, StackCols } from './charts';

type Range = 'today' | 'week' | '30' | 'all';

export function Insights() {
  const s = useStore();
  const [range, setRange] = useState<Range>('week');
  const [who, setWho] = useState<string>('');
  const acts = s.acts();
  const now = new Date();
  const from = range === 'today' ? startOfDay(now) : range === 'week' ? startOfWeek(now) : range === '30' ? new Date(startOfDay(now).getTime() - 29 * DAY) : new Date(0);
  const to = new Date(now.getTime() + DAY);
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - (range === 'today' ? DAY : range === 'week' ? 7 * DAY : range === '30' ? 30 * DAY : 0));
  const m = metrics(acts, from, to, who || null);
  const p = range === 'all' ? null : metrics(acts, prevFrom, range === 'week' ? new Date(prevFrom.getTime() + (now.getTime() - from.getTime())) : from, who || null);
  const days = range === 'today' ? 14 : range === 'week' ? 14 : range === '30' ? 30 : Math.min(90, Math.max(14, Math.ceil(span / DAY)));
  const ser = series(acts, range === 'all' ? Math.min(90, days) : days, who || null);
  const accounts = s.accounts();
  const fun = funnel(accounts, acts);
  const pipe = pipeline(accounts);
  const lost = lostReasons(accounts);
  const lb = leaderboard(acts, s.team, from, to);
  const overdue = s.sel(`overdue:${who}`, () => {
    const q = buildQueue({ accounts, contacts: s.contactsBy(), acts, settings: s.settings, team: s.team, me: who || s.me!.id, model: s.model(), everyone: !who });
    return q.backlog;
  });

  const label = range === 'today' ? 'yesterday' : range === 'week' ? 'last week (same days)' : 'previous 30 days';
  const kpis: [string, keyof Metrics | 'rate' | 'ontime', string?][] = [
    ['Calls made', 'dials'], ['Conversations', 'connects'], ['Connect rate', 'rate', '%'], ['Decision makers reached', 'dm'],
    ['Details shared', 'shared'], ['Discovery calls booked', 'discovery'], ['Won', 'won'], ['Follow-ups on time', 'ontime', '%'],
  ];
  const val = (x: Metrics, k: string) => (k === 'rate' ? (x.dials ? Math.round((x.connects / x.dials) * 100) : 0) : k === 'ontime' ? onTimePct(x) : (x as any)[k]);

  // Pick-up heatmap from raw call outcomes (Mon–Sat, 10 AM–7 PM).
  const H0 = 10, H1 = 19;
  const grid = Array.from({ length: 7 }, () => Array.from({ length: H1 - H0 }, () => ({ t: 0, c: 0 })));
  for (const a of acts) {
    if (a.channel !== 'call' || !a.outcome || a.outcome === 'note' || (who && a.createdBy !== who)) continue;
    const d = new Date(a.at), h = d.getHours();
    if (h < H0 || h >= H1) continue;
    const cell = grid[d.getDay()][h - H0];
    cell.t++;
    if (CONNECTED.has(a.outcome)) cell.c++;
  }
  const wds = [1, 2, 3, 4, 5, 6];
  const wdName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hourName = (h: number) => (h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`);

  return (
    <div>
      <div class="page-head">
        <div><h1>Insights</h1><p class="muted small">How the team is doing — updated live</p></div>
        <div class="row right wrap">
          <select class="select" style={{ width: 'auto', height: '34px' }} value={who} onChange={(e) => setWho((e.target as HTMLSelectElement).value)}>
            <option value="">Whole team</option>
            {s.team.filter((x) => x.active).map((x) => <option value={x.id}>{x.id === s.me?.id ? `${x.name} (me)` : x.name}</option>)}
          </select>
          <Seg value={range} options={[['today', 'Today'], ['week', 'This week'], ['30', '30 days'], ['all', 'All time']]} onChange={setRange} />
        </div>
      </div>

      <div class="kpis">
        {kpis.map(([l, k, unit]) => {
          const v = val(m, k);
          const pv = p ? val(p, k) : null;
          const d = pv == null ? null : v - pv;
          return (
            <div class="kpi">
              <div class="kpi__l">{l}</div>
              <div class="kpi__v">{v}{unit || ''}</div>
              {d != null && (pv! > 0 || v > 0) && <div class="kpi__d" style={{ color: d > 0 ? 'var(--good)' : d < 0 ? 'var(--bad)' : 'var(--muted)' }}>{d > 0 ? '▲' : d < 0 ? '▼' : '•'} {Math.abs(d)}{unit || ''} <span class="muted">vs {label}</span></div>}
            </div>
          );
        })}
      </div>

      <div class="charts">
        <div class="chart-card wide">
          <h3>Daily activity</h3>
          <p class="sub">Calls per day, split by whether someone picked up · last {ser.length} days</p>
          <StackCols
            data={ser.map((d) => ({ label: d.day.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }), sub: d.day.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), a: d.m.connects, b: Math.max(0, d.m.dials - d.m.connects) }))}
            a={{ name: 'Conversations', color: 'var(--series-1)' }} b={{ name: 'No answer / busy', color: 'var(--series-2)' }} />
        </div>

        <div class="chart-card">
          <h3>Funnel</h3>
          <p class="sub">Companies that reached each stage (all time) · % = carried on from the stage above</p>
          <HBars rows={fun.map((f, i) => ({ label: f.stage.label, value: f.count, note: i ? `${fun[i - 1].count ? Math.round((f.count / fun[i - 1].count) * 100) : 0}%` : undefined }))} />
        </div>

        <div class="chart-card">
          <h3>Best time to call</h3>
          <p class="sub">Share of calls that got through, by weekday and hour</p>
          <Heatmap rows={wds.map((d) => wdName[d])} cols={Array.from({ length: H1 - H0 }, (_, i) => hourName(H0 + i))}
            value={(r, c) => { const x = grid[wds[r]][c]; return { v: x.t ? x.c / x.t : 0, n: x.t }; }}
            label={(r, c, v, n) => n ? `${wdName[wds[r]]} ${hourName(H0 + c)}: ${Math.round(v * 100)}% picked up (${n} calls)` : `${wdName[wds[r]]} ${hourName(H0 + c)}: no calls yet`} />
        </div>

        {s.settings.fun.leaderboard && !who && (
          <div class="chart-card">
            <h3>Leaderboard</h3>
            <p class="sub">Points {range === 'today' ? 'today' : range === 'week' ? 'this week' : range === '30' ? 'in 30 days' : 'all time'} — calls, conversations, follow-ups on time, meetings</p>
            <div class="lb">
              {lb.map((r, i) => {
                const max = Math.max(1, lb[0]?.m.points || 1);
                return (
                  <div class={`lb__row ${r.member.id === s.me?.id ? 'is-me' : ''}`}>
                    <span class="num muted">{i === 0 && r.m.points ? '🏆' : i + 1}</span>
                    <span class="row"><Avatar id={r.member.id} name={r.member.name} size="sm" /><b class="small">{r.member.name}</b></span>
                    <span class="lb__bar"><i style={{ width: `${(r.m.points / max) * 100}%` }} /></span>
                    <span class="small num"><b>{r.m.points}</b> <span class="muted tiny">Lv {level(acts.filter((a) => a.createdBy === r.member.id).reduce((n, a) => n + (a.points || 0), 0)).n}</span></span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div class="chart-card">
          <h3>Pipeline right now</h3>
          <p class="sub">Open and parked companies by stage</p>
          <HBars rows={pipe.map((x) => ({ label: x.stage.label, value: x.count }))} />
        </div>

        <div class="chart-card">
          <h3>Follow-up discipline</h3>
          <p class="sub">Promises kept are deals kept</p>
          <div class="row" style={{ gap: '28px', alignItems: 'flex-end' }}>
            <div><div class="kpi__v" style={{ fontSize: '40px' }}>{onTimePct(m)}%</div><div class="small muted">on time · {m.onTime} of {m.planned}</div></div>
            <div><div class="kpi__v" style={{ color: overdue ? 'var(--bad)' : undefined }}>{overdue}</div><div class="small muted"><Icon n="clock" size={13} /> overdue now</div></div>
          </div>
        </div>

        <div class="chart-card">
          <h3>Why deals closed</h3>
          <p class="sub">Reasons given for a clear no (all time)</p>
          <HBars rows={lost.map(([l, v]) => ({ label: l, value: v }))} color="var(--series-2)" />
        </div>

        <div class="chart-card wide">
          <h3>By person</h3>
          <p class="sub">Same period as above</p>
          <div class="table-wrap" style={{ border: 0 }}>
            <table class="t">
              <thead><tr><th>Person</th><th>Calls</th><th>Conversations</th><th>Decision makers</th><th>Shared</th><th>Discovery</th><th>Won</th><th>On time</th><th>Points</th></tr></thead>
              <tbody>
                {lb.map((r) => (
                  <tr style={{ cursor: 'default' }}>
                    <td><span class="row"><Avatar id={r.member.id} name={r.member.name} size="sm" />{r.member.name}</span></td>
                    <td class="num">{r.m.dials}</td><td class="num">{r.m.connects}</td><td class="num">{r.m.dm}</td><td class="num">{r.m.shared}</td>
                    <td class="num">{r.m.discovery}</td><td class="num">{r.m.won}</td><td class="num">{onTimePct(r.m)}%</td><td class="num"><b>{r.m.points}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
